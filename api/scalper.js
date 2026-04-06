// scalper.js v3 — orquestrador de scalping
// VWAP, ATR dinâmico, candle patterns, filtro horário, confirmação 5m
const SCALP = require('./scalp-strategies');
const BRAIN = require('./brain');
const bitgetHandler = require('./bitget');
const redis = require('./redis');
const { getMinQty } = require('./contracts');

// ══════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════
const SYMBOLS     = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const LEVERAGE    = 5;
const MAX_POS     = 3;
const COOLDOWN_MS = 60_000;     // 60s por símbolo
const KILL_SWITCH = -4;         // % daily loss
const MIN_SCORE   = 1.00;
// SL/TP agora dinâmicos (ATR-based) — vêm do analyzeScalp

// ── State ────────────────────────────────────────────────────
let START_EQUITY = null;
const STATE = {};
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

// ── Redis (scalp: prefix) ────────────────────────────────────
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

// ── Bitget API ───────────────────────────────────────────────
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
// MAIN SCALPER
// ══════════════════════════════════════════════════════════════
module.exports = async function runScalper() {
  try {
    if (!global._scalpStateLoaded) {
      await loadState();
      global._scalpStateLoaded = true;
      if (global.BOT_SETTINGS) global.BOT_SETTINGS.lev = LEVERAGE;
      // Pré-configurar margin mode + leverage para todos os símbolos
      await callApi({ action: 'setupSymbols', symbols: SYMBOLS });
      log(`⚡ SCALPER v3 | Lev:${LEVERAGE}x | ATR SL/TP | VWAP+Patterns | 5m confirm | FAST ORDER`);
    }

    // ── Balance + Positions em paralelo ──
    const [balData, posData] = await Promise.all([
      callApi({ action: 'balance' }),
      callApi({ action: 'positions' }),
    ]);

    if (!balData?.[0]) { log('❌ balance'); return; }
    const equity    = parseFloat(balData[0].equity    || 0);
    const available = parseFloat(balData[0].available  || 0);
    if (equity <= 0) return;

    if (!START_EQUITY) START_EQUITY = equity;
    const pnlDay = ((equity - START_EQUITY) / START_EQUITY) * 100;
    if (pnlDay <= KILL_SWITCH) { log('🛑 KILL SWITCH'); return; }

    const positions = Array.isArray(posData) ? posData : [];
    const myPositions = positions.filter(p => SYMBOLS.includes(p.symbol));

    // ── Gerir posições (só as abertas pelo scalper, rastreadas em STATE) ──
    for (const pos of myPositions) {
      const sym      = pos.symbol;
      const holdSide = pos.holdSide;

      // Ignorar posições do swing bot (não estão no STATE do scalper)
      if (!STATE[sym]?.openTime) continue;

      const entry    = parseFloat(pos.openPriceAvg || 0);
      const current  = parseFloat(pos.markPrice || 0);
      if (!entry || !current) continue;

      const pnl = holdSide === 'long'
        ? ((current - entry) / entry) * 100
        : ((entry - current) / entry) * 100;

      if (STATE[sym].maxPnl === undefined) STATE[sym].maxPnl = pnl;
      if (pnl > STATE[sym].maxPnl) STATE[sym].maxPnl = pnl;

      const maxPnl = STATE[sym].maxPnl;
      const timeOpen = Date.now() - STATE[sym].openTime;
      const trailActive = maxPnl >= 0.30;

      // Log a cada 30s (ou a cada 5s se trailing activo — acompanhar de perto)
      const logInterval = trailActive ? 5000 : 30000;
      if (!STATE[sym].lastLog || Date.now() - STATE[sym].lastLog > logInterval) {
        const trailInfo = trailActive ? ` 🔒TRAIL(exit:${(maxPnl*0.60).toFixed(2)}%)` : '';
        log(`📊 ${sym} ${holdSide} PnL:${pnl.toFixed(3)}% max:${maxPnl.toFixed(2)}%${trailInfo} t:${Math.round(timeOpen/1000)}s`);
        STATE[sym].lastLog = Date.now();
      }

      // SL fallback (safety net)
      const slFallback = STATE[sym].slPct ? (STATE[sym].slPct * 100 + 0.05) : 0.25;
      let shouldClose = false;
      let reason = '';

      if (pnl <= -slFallback) {
        shouldClose = true;
        reason = `SL fallback ${pnl.toFixed(2)}%`;
      }
      // Trailing: activa acima de 0.30% (cobre fees) — recuo de 40% fecha
      else if (maxPnl >= 0.30 && pnl < maxPnl * 0.60) {
        shouldClose = true;
        reason = `TRAIL (pico:${maxPnl.toFixed(2)}%→${pnl.toFixed(2)}%)`;
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

    // ── Fechos externos (SL/TP hit na Bitget) ──
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
    // Só guardar posições do scalper para detecção de fechos
    const scalperPositions = myPositions.filter(p => STATE[p.symbol]?.openTime);
    PREV_POSITIONS = scalperPositions.slice();

    // ── Procurar scalps ──
    // Contar só posições abertas PELO SCALPER (rastreadas em STATE)
    // Ignora posições do swing bot nos mesmos símbolos
    const activeScalps = myPositions.filter(p => STATE[p.symbol]?.openTime).length;
    if (activeScalps >= MAX_POS) return;

    // Filtrar candidatos (só verificar posições do scalper, não do swing)
    const candidates = SYMBOLS.filter(sym => {
      if (scalperPositions.find(p => p.symbol === sym)) return false;
      if (STATE[sym]?.lastOpen && Date.now() - STATE[sym].lastOpen < COOLDOWN_MS) return false;
      return true;
    });

    if (candidates.length === 0) return;

    // Fetch 1m + 5m candles de todos os candidatos em paralelo
    const fetches = candidates.flatMap(sym => [
      callApi({ action: 'candles', symbol: sym, tf: '1m' }),
      callApi({ action: 'candles', symbol: sym, tf: '5m' }),
    ]);
    const results = await Promise.allSettled(fetches);

    // Analisar todos e escolher o melhor
    let bestSignal = null;
    let bestSym    = null;
    const scanInfo = [];

    for (let i = 0; i < candidates.length; i++) {
      const sym = candidates[i];
      const short = sym.replace('USDT', '');
      const candles1m = results[i * 2].status === 'fulfilled' ? results[i * 2].value : null;
      const candles5m = results[i * 2 + 1].status === 'fulfilled' ? results[i * 2 + 1].value : null;

      if (!candles1m || candles1m.length < 20) { scanInfo.push(`${short}:no_data`); continue; }

      if (!SCALP.scalpFilter(candles1m)) { scanInfo.push(`${short}:filtered`); continue; }

      const signal = SCALP.analyzeScalp(candles1m, candles5m);

      if (!signal) { scanInfo.push(`${short}:0bots`); continue; }
      if (signal.skip) { scanInfo.push(`${short}:${signal.reason}`); continue; }
      if (signal.score < MIN_SCORE) {
        scanInfo.push(`${short}:${signal.side[0]}${signal.score.toFixed(1)}↓`);
        continue;
      }

      scanInfo.push(`${short}:${signal.side[0]}${signal.score.toFixed(1)}✓`);

      if (!bestSignal || signal.score > bestSignal.score) {
        bestSignal = signal;
        bestSym    = sym;
      }
    }

    log(`🔍 ${scanInfo.join(' | ')}`);

    if (!bestSignal) return;

    // ── Abrir scalp com SL/TP dinâmico ──
    log(`⚡ ${bestSignal.side} ${bestSym} score:${bestSignal.score.toFixed(2)} [${bestSignal.bots.join(',')}] SL:${(bestSignal.slPct*100).toFixed(2)}% TP:${(bestSignal.tpPct*100).toFixed(2)}%`);

    const symMinQty = getMinQty(bestSym);
    const price = (await callApi({ action: 'candles', symbol: bestSym, tf: '1m' }))?.at(-1)?.c || 0;
    if (!price) return;

    let orderValue = Math.max(15, available * 0.02);
    const cap = available * 0.05;
    if (cap >= 15 && orderValue > cap) orderValue = cap;

    let qty = Math.ceil((orderValue / price) * 10000) / 10000;
    if (qty * price < 15) qty = Math.ceil((15 / price) * 10000) / 10000;
    if (qty < symMinQty) qty = symMinQty;

    const data = await callApi({
      action: 'order', symbol: bestSym, side: bestSignal.side,
      quantity: qty.toFixed(4), price,
      confidence: bestSignal.score,
      slPct: bestSignal.slPct,
      tpPct: bestSignal.tpPct,
      fast: true, // skip margin/leverage (pré-configurado no arranque)
    });

    if (!data || data.code !== '00000') {
      log(`❌ ${bestSym}: ${data ? JSON.stringify(data).slice(0, 80) : 'timeout'}`);
      return;
    }

    log(`🚀 SCALP ${bestSignal.side} ${bestSym} @ ${price} qty:${qty}`);

    STATE[bestSym] = {
      lastOpen: Date.now(),
      bots: bestSignal.bots,
      openTime: Date.now(),
      slPct: bestSignal.slPct,
    };
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
  } finally {
    global.lastScalperRun = Date.now(); // watchdog: marca ciclo COMPLETADO
  }
};
