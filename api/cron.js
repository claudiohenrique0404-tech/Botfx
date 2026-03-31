// ===== IMPORTS =====
const STRAT = require(’./strategies’);
const { saveTrade, saveEquity, setTradePnL } = require(’./db’);
const BRAIN = require(’./brain’);
const bitgetHandler = require(’./bitget’);

const fetch = global.fetch || require(‘node-fetch’);

// Redis direto para TRAIL_STATE (evitar duplicate code)
let _redis = null;
try {
if (process.env.UPSTASH_REDIS_REST_URL) {
const { Redis } = require(’@upstash/redis’);
_redis = new Redis({
url:   process.env.UPSTASH_REDIS_REST_URL,
token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
}
} catch {}

async function persistTrailState() {
if (!_redis) return;
try { await _redis.set(‘botfx:trail’, TRAIL_STATE); } catch {}
}

async function loadTrailState() {
if (!_redis) return;
try {
const saved = await _redis.get(‘botfx:trail’);
if (saved && typeof saved === ‘object’) {
Object.assign(TRAIL_STATE, saved);
console.log(‘📦 TRAIL_STATE carregado:’, Object.keys(saved).length, ‘símbolos’);
}
} catch {}
}

// ===== LOGS =====
if (!global.LOGS) global.LOGS = [];
let LOGS = global.LOGS;

// ===== STATE =====
let TRADES_TODAY  = 0;
let START_BALANCE = null;

const MAX_TRADES_DAY = 10;
const MAX_DAILY_LOSS = -3; // %

// Trailing state por símbolo — persiste entre ciclos de 5s
const TRAIL_STATE = {};

// Posições do ciclo anterior — para detetar fechos externos (Bitget SL/TP)
let PREV_POSITIONS = [];

// ===== LOGGER =====
function log(msg) {
const t = new Date().toLocaleTimeString(‘pt-PT’, { hour12: false, timeZone: ‘Europe/Lisbon’ });
const e = `[${t}] ${msg}`;
console.log(e);
LOGS.unshift(e);
if (LOGS.length > 200) LOGS.pop();
}

// ===== CONSENSO (6 bots + regime) =====
function analyzeBots(candles, candles5m) {
// Candles chegam normalizados como {ts,o,h,l,c,v} do bitget.js
const closes = typeof candles[0] === ‘number’
? candles
: candles.map(c => Array.isArray(c) ? parseFloat(c[4]) : parseFloat(c.c || 0)).filter(Boolean);

// Regime detectado com 5m (50 candles = 4h) — tendências lentas visíveis
// Fallback para 1m se 5m não disponível
const closes5mForRegime = candles5m && candles5m.length >= 20
? (typeof candles5m[0] === ‘number’ ? candles5m
: candles5m.map(c => Array.isArray(c) ? parseFloat(c[4]) : parseFloat(c.c || 0)).filter(Boolean))
: closes;
const regime = STRAT.detectRegime(closes5mForRegime);

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
if (s.side === ‘BUY’)  buy  += s.confidence * w;
if (s.side === ‘SELL’) sell += s.confidence * w;
used.push(k);
}

log(`🌍 ${regime} | 🗳️ BUY:${buy.toFixed(2)} SELL:${sell.toFixed(2)} [${used.join(',')||'—'}]`);

// Mínimo 2 bots sempre — 1 sinal isolado é ruído independentemente do score
if (used.length < 2) return null;

// Threshold combinado: score mínimo E margem sobre o adversário
const diff = Math.abs(buy - sell);
if (buy  > sell && buy  > 0.50 && diff > 0.12) return { side: ‘BUY’,  bots: used, buy, sell, regime };
if (sell > buy  && sell > 0.50 && diff > 0.12) return { side: ‘SELL’, bots: used, buy, sell, regime };

return null;
}

// ===== API HELPER =====
// Chama bitget.js directamente (sem HTTP) — evita deadlock em Node single-thread
async function callApi(base, body) {
return new Promise((resolve) => {
const chunks = [];
const req = {
method: ‘POST’,
body: JSON.stringify(body),
headers: { ‘Content-Type’: ‘application/json’ },
};
// Simular body parsing que o worker.js faz
req.body = body;

```
const res = {
  _status: 200,
  _data: null,
  status(code) { this._status = code; return this; },
  json(data) {
    resolve(data);
  },
};

const timer = setTimeout(() => {
  console.log(`callApi timeout [${body.action}]`);
  resolve(null);
}, 12000);

Promise.resolve(bitgetHandler(req, res))
  .then(() => clearTimeout(timer))
  .catch(e => {
    clearTimeout(timer);
    console.log(`callApi error [${body.action}]:`, e.message);
    resolve(null);
  });
```

});
}

// ===== MAIN BOT =====
module.exports = async function runBot() {
try {
const base = process.env.BASE_URL;

```
// Carregar TRAIL_STATE na primeira execução
if (!global._trailLoaded) {
  await loadTrailState();
  global._trailLoaded = true;
}

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
const MAX_TIME_MS = 20 * 60 * 1000; // fallback — exitBot gere os seus próprios limites

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

  // Inicializar trailing state — garantir maxPnl sempre definido
  if (!TRAIL_STATE[symbol]) {
    TRAIL_STATE[symbol] = {};
  }
  if (TRAIL_STATE[symbol].maxPnl === undefined) {
    TRAIL_STATE[symbol].maxPnl = pnl;
  }
  if (!TRAIL_STATE[symbol].openTime) {
    TRAIL_STATE[symbol].openTime = openTime || Date.now();
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

  log(`📊 ${symbol} ${holdSide} PnL:${(pnl??0).toFixed(2)}% max:${(maxPnl??0).toFixed(2)}% t:${Math.round(timeOpen/60000)}min`);

  let shouldClose  = false;
  let closeReason  = '';

  // SL hard fallback
  // Se sem proteção na exchange → SL mais apertado (-0.5%)
  const slThreshold = TRAIL_STATE[symbol]?.noProtection ? -0.5 : -0.8;
  if (pnl <= slThreshold) { shouldClose = true; closeReason = `SL hard ${pnl.toFixed(2)}% (thresh:${slThreshold}%)`; }
  // TP e trailing geridos pelo exitBot + Bitget
  else if (exitReason === 'TRAIL') { shouldClose = true; closeReason = `TRAIL (pico:${maxPnl.toFixed(2)}% → ${pnl.toFixed(2)}%)`; }
  else if (exitReason === 'TIME')  { shouldClose = true; closeReason = `TIME STOP ${Math.round(timeOpen/60000)}min +${pnl.toFixed(2)}%`; }
  else if (exitReason === 'TIME_WEAK') { shouldClose = true; closeReason = `TRADE FRACA ${Math.round(timeOpen/60000)}min ${pnl.toFixed(2)}%`; }

  if (shouldClose) {
    await callApi(base, { action: 'close', symbol, holdSide });
    log(pnl > 0 ? `✅ ${closeReason} ${symbol}` : `🛑 ${closeReason} ${symbol}`);

    // Limpar trailing state
    delete TRAIL_STATE[symbol];
    persistTrailState();

    const trade = setTradePnL(symbol, pnl);
    if (trade?.bots) {
      for (const b of trade.bots) BRAIN.updateBot(b, pnl);
    }
  }
}

// ── Detetar fechos externos (Bitget SL/TP) ──────────────────
// Comparar com ciclo anterior para ver quais posições desapareceram
for (const prevPos of PREV_POSITIONS) {
  const stillOpen = positions.find(p => p.symbol === prevPos.symbol && p.holdSide === prevPos.holdSide);
  if (!stillOpen) {
    // Esta posição foi fechada externamente (Bitget SL/TP ou manual)
    const entry    = parseFloat(prevPos.openPriceAvg || 0);
    const isLong   = prevPos.holdSide === 'long';
    // Usar achievedProfits da Bitget se disponível (mais preciso)
    // Caso contrário estimar com markPrice do ciclo anterior (aproximado)
    const achieved = parseFloat(prevPos.achievedProfits || 0);
    const margin   = parseFloat(prevPos.marginSize || 0);
    let pnl = 0;
    if (achieved !== 0 && margin > 0) {
      // PnL real em % da margem
      pnl = (achieved / margin) * 100;
    } else {
      const mark = parseFloat(prevPos.markPrice || entry);
      pnl = entry > 0 ? ((isLong ? mark - entry : entry - mark) / entry * 100) : 0;
    }

    log(`📕 ${prevPos.symbol} fechado externamente (Bitget) PnL:${pnl.toFixed(2)}%`);

    // Atualizar brain com resultado
    const trade = setTradePnL(prevPos.symbol, pnl);
    const botsToUpdate = trade?.bots || TRAIL_STATE[prevPos.symbol]?.bots;
    if (botsToUpdate && botsToUpdate.length > 0) {
      for (const b of botsToUpdate) BRAIN.updateBot(b, pnl);
      log(`🧠 Brain atualizado: ${botsToUpdate.join(',')} → ${pnl.toFixed(2)}%`);
    } else {
      log(`⚠️ ${prevPos.symbol} sem bots registados — brain não atualizado`);
    }

    // Limpar TRAIL_STATE
    delete TRAIL_STATE[prevPos.symbol];

    await saveEquity(balance);
  }
}
// Guardar posições para próximo ciclo
PREV_POSITIONS = positions.slice();

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

  // Cooldown: evitar retentar símbolo que acabou de abrir/falhar
  const symState = TRAIL_STATE[sym];
  if (symState?.lastOpen && Date.now() - symState.lastOpen < 60000) {
    log(`⏳ ${sym} em cooldown`);
    continue;
  }

  log(`🔍 ${sym}`);

  const [r1m, r5m] = await Promise.allSettled([
    callApi(base, { action: 'candles', symbol: sym, tf: '1m' }),
    callApi(base, { action: 'candles', symbol: sym, tf: '5m' }),
  ]);
  const candles1m = r1m.status === 'fulfilled' ? r1m.value : null;
  const candles5m = r5m.status === 'fulfilled' ? r5m.value : null;

  if (!candles1m || !candles1m.length) { log('⚠️ sem candles'); continue; }

  const closes = candles1m.map(c => typeof c === 'object' && !Array.isArray(c) ? c.c : +c[4]).filter(v => v && !isNaN(v));
  if (closes.length < 50) { log(`⚠️ ${sym} candles insuficientes (${closes.length})`); continue; }

  const price = closes.at(-1);
  if (!price || price <= 0 || isNaN(price)) { log(`⚠️ ${sym} price inválido`); continue; }

  if (!STRAT.marketFilter(closes)) { log('😴 mercado parado'); continue; }

  // Decisão no 1m — mas regime detectado com 5m (janela maior = tendência real)
  const decision = analyzeBots(candles1m, candles5m);
  if (!decision) { log('❌ sem consenso'); continue; }

  // Correlação: evitar 2 longs/shorts ao mesmo tempo
  // Excepção: sinal muito forte (score>0.85 e 3+ bots) pode abrir 2ª posição
  const decSide   = decision.side === 'BUY' ? 'long' : 'short';
  const topScore  = decision.side === 'BUY' ? decision.buy : decision.sell;
  const strongSignal = topScore > 0.85 && decision.bots.length >= 3;
  if (positions.length > 0 && openSides.every(s => s === decSide) && !strongSignal) {
    log(`⚠️ ${sym} correlação — já tens ${positions.length} ${decSide}(s)`);
    continue;
  }
  if (positions.length > 0 && openSides.every(s => s === decSide) && strongSignal) {
    log(`⚡ ${sym} sinal forte (${topScore.toFixed(2)}) — override correlação`);
  }

  // Filtro de contexto — 5m não pode contradizer
  if (candles5m && candles5m.length >= 50) {
    const closes5m  = candles5m.map(c => typeof c === 'object' && !Array.isArray(c) ? c.c : +c[4]);
    const context5m = STRAT.contextFilter(closes5m);
    if (context5m !== 'NEUTRAL' && context5m !== decision.side) {
      log(`🚫 ${sym} contra-tendência (5m:${context5m} 1m:${decision.side})`);
      continue;
    }

    // Filtro EMA50: posição do preço E inclinação da EMA
    const ema50now  = STRAT.ema50(closes5m);
    const ema50prev = STRAT.ema50(closes5m.slice(0, -1));
    const ema50prev2 = STRAT.ema50(closes5m.slice(0, -2));
    const slope1 = (ema50now  - ema50prev)  / ema50prev;
    const slope2 = (ema50prev - ema50prev2) / ema50prev2;

    // Consistência: slope atual forte E slope anterior na mesma direção
    const emaUpStrong   = slope1 >  0.0002 && slope2 > 0;
    const emaDownStrong = slope1 < -0.0002 && slope2 < 0;
    const slope = slope1;

    if (decision.side === 'BUY' && (price < ema50now || !emaUpStrong)) {
      log(`🚫 ${sym} BUY bloqueado — preço:${price.toFixed(4)} EMA50:${ema50now.toFixed(4)} slope:${(slope*100).toFixed(4)}%`);
      continue;
    }
    if (decision.side === 'SELL' && (price > ema50now || !emaDownStrong)) {
      log(`🚫 ${sym} SELL bloqueado — preço:${price.toFixed(4)} EMA50:${ema50now.toFixed(4)} slope:${(slope*100).toFixed(4)}%`);
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
  if (orderValue < 15) orderValue = 15; // mínimo absoluto $15
  // Cap de 8% só aplica se cap >= $15 (evita cap < mínimo)
  const capValue = balance * 0.08;
  if (capValue >= 15 && orderValue > capValue) orderValue = capValue;

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

  // Validação robusta — data pode ser null/undefined/sem code
  if (!data) {
    log(`❌ ${sym}: sem resposta da API`);
    continue;
  }
  if (data.code !== '00000') {
    log(`❌ ${sym}: ${JSON.stringify(data).slice(0, 100)}`);
    continue;
  }

  log(`🚀 ${decision.side} ${sym} @ ${price}`);
  // Cooldown: não tentar este símbolo por 60s após abrir
  TRAIL_STATE[sym] = TRAIL_STATE[sym] || {};
  TRAIL_STATE[sym].lastOpen = Date.now();
  TRAIL_STATE[sym].bots   = decision.bots;
  TRAIL_STATE[sym].regime = decision.regime; // usar no exit para trailing adaptativo
  persistTrailState();
  // Marcar se a posição ficou sem proteção na exchange
  if (data.warning) {
    TRAIL_STATE[sym].noProtection = true;
    log(`⚠️ ${sym} sem SL/TP na Bitget — modo proteção manual ativo`);
  }

  await saveTrade({ symbol: sym, side: decision.side, qty, bots: decision.bots, time: Date.now() });
  await saveEquity(balance);

  TRADES_TODAY++;
  break; // um trade por ciclo
}
```

} catch (e) {
log(`🔥 ${e.message}`);
}
};