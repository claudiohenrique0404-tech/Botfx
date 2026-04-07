// scalp-strategies.js v3 — scalping optimizado
// VWAP, ATR dinâmico, candle patterns, filtro horário, confirmação 5m

// ═══ HELPERS ═══════════════════════════════════════════════
function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsiCalc(closes, period = 7) {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// ═══ VWAP + BANDAS ═════════════════════════════════════════
// Referência institucional — preço a reverter para VWAP é alta probabilidade
function calcVWAP(candles) {
  let cumTPV = 0, cumVol = 0;
  const vwapPoints = [];

  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3; // typical price
    cumTPV += tp * c.v;
    cumVol += c.v;
    vwapPoints.push(cumVol > 0 ? cumTPV / cumVol : tp);
  }

  const vwap = vwapPoints.at(-1) || 0;

  // Bandas de desvio (similar a Bollinger mas sobre VWAP)
  const deviations = candles.map((c, i) => {
    const tp = (c.h + c.l + c.c) / 3;
    return Math.pow(tp - (vwapPoints[i] || vwap), 2);
  });
  const variance = deviations.reduce((a, b) => a + b, 0) / deviations.length;
  const stddev = Math.sqrt(variance);

  return { vwap, upper: vwap + 1.5 * stddev, lower: vwap - 1.5 * stddev, stddev };
}

function vwapBot(candles) {
  if (!candles || candles.length < 20) return null;

  const { vwap, upper, lower, stddev } = calcVWAP(candles.slice(-30));
  const price = candles.at(-1).c;
  const prev  = candles.at(-2).c;

  if (vwap === 0 || stddev === 0) return null;

  // Preço tocou banda inferior e está a subir → BUY (reversão para VWAP)
  if (price <= lower && price > prev) {
    const dist = (vwap - price) / price; // distância até VWAP em %
    return { side: 'BUY', confidence: Math.min(0.85, 0.55 + dist * 20), bot: 'vwap' };
  }

  // Preço tocou banda superior e está a descer → SELL
  if (price >= upper && price < prev) {
    const dist = (price - vwap) / price;
    return { side: 'SELL', confidence: Math.min(0.85, 0.55 + dist * 20), bot: 'vwap' };
  }

  // Preço cruzou VWAP com momentum → continuação
  if (prev < vwap && price > vwap && price - prev > stddev * 0.3) {
    return { side: 'BUY', confidence: Math.min(0.75, 0.50 + (price - vwap) / stddev * 0.15), bot: 'vwap' };
  }
  if (prev > vwap && price < vwap && prev - price > stddev * 0.3) {
    return { side: 'SELL', confidence: Math.min(0.75, 0.50 + (vwap - price) / stddev * 0.15), bot: 'vwap' };
  }

  return null;
}

// ═══ ATR (Average True Range) ══════════════════════════════
// Usado para SL/TP dinâmico — adapta à volatilidade actual
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;

  let atr = 0;
  for (let i = 1; i <= period; i++) {
    const h = candles[i].h;
    const l = candles[i].l;
    const pc = candles[i - 1].c;
    atr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  atr /= period;

  // Smoothing Wilder's
  for (let i = period + 1; i < candles.length; i++) {
    const h = candles[i].h;
    const l = candles[i].l;
    const pc = candles[i - 1].c;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    atr = (atr * (period - 1) + tr) / period;
  }

  return atr;
}

// ═══ CANDLE PATTERNS ═══════════════════════════════════════
// Engulfing e pin bars — sinais fortes de reversão imediata no 1m
function candlePatternBot(candles) {
  if (!candles || candles.length < 5) return null;

  const curr = candles.at(-1);
  const prev = candles.at(-2);

  const currBody = Math.abs(curr.c - curr.o);
  const prevBody = Math.abs(prev.c - prev.o);
  const currRange = curr.h - curr.l;
  const price = curr.c;

  if (currRange === 0 || price === 0) return null;

  // ── Bullish Engulfing ──
  // Vela anterior bearish, vela actual bullish que engole a anterior
  if (prev.c < prev.o && curr.c > curr.o && curr.c > prev.o && curr.o < prev.c && currBody > prevBody) {
    const strength = currBody / currRange; // corpo grande vs range = forte
    return { side: 'BUY', confidence: Math.min(0.80, 0.55 + strength * 0.3), bot: 'pattern' };
  }

  // ── Bearish Engulfing ──
  if (prev.c > prev.o && curr.c < curr.o && curr.c < prev.o && curr.o > prev.c && currBody > prevBody) {
    const strength = currBody / currRange;
    return { side: 'SELL', confidence: Math.min(0.80, 0.55 + strength * 0.3), bot: 'pattern' };
  }

  // ── Hammer (bullish pin bar) ──
  // Corpo pequeno no topo, sombra inferior longa (>2x corpo)
  const upperWick = curr.h - Math.max(curr.o, curr.c);
  const lowerWick = Math.min(curr.o, curr.c) - curr.l;

  if (currBody > 0 && lowerWick > currBody * 2 && upperWick < currBody * 0.5) {
    // Confirmar: velas anteriores estavam a descer
    if (candles.at(-3).c > candles.at(-2).c) {
      return { side: 'BUY', confidence: Math.min(0.75, 0.55 + lowerWick / currRange * 0.25), bot: 'pattern' };
    }
  }

  // ── Shooting Star (bearish pin bar) ──
  if (currBody > 0 && upperWick > currBody * 2 && lowerWick < currBody * 0.5) {
    if (candles.at(-3).c < candles.at(-2).c) {
      return { side: 'SELL', confidence: Math.min(0.75, 0.55 + upperWick / currRange * 0.25), bot: 'pattern' };
    }
  }

  return null;
}

// ═══ VOLUME BURST ══════════════════════════════════════════
function volumeBurstBot(candles) {
  if (!candles || candles.length < 15) return null;

  const vols = candles.slice(-15).map(c => c.v);
  const avgVol = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1 || 1);
  const lastVol = vols.at(-1);
  const ratio = avgVol > 0 ? lastVol / avgVol : 0;

  if (ratio < 1.5) return null;

  const last = candles.at(-1);
  const body = Math.abs(last.c - last.o);
  if (last.c === 0 || body / last.c < 0.00005) return null;

  const isBull = last.c > last.o;
  const conf = Math.min(0.85, 0.55 + (ratio - 1.5) * 0.10);

  return { side: isBull ? 'BUY' : 'SELL', confidence: conf, bot: 'volumeBurst' };
}

// ═══ MOMENTUM SPIKE (ATR-relative) ═════════════════════════
// Movimento relativo ao ATR em vez de % fixo — adapta à volatilidade
function momentumSpikeBot(candles) {
  if (!candles || candles.length < 20) return null;

  const atr = calcATR(candles.slice(-20));
  if (atr === 0) return null;

  const c0 = candles.at(-1).c;
  const c3 = candles.at(-4).c;
  const move = c0 - c3;

  // Movimento > 0.8 ATR em 3 candles = spike significativo
  if (Math.abs(move) < atr * 0.8) return null;

  // Consistência: pelo menos 2 de 3 velas na mesma direcção
  const c1 = candles.at(-2).c;
  const c2 = candles.at(-3).c;
  const ups   = (c0 > c1 ? 1 : 0) + (c1 > c2 ? 1 : 0) + (c2 > c3 ? 1 : 0);
  const downs = (c0 < c1 ? 1 : 0) + (c1 < c2 ? 1 : 0) + (c2 < c3 ? 1 : 0);

  const atrRatio = Math.abs(move) / atr;
  const conf = Math.min(0.80, 0.55 + (atrRatio - 0.8) * 0.25);

  if (move > 0 && ups >= 2) return { side: 'BUY', confidence: conf, bot: 'momentum' };
  if (move < 0 && downs >= 2) return { side: 'SELL', confidence: conf, bot: 'momentum' };

  return null;
}

// ═══ TREND 5M (confirmação de timeframe superior) ══════════
// Não é um sinal de entrada — é um filtro de direcção
function get5mBias(candles5m) {
  if (!candles5m || candles5m.length < 20) return 'NEUTRAL';

  const closes = candles5m.map(c => c.c).filter(Boolean);
  if (closes.length < 20) return 'NEUTRAL';

  const e5  = ema(closes, 5);
  const e15 = ema(closes, 15);
  const price = closes.at(-1);

  if (price > e5 && e5 > e15) return 'BUY';
  if (price < e5 && e5 < e15) return 'SELL';
  return 'NEUTRAL';
}

// ═══ FILTRO HORÁRIO ════════════════════════════════════════
// Só scalpar em horas de alto volume (sessões activas)
function isActiveHours() {
  const hour = new Date().getUTCHours();
  // London open (07:00) até NY close (21:00 UTC) — 14h de janela
  // Pico: 13:00-17:00 (overlap London/NY)
  return hour >= 7 && hour <= 21;
}

function isPeakHours() {
  const hour = new Date().getUTCHours();
  return hour >= 13 && hour <= 17;
}

// ═══ FILTRO SCALP ══════════════════════════════════════════
function scalpFilter(candles) {
  if (!candles || candles.length < 15) return false;

  const atr = calcATR(candles.slice(-15), 10);
  const price = candles.at(-1).c;
  if (price === 0 || atr === 0) return false;

  const atrPct = atr / price;

  // Muito parado (ATR < 0.01% do preço) → sem scalps
  if (atrPct < 0.0001) return false;
  // Demasiado volátil (ATR > 0.5%) → perigoso
  if (atrPct > 0.005) return false;

  return true;
}

// ═══ SL/TP DINÂMICO (ATR-based) ═══════════════════════════
// Retorna {slPct, tpPct} adaptados à volatilidade actual
function calcDynamicSLTP(candles) {
  const atr = calcATR(candles.slice(-20));
  const price = candles.at(-1).c;
  if (price === 0 || atr === 0) return { slPct: 0.0020, tpPct: 0.0050 }; // fallback fixo

  const atrPct = atr / price;

  // SL = 1.2 ATR, TP = 2.5 ATR
  // Mínimos garantem que TP cobre fees mesmo em mercado calmo
  const slPct = Math.max(0.0015, Math.min(0.0035, atrPct * 1.2));  // 0.15% — 0.35%
  const FEES = 0.0012;
  const EDGE = 0.0006;

  const MIN_TP = FEES + EDGE; // 0.18%

  const tpPct = Math.max(MIN_TP, Math.min(0.010, atrPct * 3));  // 0.40% — 0.80%

  return { slPct, tpPct };
}

// ═══ CONSENSO SCALP ════════════════════════════════════════
function analyzeScalp(candles1m, candles5m) {
  if (!candles1m || candles1m.length < 20) return null;

  // Sem filtro horário — crypto é 24/7, VWAP e volume filtram naturalmente

  // Sinais 1m
  const signals = {
    vwap:        vwapBot(candles1m),
    pattern:     candlePatternBot(candles1m),
    volumeBurst: volumeBurstBot(candles1m),
    momentum:    momentumSpikeBot(candles1m),
  };

  let buy = 0, sell = 0, used = [];

  for (const k in signals) {
    const s = signals[k];
    if (!s) continue;
    if (s.side === 'BUY')  buy  += s.confidence;
    if (s.side === 'SELL') sell += s.confidence;
    used.push(k);
  }

  const buyCount  = Object.values(signals).filter(s => s && s.side === 'BUY').length;
  const sellCount = Object.values(signals).filter(s => s && s.side === 'SELL').length;

  // Mínimo 2 bots concordantes
  let side = null, score = 0, count = 0;
  if (buyCount >= 2 && buy > sell && buy > 1.0) {
    side = 'BUY'; score = buy; count = buyCount;
  } else if (sellCount >= 2 && sell > buy && sell > 1.0) {
    side = 'SELL'; score = sell; count = sellCount;
  }

  if (!side) return null;

  // Filtro 5m: não entrar contra a tendência do timeframe superior
  const bias5m = get5mBias(candles5m);
  if (bias5m !== 'NEUTRAL' && bias5m !== side) {
    return { skip: true, reason: `5m contra (${bias5m})` };
  }

  // Boost de confiança durante peak hours
  if (isPeakHours()) score *= 1.1;

  // SL/TP dinâmico baseado no ATR actual
  const { slPct, tpPct } = calcDynamicSLTP(candles1m);

  return { side, score, bots: used, count, slPct, tpPct };
}

module.exports = { analyzeScalp, scalpFilter, calcATR };
