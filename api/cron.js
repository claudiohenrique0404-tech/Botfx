// ===== IMPORTS =====
const STRAT = require('./strategies');
const { saveTrade, saveEquity, setTradePnL } = require('./db');
const BRAIN = require('./brain');
const bitgetHandler = require('./bitget');
const redis = require('./redis');
const { getMinQty } = require('./contracts');

const fetch = global.fetch || require('node-fetch');

// ===== TRAIL_STATE persistence =====
async function persistTrailState() {
  if (!redis) return;
  try { await redis.set('botfx:trail', TRAIL_STATE); } catch {}
}

async function loadTrailState() {
  if (!redis) return;
  try {
    const saved = await redis.get('botfx:trail');
    if (saved && typeof saved === 'object') {
      Object.assign(TRAIL_STATE, saved);
      console.log('📦 TRAIL_STATE carregado:', Object.keys(saved).length, 'símbolos');
    }
  } catch {}
}

// ===== STATE =====
if (!global.LOGS) global.LOGS = [];
let LOGS = global.LOGS;

let START_EQUITY = null;
const MAX_DAILY_LOSS = -6; // %
const TRAIL_STATE = {};
let PREV_POSITIONS = [];

// ===== LOGGER =====
function log(msg) {
  const t = new Date().toLocaleTimeString('pt-PT', { hour12: false, timeZone: 'Europe/Lisbon' });
  const e = `[${t}] ${msg}`;
  console.log(e);
  LOGS.unshift(e);
  if (LOGS.length > 200) LOGS.pop();
}

// ===== CONSENSO (6 bots + regime) =====
function analyzeBots(candles, candles5m) {
  const closes = typeof candles[0] === 'number'
    ? candles
    : candles.map(c => Array.isArray(c) ? parseFloat(c[4]) : parseFloat(c.c || 0)).filter(Boolean);

  const closes5mForRegime = candles5m && candles5m.length >= 20
    ? (typeof candles5m[0] === 'number' ? candles5m
       : candles5m.map(c => Array.isArray(c) ? parseFloat(c[4]) : parseFloat(c.c || 0)).filter(Boolean))
    : closes;
  const regime = STRAT.detectRegime(closes5mForRegime);

  const rawSignals = {
    trend:      STRAT.trendBot(closes),
    rsi:        STRAT.rsiBot(closes),
    momentum:   STRAT.momentumBot(closes),
    breakout:   STRAT.breakoutBot(candles),
    volume:     STRAT.volumeBot(candles),
    volatility: STRAT.volatilityBot(closes),
  };

  const signals = STRAT.filterByRegime(rawSignals, regime);
  const weights = BRAIN.getWeights();
  let buy = 0, sell = 0, used = [];

  for (const k in signals) {
    const s = signals[k];
    if (!s) continue;
    const w = weights[k] || 0.5;
    if (s.side === 'BUY')  buy  += s.confidence * w;
    if (s.side === 'SELL') sell += s.confidence * w;
    used.push(k);
  }

  log(`🌍 ${regime} | 🗳️ BUY:${buy.toFixed(2)} SELL:${sell.toFixed(2)} [${used.join(',')||'—'}]`);

  if (used.length < 2) return null;

  const diff = Math.abs(buy - sell);
  const minConf = regime === 'VOLATILE' ? 0.65 : 0.60;

  if (buy  > sell && buy  > minConf && diff > 0.15) return { side: 'BUY',  bots: used, buy, sell, regime };
  if (sell > buy  && sell > minConf && diff > 0.15) return { side: 'SELL', bots: used, buy, sell, regime };

  return null;
}

// ===== API HELPER =====
function callApi(base, body) {
  const timeout = body.action === 'order' ? 30000 : 12000;
  return new Promise((resolve) => {
    const req = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    req.body = body;
    const res = {
      _status: 200,
      status(code) { this._status = code; return this; },
      json(data) { resolve(data); },
    };
    const timer = setTimeout(() => {
      console.log(`callApi timeout [${body.action}] ${timeout/1000}s`);
      resolve(null);
    }, timeout);
    Promise.resolve(bitgetHandler(req, res))
      .then(() => clearTimeout(timer))
      .catch(e => { clearTimeout(timer); resolve(null); });
  });
}

// ===== MAIN BOT =====
module.exports = async function runBot() {
  try {
    global.lastBotRun = Date.now();
    const base = process.env.BASE_URL;

    if (!global._trailLoaded) {
      await loadTrailState();
      global._trailLoaded = true;
      log('🔧 SWING MODE | 5m + 15m | SL:0.6% TP:dinâmico | MinConf:0.60 Diff:0.15');
    }

    const settings = global.BOT_SETTINGS || { active: true, lev: 5, symbols: [
      'XRPUSDT','BNBUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','ATOMUSDT'
    ]};
    if (!settings.active) { log('⏸ BOT OFF'); return; }

    // ── Balance ──
    const balanceData = await callApi(base, { action: 'balance' });
    if (!balanceData?.[0]) { log('❌ balance'); return; }

    const equity    = parseFloat(balanceData[0].equity    || 0);
    const available = parseFloat(balanceData[0].available  || 0);
    if (equity <= 0) { log('❌ equity'); return; }

    if (!START_EQUITY) START_EQUITY = equity;
    const pnlDay = ((equity - START_EQUITY) / START_EQUITY) * 100;
    log(`💰 eq:${equity.toFixed(2)} avail:${available.toFixed(2)} | Day: ${pnlDay.toFixed(2)}%`);

    if (pnlDay <= MAX_DAILY_LOSS) { log('🛑 KILL SWITCH'); return; }

    // ── Posições ──
    const positions = await callApi(base, { action: 'positions' });
    if (!Array.isArray(positions)) { log('❌ positions'); return; }

    // ── Gerir posições existentes ──
    for (const pos of positions) {
      const symbol   = pos.symbol;
      const holdSide = pos.holdSide;
      const entry    = parseFloat(pos.openPriceAvg || 0);
      const current  = parseFloat(pos.markPrice || 0);
      const size     = parseFloat(pos.total || 0);
      if (!entry || !current || !size || !holdSide) continue;

      const pnl = holdSide === 'long'
        ? ((current - entry) / entry) * 100
        : ((entry - current) / entry) * 100;

      if (!TRAIL_STATE[symbol]) TRAIL_STATE[symbol] = {};
      if (TRAIL_STATE[symbol].maxPnl === undefined) TRAIL_STATE[symbol].maxPnl = pnl;
      if (!TRAIL_STATE[symbol].openTime) TRAIL_STATE[symbol].openTime = parseInt(pos.cTime || Date.now());
      if (pnl > TRAIL_STATE[symbol].maxPnl) TRAIL_STATE[symbol].maxPnl = pnl;

      // Partial TP: 50% @ +0.6%
      if (pnl >= 0.6 && !TRAIL_STATE[symbol].partialDone) {
        TRAIL_STATE[symbol].partialDone = true;
        const halfSize = (size / 2).toFixed(4);
        try {
          await callApi(base, { action: 'partialClose', symbol, holdSide, quantity: halfSize });
          log(`💰 PARTIAL TP ${symbol} 50% @ +${pnl.toFixed(2)}%`);
        } catch(e) {
          TRAIL_STATE[symbol].partialDone = false;
        }
        await new Promise(r => setTimeout(r, 300));
      }

      // Breakeven @ +0.3%
      if (pnl >= 0.3 && !TRAIL_STATE[symbol].beSet) {
        TRAIL_STATE[symbol].beSet = true;
        const beBuf = entry * 0.001;
        const bePrice = holdSide === 'long' ? entry + beBuf : entry - beBuf;
        try {
          const plans = await callApi(base, { action: 'getPlanOrders', symbol, holdSide });
          const slOrder = (plans?.data?.entrustedList || []).find(o => o.planType === 'loss_plan');
          if (slOrder?.orderId) {
            await callApi(base, { action: 'cancelPlan', symbol, orderId: slOrder.orderId });
            await new Promise(r => setTimeout(r, 200));
          }
          await callApi(base, { action: 'placeTpsl', symbol, holdSide, planType: 'loss_plan', triggerPrice: bePrice, size, productType: 'USDT-FUTURES' });
          log(`🔒 BE ${symbol} SL→${bePrice.toFixed(6)}`);
        } catch(e) { log(`⚠️ BE falhou: ${e.message}`); }
      }

      const maxPnl   = TRAIL_STATE[symbol].maxPnl;
      const timeOpen = Date.now() - (TRAIL_STATE[symbol].openTime || Date.now());
      const exitReason = STRAT.exitBot(pnl, timeOpen, maxPnl);

      log(`📊 ${symbol} ${holdSide} PnL:${pnl.toFixed(2)}% max:${maxPnl.toFixed(2)}% t:${Math.round(timeOpen/60000)}min`);

      let shouldClose = false;
      let closeReason = '';

      if (pnl <= -0.5) { shouldClose = true; closeReason = `SL hard ${pnl.toFixed(2)}%`; }
      else if (exitReason === 'TRAIL') { shouldClose = true; closeReason = `TRAIL (${maxPnl.toFixed(2)}%→${pnl.toFixed(2)}%)`; }
      else if (exitReason === 'TIME') { shouldClose = true; closeReason = `TIME STOP`; }
      else if (exitReason === 'TIME_WEAK') { shouldClose = true; closeReason = `TRADE FRACA`; }

      if (shouldClose) {
        await callApi(base, { action: 'close', symbol, holdSide });
        log(pnl > 0 ? `✅ ${closeReason} ${symbol}` : `🛑 ${closeReason} ${symbol}`);
        delete TRAIL_STATE[symbol];
        await persistTrailState();
        const trade = setTradePnL(symbol, pnl);
        if (trade?.bots) { for (const b of trade.bots) BRAIN.updateBot(b, pnl); }
      }
    }

    // ── Fechos externos ──
    for (const prevPos of PREV_POSITIONS) {
      const stillOpen = positions.find(p => p.symbol === prevPos.symbol && p.holdSide === prevPos.holdSide);
      if (!stillOpen) {
        const entry = parseFloat(prevPos.openPriceAvg || 0);
        const isLong = prevPos.holdSide === 'long';
        const achieved = parseFloat(prevPos.achievedProfits || 0);
        const margin = parseFloat(prevPos.marginSize || 0);
        let pnl = 0;
        if (achieved !== 0 && margin > 0) pnl = (achieved / margin) * 100;
        else { const mark = parseFloat(prevPos.markPrice || entry); pnl = entry > 0 ? ((isLong ? mark - entry : entry - mark) / entry * 100) : 0; }

        log(`📕 ${prevPos.symbol} fechado externamente PnL:${pnl.toFixed(2)}%`);
        const trade = setTradePnL(prevPos.symbol, pnl);
        const bots = trade?.bots || TRAIL_STATE[prevPos.symbol]?.bots;
        if (bots?.length) { for (const b of bots) BRAIN.updateBot(b, pnl); }
        delete TRAIL_STATE[prevPos.symbol];
        await saveEquity(equity);
      }
    }
    PREV_POSITIONS = positions.slice();

    // ── Novos sinais ──
    const MAX_POSITIONS = 2;
    if (positions.length >= MAX_POSITIONS) {
      log(`⏸ ${positions.length}/${MAX_POSITIONS} — aguardar`);
      return;
    }

    const openSymbols = positions.map(p => p.symbol);
    const openSides   = positions.map(p => p.holdSide);

    for (const sym of settings.symbols) {
      if (openSymbols.includes(sym)) continue;

      const symState = TRAIL_STATE[sym];
      if (symState?.lastOpen && Date.now() - symState.lastOpen < 120000) {
        log(`⏳ ${sym} cooldown`);
        continue;
      }

      log(`🔍 ${sym}`);

      const [r5m, r15m] = await Promise.allSettled([
        callApi(base, { action: 'candles', symbol: sym, tf: '5m' }),
        callApi(base, { action: 'candles', symbol: sym, tf: '15m' }),
      ]);
      const candles5m  = r5m.status  === 'fulfilled' ? r5m.value  : null;
      const candles15m = r15m.status === 'fulfilled' ? r15m.value : null;

      if (!candles5m?.length) { log('⚠️ sem candles'); continue; }

      const closes = candles5m.map(c => typeof c === 'object' && !Array.isArray(c) ? c.c : +c[4]).filter(v => v && !isNaN(v));
      if (closes.length < 50) continue;

      const price = closes.at(-1);
      if (!price || price <= 0) continue;

      if (!STRAT.marketFilter(closes)) { log('😴 mercado parado'); continue; }

      const decision = analyzeBots(candles5m, candles15m);
      if (!decision) { log('❌ sem consenso'); continue; }

      // Correlação
      const decSide = decision.side === 'BUY' ? 'long' : 'short';
      const topScore = decision.side === 'BUY' ? decision.buy : decision.sell;
      if (positions.length > 0 && openSides.every(s => s === decSide) && !(topScore > 0.85 && decision.bots.length >= 3)) {
        log(`⚠️ ${sym} correlação`);
        continue;
      }

      // Filtros 15m
      const regime15m = decision.regime || 'RANGE';
      if (regime15m === 'VOLATILE' && Math.abs(decision.buy - decision.sell) < 0.25) { log('🚫 VOLATILE fraco'); continue; }

      if (candles15m?.length >= 50) {
        const closes15m = candles15m.map(c => typeof c === 'object' && !Array.isArray(c) ? c.c : +c[4]);
        const ctx = STRAT.contextFilter(closes15m);
        if (ctx !== 'NEUTRAL' && ctx !== decision.side) { log(`🚫 contra-tendência`); continue; }

        const e50 = STRAT.ema50(closes15m);
        const e50p = STRAT.ema50(closes15m.slice(0, -1));
        const slope = (e50 - e50p) / e50p;
        if (decision.side === 'BUY'  && (price < e50 || slope < 0)) { log('🚫 EMA50'); continue; }
        if (decision.side === 'SELL' && (price > e50 || slope > 0)) { log('🚫 EMA50'); continue; }
      }

      // Sizing
      const confidence = decision.side === 'BUY' ? decision.buy : decision.sell;
      const strength = Math.max(0, Math.min(1, (confidence - 0.55) / 0.45));
      const regime = decision.regime || 'RANGE';
      const regimeMult = regime === 'TREND' ? 1.3 : regime === 'VOLATILE' ? 0.5 : 1.0;

      let orderValue = available * (0.01 + strength * 0.03) * regimeMult;
      if (orderValue < 15) orderValue = 15;
      const cap = available * 0.08;
      if (cap >= 15 && orderValue > cap) orderValue = cap;

      const symMinQty = getMinQty(sym);
      let qty = Math.ceil((orderValue / price) * 10000) / 10000;
      if (qty * price < 15) qty = Math.ceil((15 / price) * 10000) / 10000;
      if (qty < symMinQty) qty = symMinQty;

      log(`📊 ${decision.side} conf:${confidence.toFixed(2)} $${orderValue.toFixed(2)} qty:${qty}`);

      const data = await callApi(base, {
        action: 'order', symbol: sym, side: decision.side,
        quantity: qty.toFixed(4), price, confidence,
        slPct: 0.006,  // 0.6%
      });

      if (!data || data.code !== '00000') { log(`❌ ${sym}: ${data ? JSON.stringify(data).slice(0,80) : 'timeout'}`); continue; }

      log(`🚀 ${decision.side} ${sym} @ ${price}`);
      TRAIL_STATE[sym] = { lastOpen: Date.now(), bots: decision.bots, regime: decision.regime };
      await persistTrailState();

      if (data.warning) {
        log(`🛑 ${sym} SEM PROTEÇÃO — FECHAR`);
        await callApi(base, { action: 'close', symbol: sym, holdSide: decision.side === 'BUY' ? 'long' : 'short' });
        TRAIL_STATE[sym] = { lastOpen: Date.now() + 14 * 60_000 };
        await persistTrailState();
        continue;
      }

      await saveTrade({ symbol: sym, side: decision.side, qty, bots: decision.bots, time: Date.now() });
      await saveEquity(equity);
      break;
    }

  } catch (e) {
    log(`🔥 ${e.message}`);
  }
};
