// scalper.js — orquestrador de scalping puro
// Independente do cron.js — estado próprio, Redis prefixo scalp:
const SCALP = require('./scalp-strategies');
const BRAIN = require('./brain');
const bitgetHandler = require('./bitget');
const redis = require('./redis');
const { getMinQty } = require('./contracts');

// ══════════════════════════════════════════════════════════════
// CONFIG SCALPER
// ══════════════════════════════════════════════════════════════
const SYMBOLS     = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const LEVERAGE    = 3;
const SL_PCT      = 0.0020;     // 0.20%
const TP_PCT      = 0.0035;     // 0.35% (~0.23% líquido)
const MAX_POS     = 1;          // 1 scalp de cada vez — foco total
const COOLDOWN_MS = 60_000;     // 60s por símbolo
const TIME_STOP   = 3 * 60_000; // 3 min max
const KILL_SWITCH = -4;         // % daily loss
const MIN_SCORE   = 1.00;       // score mínimo (soma de 2+ bots concordantes)

// ── State ────────────────────────────────────────────────────
let START_EQUITY = null;
const STATE = {};          // trailing/cooldown por símbolo
let PREV_POSITIONS = [];
if (!global.SCALP_LOGS) global.SCALP_LOGS = [];
const LOGS = global.SCALP_LOGS;

// ── Logger ───────────────────────────────────────────────────
function log(msg) {
  const t = new Date().toLocaleTimeString('pt-PT', { hour12: false, timeZone: 'Europe/Lisbon' });
  const e = `[${t}] ${msg}`;
  console.log(e);
  LOGS.unshift(e);
  if (LOGS.length > 200) LOGS.pop();
}

// ── Redis persistence (scalp: prefix) ────────────────────────
async function saveState() {
  if (!redis) return;
  try { await redis.set('scalp:state', STATE); } catch {}
}

async function loadState() {
  if (!redis) return;
  try {
    const saved = await redis.get('scalp:state');
    if (saved && typeof saved === 'object') {
      Object.assign(STATE, saved);
      log(`📦 Scalp state carregado: ${Object.keys(saved).length} símbolos`);
    }
  } catch {}
}

async function saveTrade(t) {
  if (!redis) return;
  try {
    let trades = (await redis.get('scalp:trades')) || [];
    trades.push({ ...t, id: Date.now() + Math.random(), pnl: undefined });
    if (trades.length > 500) trades = trades.slice(-500);
    await redis.set('scalp:trades', trades);
  } catch {}
}

async function setTradePnL(symbol, pnl) {
  if (!redis) return null;
  try {
    let trades = (await redis.get('scalp:trades')) || [];
    const t = [...trades].reverse().find(tr => tr.symbol === symbol && typeof tr.pnl !== 'number');
    if (t) {
      t.pnl = pnl;
      await redis.set('scalp:trades', trades);
      return t;
    }
  } catch {}
  return null;
}

async function saveEquity(eq) {
  if (!redis) return;
  try {
    let equity = (await redis.get('scalp:equity')) || [];
    equity.push({ value: eq, time: Date.now() });
    if (equity.length > 500) equity = equity.slice(-500);
    await redis.set('scalp:equity', equity);
  } catch {}
}

// ── Bitget API (direct call, same process) ───────────────────
function callApi(body) {
  const timeout = body.action === 'order' ? 30000 : 10000;
  return new Promise((resolve) => {
    const req = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    req.body = body;
    const res = {
      _status: 200,
      status(code) { this._status = code; return this; },
      json(data) { resolve(data); },
    };
    const timer = setTimeout(() => {
      log(`⏰ callApi timeout [${body.action}]`);
      resolve(null);
    }, timeout);
    Promise.resolve(bitgetHandler(req, res))
      .then(() => clearTimeout(timer))
      .catch(e => { clearTimeout(timer); resolve(null); });
  });
}

// ══════════════════════════════════════════════════════════════
// MAIN SCALPER LOOP
// ══════════════════════════════════════════════════════════════
module.exports = async function runScalper() {
  try {
    global.lastScalperRun = Date.now();

    // Carregar state na primeira execução
    if (!global._scalpStateLoaded) {
      await loadState();
      global._scalpStateLoaded = true;
      log(`⚡ SCALPER | SL:${(SL_PCT*100).toFixed(2)}% TP:${(TP_PCT*100).toFixed(2)}% MaxPos:${MAX_POS} Syms:${SYMBOLS.join(',')}`);
    }

    // ── Balance + Positions em paralelo ──
    const [balData, posData] = await Promise.all([
      callApi({ action: 'balance' }),
      callApi({ action: 'positions' }),
    ]);

    if (!balData?.[0]) { log('❌ balance'); return; }
    const equity    = parseFloat(balData[0].equity    || 0);
    const available = parseFloat(balData[0].available  || 0);
    if (equity <= 0) { log('❌ equity 0'); return; }

    if (!START_EQUITY) START_EQUITY = equity;
    const pnlDay = ((equity - START_EQUITY) / START_EQUITY) * 100;

    if (pnlDay <= KILL_SWITCH) { log('🛑 KILL SWITCH'); return; }

    const positions = Array.isArray(posData) ? posData : [];

    // Filtrar só posições dos símbolos do scalper
    const myPositions = positions.filter(p => SYMBOLS.includes(p.symbol));

    // ── Gerir posições abertas ──
    for (const pos of myPositions) {
      const sym      = pos.symbol;
      const holdSide = pos.holdSide;
      const entry    = parseFloat(pos.openPriceAvg || 0);
      const current  = parseFloat(pos.markPrice || 0);
      const size     = parseFloat(pos.total || 0);
      if (!entry || !current || !size) continue;

      const pnl = holdSide === 'long'
        ? ((current - entry) / entry) * 100
        : ((entry - current) / entry) * 100;

      if (!STATE[sym]) STATE[sym] = {};
      if (!STATE[sym].openTime) STATE[sym].openTime = parseInt(pos.cTime || Date.now());
      if (STATE[sym].maxPnl === undefined) STATE[sym].maxPnl = pnl;
      if (pnl > STATE[sym].maxPnl) STATE[sym].maxPnl = pnl;

      const timeOpen = Date.now() - STATE[sym].openTime;

      log(`📊 ${sym} ${holdSide} PnL:${pnl.toFixed(3)}% t:${Math.round(timeOpen/1000)}s`);

      let shouldClose = false;
      let reason = '';

      // SL fallback (caso Bitget SL não tenha disparado)
      if (pnl <= -(SL_PCT * 100 + 0.05)) {
        shouldClose = true;
        reason = `SL fallback ${pnl.toFixed(2)}%`;
      }
      // Time stop: scalp parado — sair com o que tiver
      else if (timeOpen > TIME_STOP && pnl > -0.10) {
        shouldClose = true;
        reason = `TIME ${Math.round(timeOpen/1000)}s PnL:${pnl.toFixed(2)}%`;
      }

      if (shouldClose) {
        await callApi({ action: 'close', symbol: sym, holdSide });
        log(pnl > 0 ? `✅ ${reason} ${sym}` : `🛑 ${reason} ${sym}`);

        const trade = await setTradePnL(sym, pnl);
        if (trade?.bots) { for (const b of trade.bots) BRAIN.updateBot(b, pnl); }

        STATE[sym] = { lastOpen: Date.now() };
        await saveState();
      }
    }

    // ── Fechos externos (Bitget SL/TP hit) ──
    for (const prev of PREV_POSITIONS) {
      if (!SYMBOLS.includes(prev.symbol)) continue;
      const stillOpen = myPositions.find(p => p.symbol === prev.symbol && p.holdSide === prev.holdSide);
      if (!stillOpen) {
        const entry = parseFloat(prev.openPriceAvg || 0);
        const isLong = prev.holdSide === 'long';
        const achieved = parseFloat(prev.achievedProfits || 0);
        const margin = parseFloat(prev.marginSize || 0);
        let pnl = 0;
        if (achieved !== 0 && margin > 0) pnl = (achieved / margin) * 100;
        else { const mark = parseFloat(prev.markPrice || entry); pnl = entry > 0 ? ((isLong ? mark - entry : entry - mark) / entry * 100) : 0; }

        log(`📕 ${prev.symbol} SL/TP hit PnL:${pnl.toFixed(2)}%`);

        const trade = await setTradePnL(prev.symbol, pnl);
        if (trade?.bots) {
          for (const b of trade.bots) BRAIN.updateBot(b, pnl);
          log(`🧠 ${trade.bots.join(',')} → ${pnl.toFixed(2)}%`);
        }
        delete STATE[prev.symbol];
        await saveEquity(equity);
      }
    }
    PREV_POSITIONS = myPositions.slice();

    // ── Procurar scalps ──
    if (myPositions.length >= MAX_POS) return; // silencioso — ciclo rápido

    // Filtrar símbolos disponíveis (sem posição aberta, sem cooldown)
    const candidates = SYMBOLS.filter(sym => {
      if (myPositions.find(p => p.symbol === sym)) return false;
      if (STATE[sym]?.lastOpen && Date.now() - STATE[sym].lastOpen < COOLDOWN_MS) return false;
      return true;
    });

    if (candidates.length === 0) return;

    // Fetch candles de TODOS os candidatos em paralelo — ~200ms em vez de ~600ms
    const candleResults = await Promise.allSettled(
      candidates.map(sym => callApi({ action: 'candles', symbol: sym, tf: '1m' }))
    );

    // Analisar todos e escolher o melhor sinal
    let bestSignal = null;
    let bestSym    = null;
    let bestPrice  = 0;
    let bestCandles = null;
    const scanInfo = []; // resumo por símbolo

    for (let i = 0; i < candidates.length; i++) {
      const sym = candidates[i];
      const short = sym.replace('USDT', '');
      const candles = candleResults[i].status === 'fulfilled' ? candleResults[i].value : null;
      if (!candles || candles.length < 25) { scanInfo.push(`${short}:no_data`); continue; }

      const closes = candles.map(c => c.c).filter(Boolean);
      const price = closes.at(-1);
      if (!price || price <= 0) { scanInfo.push(`${short}:bad_price`); continue; }

      if (!SCALP.scalpFilter(closes)) { scanInfo.push(`${short}:filtered`); continue; }

      const signal = SCALP.analyzeScalp(candles);
      if (!signal) { scanInfo.push(`${short}:0bots`); continue; }
      if (signal.score < MIN_SCORE) { scanInfo.push(`${short}:${signal.side[0]}${signal.score.toFixed(1)}↓`); continue; }

      scanInfo.push(`${short}:${signal.side[0]}${signal.score.toFixed(1)}✓`);

      if (!bestSignal || signal.score > bestSignal.score) {
        bestSignal  = signal;
        bestSym     = sym;
        bestPrice   = price;
        bestCandles = candles;
      }
    }

    log(`🔍 ${scanInfo.join(' | ')}`);

    if (!bestSignal) return;

    log(`⚡ ${bestSignal.side} ${bestSym} score:${bestSignal.score.toFixed(2)} [${bestSignal.bots.join(',')}]`);

    // Sizing
    const symMinQty = getMinQty(bestSym);
    let orderValue = Math.max(15, available * 0.02);
    const cap = available * 0.05;
    if (cap >= 15 && orderValue > cap) orderValue = cap;

    let qty = Math.ceil((orderValue / bestPrice) * 10000) / 10000;
    if (qty * bestPrice < 15) qty = Math.ceil((15 / bestPrice) * 10000) / 10000;
    if (qty < symMinQty) qty = symMinQty;

    // Order com SL/TP apertados
    const data = await callApi({
      action: 'order', symbol: bestSym, side: bestSignal.side,
      quantity: qty.toFixed(4), price: bestPrice,
      confidence: bestSignal.score,
      slPct: SL_PCT,
      tpPct: TP_PCT,
    });

    if (!data || data.code !== '00000') {
      log(`❌ ${bestSym}: ${data ? JSON.stringify(data).slice(0, 80) : 'timeout'}`);
      return;
    }

    log(`🚀 SCALP ${bestSignal.side} ${bestSym} @ ${bestPrice} qty:${qty}`);

    STATE[bestSym] = { lastOpen: Date.now(), bots: bestSignal.bots, openTime: Date.now() };
    await saveState();

    if (data.warning) {
      log(`🛑 ${bestSym} SEM PROTEÇÃO — fechar`);
      await callApi({ action: 'close', symbol: bestSym, holdSide: bestSignal.side === 'BUY' ? 'long' : 'short' });
      STATE[bestSym] = { lastOpen: Date.now() + 4 * 60_000 };
      await saveState();
      return;
    }

    await saveTrade({ symbol: bestSym, side: bestSignal.side, qty, bots: bestSignal.bots, time: Date.now() });
    await saveEquity(equity);

  } catch (e) {
    log(`🔥 ${e.message}`);
  }
};
