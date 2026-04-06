// ===== IMPORTS =====
const STRAT = require('./strategies');
const { saveTrade, saveEquity, setTradePnL } = require('./db');
const BRAIN = require('./brain');
const bitgetHandler = require('./bitget');
const redis = require('./redis');
const { getMinQty } = require('./contracts');

const fetch = global.fetch || require('node-fetch');

// ══════════════════════════════════════════════════════════════
// TEST_MODE: relaxa todos os filtros para testar fluxo SL/TP
// DESLIGAR após confirmar 🛡️ SL confirmado e 🎯 TP confirmado
// ══════════════════════════════════════════════════════════════
const TEST_MODE = true;

// ===== TRAIL_STATE persistence (shared Redis) =====
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

// ===== LOGS =====
if (!global.LOGS) global.LOGS = [];
let LOGS = global.LOGS;

// ===== STATE =====
let START_EQUITY = null;

const MAX_DAILY_LOSS = -6; // %

// Trailing state por símbolo — persiste entre ciclos
const TRAIL_STATE = {};

// Posições do ciclo anterior — para detetar fechos externos (Bitget SL/TP)
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

  // Regime detectado com 5m (50 candles = 4h)
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

  // TEST_MODE: 1 bot basta, thresholds baixos
  // PRODUÇÃO: mínimo 2 bots, 0.55/0.65 conf, 0.10 diff
  const minBots = TEST_MODE ? 1 : 2;
  if (used.length < minBots) return null;

  const diff = Math.abs(buy - sell);

  const minConf = TEST_MODE ? 0.30
                : regime === 'VOLATILE' ? 0.65 : 0.55;
  const minDiff = TEST_MODE ? 0.0 : 0.10;

  if (buy  > sell && buy  > minConf && diff > minDiff) return { side: 'BUY',  bots: used, buy, sell, regime };
  if (sell > buy  && sell > minConf && diff > minDiff) return { side: 'SELL', bots: used, buy, sell, regime };

  return null;
}

// ===== API HELPER =====
// Chama bitget.js directamente (sem HTTP) — evita deadlock em Node single-thread
// Timeout dinâmico: 'order' tem 30s (inclui SL/TP), outros 12s
function callApi(base, body) {
  const timeout = body.action === 'order' ? 30000 : 12000;

  return new Promise((resolve) => {
    const req = {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    };
    req.body = body;

    const res = {
      _status: 200,
      _data: null,
      status(code) { this._status = code; return this; },
      json(data) { resolve(data); },
    };

    const timer = setTimeout(() => {
      console.log(`callApi timeout [${body.action}] ${timeout/1000}s`);
      resolve(null);
    }, timeout);

    Promise.resolve(bitgetHandler(req, res))
      .then(() => clearTimeout(timer))
      .catch(e => {
        clearTimeout(timer);
        console.log(`callApi error [${body.action}]:`, e.message);
        resolve(null);
      });
  });
}

// ===== MAIN BOT =====
module.exports = async function runBot() {
  try {
    global.lastBotRun = Date.now();

    const base = process.env.BASE_URL;

    // Carregar TRAIL_STATE na primeira execução
    if (!global._trailLoaded) {
      await loadTrailState();
      global._trailLoaded = true;
      if (TEST_MODE) log('🧪🧪🧪 TEST_MODE ACTIVO — filtros relaxados, 1 bot basta, sem EMA50/contra-tendência 🧪🧪🧪');
    }

    // ── Settings ──
    const settings = global.BOT_SETTINGS || { active: true, lev: 3, symbols: [
      'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','ADAUSDT','AVAXUSDT','LINKUSDT'
    ]};
    if (!settings.active) { log('⏸ BOT OFF'); return; }

    // ── Balance — equity (com PnL) e available (margem livre) ──
    const balanceData = await callApi(base, { action: 'balance' });
    if (!balanceData || !balanceData[0]) { log('❌ balance inválido'); return; }

    const equity    = parseFloat(balanceData[0]?.equity    || 0);
    const available = parseFloat(balanceData[0]?.available || 0);

    if (!equity || equity <= 0) { log('❌ equity inválido'); return; }

    // Daily PnL baseado em equity (inclui unrealized) — reflecte valor real da conta
    if (!START_EQUITY) START_EQUITY = equity;
    const pnlDay = ((equity - START_EQUITY) / START_EQUITY) * 100;
    log(`💰 eq:${equity.toFixed(2)} avail:${available.toFixed(2)} | Day: ${pnlDay.toFixed(2)}%`);

    if (pnlDay <= MAX_DAILY_LOSS) { log('🛑 KILL SWITCH'); return; }

    // ── Posições abertas ──
    const positions = await callApi(base, { action: 'positions' });
    if (!Array.isArray(positions)) { log('❌ positions inválido'); return; }
    console.log('POSITIONS:', JSON.stringify(positions));

    // ── Gerir posições existentes ──
    for (const pos of positions) {
      const symbol   = pos.symbol;
      const holdSide = pos.holdSide;
      const entry    = parseFloat(pos.openPriceAvg || pos.openPrice || 0);
      const current  = parseFloat(pos.markPrice || pos.last || 0);
      const size     = parseFloat(pos.total || 0);
      const openTime = parseInt(pos.cTime || Date.now());

      if (!entry || !current || !size || !holdSide) continue;

      const pnl = holdSide === 'long'
        ? ((current - entry) / entry) * 100
        : ((entry - current) / entry) * 100;

      // Inicializar trailing state
      if (!TRAIL_STATE[symbol]) {
        TRAIL_STATE[symbol] = {};
      }
      if (TRAIL_STATE[symbol].maxPnl === undefined) {
        TRAIL_STATE[symbol].maxPnl = pnl;
      }
      if (!TRAIL_STATE[symbol].openTime) {
        TRAIL_STATE[symbol].openTime = openTime || Date.now();
      }

      if (pnl > TRAIL_STATE[symbol].maxPnl) {
        TRAIL_STATE[symbol].maxPnl = pnl;
      }

      // Partial TP: fechar 50% quando pnl >= 0.6%
      if (pnl >= 0.6 && !TRAIL_STATE[symbol].partialDone) {
        TRAIL_STATE[symbol].partialDone = true;
        const halfSize = (parseFloat(pos.total || 0) / 2).toFixed(4);
        try {
          await callApi(base, {
            action:   'partialClose',
            symbol,
            holdSide,
            quantity: halfSize,
          });
          log(`💰 PARTIAL TP ${symbol} 50% fechado @ +${pnl.toFixed(2)}%`);
        } catch(e) {
          log(`⚠️ Partial TP ${symbol} falhou: ${e.message}`);
          TRAIL_STATE[symbol].partialDone = false;
        }
        await new Promise(r => setTimeout(r, 300));
      }

      // Breakeven: mover SL para entry+buffer quando PnL ≥ 0.3%
      if (pnl >= 0.3 && !TRAIL_STATE[symbol].beSet) {
        TRAIL_STATE[symbol].beSet = true;
        const beBuf = entry * 0.001;
        const bePrice = holdSide === 'long'
          ? entry + beBuf
          : entry - beBuf;

        try {
          const plans = await callApi(base, { action: 'getPlanOrders', symbol, holdSide });
          const slOrder = (plans?.data?.entrustedList || []).find(o => o.planType === 'loss_plan');
          if (slOrder?.orderId) {
            await callApi(base, { action: 'cancelPlan', symbol, orderId: slOrder.orderId });
            await new Promise(r => setTimeout(r, 200));
          }
          // placeTpsl agora usa contract specs internamente (formatSize/formatPrice)
          await callApi(base, {
            action: 'placeTpsl', symbol, holdSide,
            planType: 'loss_plan', triggerPrice: bePrice,
            size, productType: 'USDT-FUTURES',
          });
          log(`🔒 BE ${symbol} SL→${bePrice.toFixed(6)} (entrada protegida)`);
        } catch(e) {
          log(`⚠️ BE ${symbol} falhou: ${e.message}`);
        }
      }

      const maxPnl   = TRAIL_STATE[symbol].maxPnl;
      const timeOpen = Date.now() - (TRAIL_STATE[symbol].openTime || Date.now());
      const exitReason = STRAT.exitBot(pnl, timeOpen, maxPnl);

      log(`📊 ${symbol} ${holdSide} PnL:${(pnl??0).toFixed(2)}% max:${(maxPnl??0).toFixed(2)}% t:${Math.round(timeOpen/60000)}min`);

      let shouldClose  = false;
      let closeReason  = '';

      const slThreshold = -0.5;
      if (pnl <= slThreshold) { shouldClose = true; closeReason = `SL hard ${pnl.toFixed(2)}% (thresh:${slThreshold}%)`; }
      else if (exitReason === 'TRAIL') { shouldClose = true; closeReason = `TRAIL (pico:${maxPnl.toFixed(2)}% → ${pnl.toFixed(2)}%)`; }
      else if (exitReason === 'TIME')  { shouldClose = true; closeReason = `TIME STOP ${Math.round(timeOpen/60000)}min +${pnl.toFixed(2)}%`; }
      else if (exitReason === 'TIME_WEAK') { shouldClose = true; closeReason = `TRADE FRACA ${Math.round(timeOpen/60000)}min ${pnl.toFixed(2)}%`; }

      if (shouldClose) {
        await callApi(base, { action: 'close', symbol, holdSide });
        log(pnl > 0 ? `✅ ${closeReason} ${symbol}` : `🛑 ${closeReason} ${symbol}`);

        delete TRAIL_STATE[symbol];
        await persistTrailState(); // ← agora com await

        const trade = setTradePnL(symbol, pnl);
        if (trade?.bots) {
          for (const b of trade.bots) BRAIN.updateBot(b, pnl);
        }
      }
    }

    // ── Detetar fechos externos (Bitget SL/TP) ──
    for (const prevPos of PREV_POSITIONS) {
      const stillOpen = positions.find(p => p.symbol === prevPos.symbol && p.holdSide === prevPos.holdSide);
      if (!stillOpen) {
        const entry    = parseFloat(prevPos.openPriceAvg || 0);
        const isLong   = prevPos.holdSide === 'long';
        const achieved = parseFloat(prevPos.achievedProfits || 0);
        const margin   = parseFloat(prevPos.marginSize || 0);
        let pnl = 0;
        if (achieved !== 0 && margin > 0) {
          pnl = (achieved / margin) * 100;
        } else {
          const mark = parseFloat(prevPos.markPrice || entry);
          pnl = entry > 0 ? ((isLong ? mark - entry : entry - mark) / entry * 100) : 0;
        }

        log(`📕 ${prevPos.symbol} fechado externamente (Bitget) PnL:${pnl.toFixed(2)}%`);

        const trade = setTradePnL(prevPos.symbol, pnl);
        const botsToUpdate = trade?.bots || TRAIL_STATE[prevPos.symbol]?.bots;
        if (botsToUpdate && botsToUpdate.length > 0) {
          for (const b of botsToUpdate) BRAIN.updateBot(b, pnl);
          log(`🧠 Brain atualizado: ${botsToUpdate.join(',')} → ${pnl.toFixed(2)}%`);
        } else {
          log(`⚠️ ${prevPos.symbol} sem bots registados — brain não atualizado`);
        }

        delete TRAIL_STATE[prevPos.symbol];

        await saveEquity(equity);
      }
    }
    PREV_POSITIONS = positions.slice();

    // ── Procurar novos sinais ──
    const MAX_POSITIONS = 2;
    if (positions.length >= MAX_POSITIONS) {
      log(`⏸ ${positions.length}/${MAX_POSITIONS} posições ativas — aguardar`);
      return;
    }

    const openSymbols = positions.map(p => p.symbol);
    const openSides   = positions.map(p => p.holdSide);

    for (const sym of settings.symbols) {
      if (openSymbols.includes(sym)) continue;

      // Cooldown — em TEST_MODE, limpar cooldowns antigos (podem ter timestamps futuros do bug anterior)
      const symState = TRAIL_STATE[sym];
      if (symState?.lastOpen && Date.now() - symState.lastOpen < 120000) {
        if (TEST_MODE) {
          log(`🧪 ${sym} cooldown ignorado (TEST_MODE) — limpar state antigo`);
          delete TRAIL_STATE[sym];
        } else {
          log(`⏳ ${sym} em cooldown`);
          continue;
        }
      }

      log(`🔍 ${sym}`);

      const [r5m, r15m] = await Promise.allSettled([
        callApi(base, { action: 'candles', symbol: sym, tf: '5m' }),
        callApi(base, { action: 'candles', symbol: sym, tf: '15m' }),
      ]);
      const candles5m  = r5m.status  === 'fulfilled' ? r5m.value  : null;
      const candles15m = r15m.status === 'fulfilled' ? r15m.value : null;

      if (!candles5m || !candles5m.length) { log('⚠️ sem candles'); continue; }

      const closes = candles5m.map(c => typeof c === 'object' && !Array.isArray(c) ? c.c : +c[4]).filter(v => v && !isNaN(v));
      if (closes.length < 50) { log(`⚠️ ${sym} candles insuficientes (${closes.length})`); continue; }

      const price = closes.at(-1);
      if (!price || price <= 0 || isNaN(price)) { log(`⚠️ ${sym} price inválido`); continue; }

      if (!TEST_MODE && !STRAT.marketFilter(closes)) { log('😴 mercado parado'); continue; }

      let decision = analyzeBots(candles5m, candles15m);

      // TEST_MODE: se nenhum bot disparou, forçar sinal pela direcção da última vela
      // Objectivo: gerar trade para confirmar fluxo order → SL/TP → logs
      if (!decision && TEST_MODE) {
        const lastCandle = closes.at(-1);
        const prevCandle = closes.at(-2);
        if (lastCandle && prevCandle) {
          const forceSide = lastCandle >= prevCandle ? 'BUY' : 'SELL';
          decision = {
            side: forceSide,
            bots: ['forced_test'],
            buy:  forceSide === 'BUY'  ? 0.50 : 0.00,
            sell: forceSide === 'SELL' ? 0.50 : 0.00,
            regime: 'RANGE',
          };
          log(`🧪 FORCED TRADE ${forceSide} ${sym} (test SL/TP flow)`);
        }
      }

      if (!decision) { log('❌ sem consenso'); continue; }

      // Correlação
      const decSide   = decision.side === 'BUY' ? 'long' : 'short';
      const topScore  = decision.side === 'BUY' ? decision.buy : decision.sell;
      const strongSignal = topScore > 0.85 && decision.bots.length >= 3;
      if (!TEST_MODE && positions.length > 0 && openSides.every(s => s === decSide) && !strongSignal) {
        log(`⚠️ ${sym} correlação — já tens ${positions.length} ${decSide}(s)`);
        continue;
      }
      if (positions.length > 0 && openSides.every(s => s === decSide) && strongSignal) {
        log(`⚡ ${sym} sinal forte (${topScore.toFixed(2)}) — override correlação`);
      }

      // Filtros de contexto + EMA50 — DESLIGADOS em TEST_MODE
      const regime15m = decision.regime || 'RANGE';
      const topDiff = Math.abs(decision.buy - decision.sell);

      if (!TEST_MODE) {
        if (regime15m === 'VOLATILE' && topDiff < 0.25) {
          log(`🚫 ${sym} VOLATILE fraco (diff:${topDiff.toFixed(2)}) — bloqueado`);
          continue;
        }
        if (candles15m && candles15m.length >= 50) {
          const closes15m  = candles15m.map(c => typeof c === 'object' && !Array.isArray(c) ? c.c : +c[4]);
          const context15m = STRAT.contextFilter(closes15m);
          if (context15m !== 'NEUTRAL' && context15m !== decision.side) {
            log(`🚫 ${sym} contra-tendência (15m:${context15m} 5m:${decision.side})`);
            continue;
          }

          const ema50now  = STRAT.ema50(closes15m);
          const ema50prev = STRAT.ema50(closes15m.slice(0, -1));
          const slope = (ema50now - ema50prev) / ema50prev;

          if (decision.side === 'BUY' && (price < ema50now || slope < 0)) {
            log(`🚫 ${sym} BUY bloqueado — preço:${price.toFixed(4)} EMA50:${ema50now.toFixed(4)} slope:${(slope*100).toFixed(4)}%`);
            continue;
          }
          if (decision.side === 'SELL' && (price > ema50now || slope > 0)) {
            log(`🚫 ${sym} SELL bloqueado — preço:${price.toFixed(4)} EMA50:${ema50now.toFixed(4)} slope:${(slope*100).toFixed(4)}%`);
            continue;
          }
        }
      } else {
        log(`🧪 TEST_MODE: filtros 15m/EMA50/VOLATILE desligados`);
      }

      // ── Dimensionamento dinâmico por regime ──
      // Usar available (margem livre) para sizing — não equity com PnL aberto
      const confidence = decision.side === 'BUY' ? decision.buy : decision.sell;
      const strength   = Math.max(0, Math.min(1, (confidence - 0.55) / 0.45));
      const regime     = decision.regime || 'RANGE';

      const regimeMult = regime === 'TREND'    ? 1.3
                       : regime === 'VOLATILE' ? 0.5
                       :                        1.0;

      let orderValue = available * (0.01 + strength * 0.03) * regimeMult;
      if (orderValue < 15) orderValue = 15;
      const capValue = available * 0.08;
      if (capValue >= 15 && orderValue > capValue) orderValue = capValue;

      log(`📐 Size: $${orderValue.toFixed(2)} (regime:${regime} mult:${regimeMult}x avail:${available.toFixed(2)})`);

      // Mínimo de qty do contrato (via API, não hardcoded)
      const symMinQty = getMinQty(sym);

      let qty = Math.ceil((orderValue / price) * 10000) / 10000;
      if (qty * price < 15) qty = Math.ceil((15 / price) * 10000) / 10000;
      if (qty < symMinQty) qty = symMinQty;

      log(`📊 ${decision.side} conf:${confidence.toFixed(2)} size:${orderValue.toFixed(2)}$ qty:${qty}`);

      // ── Abrir — timeout de 30s para incluir SL/TP ──
      const data = await callApi(base, {
        action:     'order',
        symbol:     sym,
        side:       decision.side,
        quantity:   qty.toFixed(4),
        price,
        confidence: decision.side === 'BUY' ? decision.buy : decision.sell,
      });

      if (!data) {
        log(`❌ ${sym}: sem resposta da API`);
        continue;
      }
      if (data.code !== '00000') {
        log(`❌ ${sym}: ${JSON.stringify(data).slice(0, 100)}`);
        continue;
      }

      log(`🚀 ${decision.side} ${sym} @ ${price} (candle) — exec real no bitget.js`);

      TRAIL_STATE[sym] = TRAIL_STATE[sym] || {};
      TRAIL_STATE[sym].lastOpen = Date.now();
      TRAIL_STATE[sym].bots   = decision.bots;
      TRAIL_STATE[sym].regime = decision.regime;
      await persistTrailState(); // ← agora com await

      // Se SL/TP falharam → fechar imediatamente
      if (data.warning) {
        log(`🛑 ${sym} ORDEM SEM PROTEÇÃO — FECHAR IMEDIATO`);
        await callApi(base, {
          action: 'close',
          symbol: sym,
          holdSide: decision.side === 'BUY' ? 'long' : 'short',
        });
        TRAIL_STATE[sym] = { lastOpen: Date.now() + 14 * 60 * 1000 };
        await persistTrailState(); // ← agora com await
        continue;
      }

      await saveTrade({ symbol: sym, side: decision.side, qty, bots: decision.bots, time: Date.now() });
      await saveEquity(equity);

      break; // um trade por ciclo
    }

  } catch (e) {
    log(`🔥 ${e.message}`);
  }
};
