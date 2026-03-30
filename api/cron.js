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

// Trailing state por símbolo — persiste entre ciclos de 5s
// { symbol: { maxPnl, openTime } }
const TRAIL_STATE = {};

// ===== LOGGER =====
function log(msg) {
  const t = new Date().toLocaleTimeString('pt-PT', { hour12: false, timeZone: 'Europe/Lisbon' });
  const e = `[${t}] ${msg}`;
  console.log(e);
  LOGS.unshift(e);
  if (LOGS.length > 200) LOGS.pop();
}

// ===== CONSENSO (6 bots + regime) =====
function analyzeBots(candles) {
  const closes = Array.isArray(candles) && typeof candles[0] === 'object'
    ? candles.map(c => parseFloat(c[4] || c.c || 0)).filter(Boolean)
    : candles;

  // Detectar regime de mercado
  const regime = STRAT.detectRegime(closes);

  const rawSignals = {
    trend:      STRAT.trendBot(closes),
    rsi:        STRAT.rsiBot(closes),
    momentum:   STRAT.momentumBot(closes),
    breakout:   STRAT.breakoutBot(candles),    // usa candles completos para volume
    volume:     STRAT.volumeBot(candles),
    volatility: STRAT.volatilityBot(closes),
  };

  // Filtrar sinais pelo regime — desliga bots inadequados ao contexto
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

  if (buy  > sell && buy  > 0.55) return { side: 'BUY',  bots: used, buy, sell, regime };
  if (sell > buy  && sell > 0.55) return { side: 'SELL', bots: used, buy, sell, regime };

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
    const MAX_TIME_MS  = 20 * 60 * 1000; // 20 minutos
    const TRAIL_THRESH = 0.5;             // recuo de 50% do pico → sair

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
        TRAIL_STATE[symbol] = { maxPnl: pnl, openTime: openTime || Date.now() };
      }

      // Atualizar pico de PnL
      if (pnl > TRAIL_STATE[symbol].maxPnl) {
        TRAIL_STATE[symbol].maxPnl = pnl;
      }

      // Partial TP: fechar 50% da posição quando pnl >= 0.8%
      if (pnl >= 0.8 && !TRAIL_STATE[symbol].partialDone) {
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
          TRAIL_STATE[symbol].partialDone = false; // retry no próximo ciclo
        }
        await new Promise(r => setTimeout(r, 300));
      }

      // Breakeven: se passou 0.5% de lucro, atualizar SL para entry na Bitget
      if (pnl >= 0.5 && !TRAIL_STATE[symbol].beSet) {
        TRAIL_STATE[symbol].beSet = true;
        const dp = entry > 10000 ? 1 : entry > 100 ? 2 : entry > 1 ? 4 : 6;
        const beBuf = entry * 0.001; // pequeno buffer acima do entry
        const bePrice = holdSide === 'long'
          ? parseFloat((entry + beBuf).toFixed(dp))
          : parseFloat((entry - beBuf).toFixed(dp));

        // Cancelar SL antigo e colocar novo em breakeven
        try {
          const plans = await callApi(base, { action: 'getPlanOrders', symbol, holdSide });
          const slOrder = (plans?.data?.entrustedList || []).find(o => o.planType === 'loss_plan');
          if (slOrder?.orderId) {
            await callApi(base, { action: 'cancelPlan', symbol, orderId: slOrder.orderId });
            await new Promise(r => setTimeout(r, 200));
          }
          await callApi(base, {
            action: 'placeTpsl', symbol, holdSide,
            planType: 'loss_plan', triggerPrice: bePrice,
            size, productType: 'USDT-FUTURES',
          });
          log(`🔒 BE ${symbol} SL→${bePrice} (entrada protegida)`);
        } catch(e) {
          log(`⚠️ BE ${symbol} falhou: ${e.message}`);
        }
      }

      const maxPnl   = TRAIL_STATE[symbol].maxPnl;
      const timeOpen = Date.now() - (TRAIL_STATE[symbol].openTime || Date.now());
      const exitReason = STRAT.exitBot(pnl, timeOpen, maxPnl);

      log(`📊 ${symbol} ${holdSide} PnL:${pnl.toFixed(2)}% max:${maxPnl.toFixed(2)}% t:${Math.round(timeOpen/60000)}min`);

      let shouldClose  = false;
      let closeReason  = '';

      // SL hard fallback — Bitget devia ter apanhado mas por segurança
      if (pnl <= -0.8) { shouldClose = true; closeReason = `SL hard ${pnl.toFixed(2)}%`; }
      // TP e trailing geridos pelo exitBot + Bitget
      else if (exitReason === 'TRAIL') { shouldClose = true; closeReason = `TRAIL (pico:${maxPnl.toFixed(2)}% → ${pnl.toFixed(2)}%)`; }
      else if (exitReason === 'TIME')  { shouldClose = true; closeReason = `TIME STOP ${Math.round(timeOpen/60000)}min +${pnl.toFixed(2)}%`; }
      else if (exitReason === 'TIME_WEAK') { shouldClose = true; closeReason = `TRADE FRACA ${Math.round(timeOpen/60000)}min ${pnl.toFixed(2)}%`; }

      if (shouldClose) {
        await callApi(base, { action: 'close', symbol, holdSide });
        log(pnl > 0 ? `✅ ${closeReason} ${symbol}` : `🛑 ${closeReason} ${symbol}`);

        // Limpar trailing state
        delete TRAIL_STATE[symbol];

        const trade = setTradePnL(symbol, pnl);
        if (trade?.bots) {
          for (const b of trade.bots) BRAIN.updateBot(b, pnl);
        }
      }
    }

    // ── Procurar novos sinais ─────────────────────────────────
    // Máx 1 posição de cada vez — evita risco acumulado
    const MAX_POSITIONS = 2;
    if (positions.length >= MAX_POSITIONS) {
      log(`⏸ ${positions.length}/${MAX_POSITIONS} posições ativas — aguardar`);
      return;
    }

    const openSymbols = positions.map(p => p.symbol);
    const openSides   = positions.map(p => p.holdSide); // 'long' ou 'short'

    for (const sym of settings.symbols) {
      if (openSymbols.includes(sym)) continue;

      // Verificar decisão antes de buscar candles (evita chamadas desnecessárias)
      // Será verificado depois da análise — placeholder aqui

      log(`🔍 ${sym}`);

      const [candles1m, candles5m] = await Promise.all([
        callApi(base, { action: 'candles', symbol: sym, tf: '1m' }),
        callApi(base, { action: 'candles', symbol: sym, tf: '5m' }),
      ]);

      if (!candles1m || !candles1m.length) { log('⚠️ sem candles'); continue; }

      const closes = candles1m.map(c => +c[4]);
      const price  = closes.at(-1);

      if (!price || price <= 0) continue;

      if (!STRAT.marketFilter(closes)) { log('😴 mercado parado'); continue; }

      // Decisão no 1m
      const decision = analyzeBots(candles1m);
      if (!decision) { log('❌ sem consenso'); continue; }

      // Correlação: evitar 2 longs ou 2 shorts ao mesmo tempo
      const decSide = decision.side === 'BUY' ? 'long' : 'short';
      if (positions.length > 0 && openSides.every(s => s === decSide)) {
        log(`⚠️ ${sym} correlação — já tens ${positions.length} ${decSide}(s)`);
        continue;
      }

      // Filtro de contexto — 5m não pode contradizer
      if (candles5m && candles5m.length >= 50) {
        const closes5m  = candles5m.map(c => +c[4]);
        const context5m = STRAT.contextFilter(closes5m);
        if (context5m !== 'NEUTRAL' && context5m !== decision.side) {
          log(`🚫 ${sym} contra-tendência (5m:${context5m} 1m:${decision.side})`);
          continue;
        }
      }

      // ── Dimensionamento dinâmico por regime ──────────────────
      const confidence = decision.side === 'BUY' ? decision.buy : decision.sell;
      const strength   = Math.max(0, Math.min(1, (confidence - 0.55) / 0.45));
      const regime     = decision.regime || 'RANGE';

      // Regime ajusta o multiplicador de size
      const regimeMult = regime === 'TREND'    ? 1.3   // tendência → arriscar mais
                       : regime === 'VOLATILE' ? 0.5   // volátil → arriscar menos
                       :                        1.0;   // lateral → normal

      let orderValue = balance * (0.01 + strength * 0.03) * regimeMult;
      if (orderValue < 15) orderValue = 15;
      if (orderValue > balance * 0.08) orderValue = balance * 0.08; // cap 8% da banca

      log(`📐 Size: $${orderValue.toFixed(2)} (regime:${regime} mult:${regimeMult}x)`);

      let qty = Math.ceil((orderValue / price) * 10000) / 10000;
      if (qty * price < 15) qty = Math.ceil((15 / price) * 10000) / 10000;

      log(`📊 ${decision.side} conf:${confidence.toFixed(2)} size:${orderValue.toFixed(2)}$ qty:${qty}`);

      // ── Abrir — passar price para SL/TP serem definidos na Bitget ──
      const data = await callApi(base, {
        action:     'order',
        symbol:     sym,
        side:       decision.side,
        quantity:   qty.toFixed(4),
        price,
        confidence: decision.side === 'BUY' ? decision.buy : decision.sell,
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
