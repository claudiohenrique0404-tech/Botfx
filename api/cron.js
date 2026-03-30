// ===== IMPORTS =====
const STRAT = require('./strategies');
const { saveTrade, saveEquity, setTradePnL } = require('./db');
const BRAIN = require('./brain');

const fetch = global.fetch || require('node-fetch');

// ===== LOGS =====
if (!global.LOGS) global.LOGS = [];
let LOGS = global.LOGS;

// ===== STATE =====
let TRADES_TODAY  = 0;
let START_BALANCE = null;

const MAX_TRADES_DAY = 10;
const MAX_DAILY_LOSS = -3; // %

// ===== LOGGER =====
function log(msg) {
  const t = new Date().toLocaleTimeString('pt-PT', { hour12: false, timeZone: 'Europe/Lisbon' });
  const e = `[${t}] ${msg}`;
  console.log(e);
  LOGS.unshift(e);
  if (LOGS.length > 200) LOGS.pop();
}

// ===== CONSENSO =====
function analyzeBots(closes) {
  const signals = {
    trend:    STRAT.trendBot(closes),
    rsi:      STRAT.rsiBot(closes),
    momentum: STRAT.momentumBot(closes),
  };

  const weights = BRAIN.getWeights();
  let buy = 0, sell = 0, used = [];

  for (const k in signals) {
    const s = signals[k];
    if (!s) continue;
    const w = weights[k] || 0.6;
    if (s.side === 'BUY')  buy  += s.confidence * w;
    if (s.side === 'SELL') sell += s.confidence * w;
    used.push(k);
  }

  log(`🗳️ BUY:${buy.toFixed(2)} SELL:${sell.toFixed(2)}`);

  if (buy  > sell && buy  > 0.55) return { side: 'BUY',  bots: used, buy, sell };
  if (sell > buy  && sell > 0.55) return { side: 'SELL', bots: used, buy, sell };

  return null;
}

// ===== API HELPER =====
async function callApi(base, body) {
  const r = await fetch(base + '/api/bitget', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return r.json();
}

// ===== MAIN BOT =====
module.exports = async function runBot() {
  try {
    const base = process.env.BASE_URL;

    // ── Settings ──────────────────────────────────────────────
    const settings = await callApi(base, { action: 'getSettings' });
    if (!settings.active) { log('⏸ BOT OFF'); return; }

    // ── Balance ───────────────────────────────────────────────
    const balanceData = await callApi(base, { action: 'balance' });
    const balance     = parseFloat(balanceData[0]?.available || 0);

    if (!balance || balance <= 0) { log('❌ balance inválido'); return; }

    if (!START_BALANCE) START_BALANCE = balance;

    const pnlDay = ((balance - START_BALANCE) / START_BALANCE) * 100;
    log(`💰 ${balance.toFixed(2)} | Day: ${pnlDay.toFixed(2)}%`);

    if (pnlDay <= MAX_DAILY_LOSS) { log('🛑 KILL SWITCH'); return; }
    if (TRADES_TODAY >= MAX_TRADES_DAY) { log('⏸ LIMITE ATINGIDO'); return; }

    // ── Posições abertas ──────────────────────────────────────
    const positions = await callApi(base, { action: 'positions' });
    console.log('POSITIONS:', JSON.stringify(positions));

    // ── Gerir posições existentes ─────────────────────────────
    for (const pos of positions) {
      const symbol   = pos.symbol;
      const holdSide = pos.holdSide; // 'long' ou 'short' da Bitget
      const entry    = parseFloat(pos.openPriceAvg || pos.openPrice || 0);
      const current  = parseFloat(pos.markPrice || pos.last || 0);
      const size     = parseFloat(pos.total || 0);

      if (!entry || !current || !size || !holdSide) continue;

      // PnL correto para long e short
      const pnl = holdSide === 'long'
        ? ((current - entry) / entry) * 100
        : ((entry - current) / entry) * 100;

      log(`📊 ${symbol} ${holdSide} PnL: ${pnl.toFixed(2)}%`);

      // Fechar se atingiu TP ou SL (fallback — Bitget já tem as ordens)
      if (pnl > 1.6 || pnl < -0.8) {
        await callApi(base, { action: 'close', symbol, holdSide });
        log(pnl > 0 ? `✅ TP ${symbol} +${pnl.toFixed(2)}%` : `🛑 SL ${symbol} ${pnl.toFixed(2)}%`);

        const trade = setTradePnL(symbol, pnl);
        if (trade?.bots) {
          for (const b of trade.bots) BRAIN.updateBot(b, pnl);
        }
      }
    }

    // ── Procurar novos sinais ─────────────────────────────────
    const openSymbols = positions.map(p => p.symbol);

    for (const sym of settings.symbols) {
      if (openSymbols.includes(sym)) continue;

      log(`🔍 ${sym}`);

      const candles = await callApi(base, { action: 'candles', symbol: sym, tf: '1m' });

      if (!candles.length) { log('⚠️ sem candles'); continue; }

      const closes = candles.map(c => +c[4]);
      const price  = closes.at(-1);

      if (!price || price <= 0) continue;

      if (!STRAT.marketFilter(closes)) { log('😴 mercado parado'); continue; }

      const decision = analyzeBots(closes);
      if (!decision) { log('❌ sem consenso'); continue; }

      // ── Dimensionamento ───────────────────────────────────────
      const confidence = decision.side === 'BUY' ? decision.buy : decision.sell;
      const strength   = Math.max(0, Math.min(1, (confidence - 0.55) / 0.45));
      let orderValue   = balance * (0.02 + strength * 0.08);
      if (orderValue < 5.5) orderValue = 5.5;

      let qty = Math.ceil((orderValue / price) * 10000) / 10000;
      if (qty * price < 5.5) qty = Math.ceil((5.5 / price) * 10000) / 10000;

      log(`📊 ${decision.side} conf:${confidence.toFixed(2)} size:${orderValue.toFixed(2)}$ qty:${qty}`);

      // ── Abrir — passar price para SL/TP serem definidos na Bitget ──
      const data = await callApi(base, {
        action:   'order',
        symbol:   sym,
        side:     decision.side,
        quantity: qty.toFixed(4),
        price,
      });

      if (data.code !== '00000') {
        log(`❌ erro ${data.msg}`);
        continue;
      }

      log(`🚀 ${decision.side} ${sym} @ ${price}`);

      await saveTrade({ symbol: sym, side: decision.side, qty, bots: decision.bots, time: Date.now() });
      await saveEquity(balance);

      TRADES_TODAY++;
      break; // um trade por ciclo
    }

  } catch (e) {
    log(`🔥 ${e.message}`);
  }
};
