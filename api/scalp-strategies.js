// scalp-strategies.js v2 — calibrado para 1m candles reais
// Thresholds ajustados: BTC move ~0.02-0.05% por vela 1m em mercado normal

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

function stddev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length);
}

// ═══ 1. EMA MICRO CROSS (EMA3/EMA8) ═══════════════════════
// Cross recente OU EMAs a divergir (momentum building)
function emaCrossBot(closes) {
  if (closes.length < 15) return null;

  const e3now  = ema(closes, 3);
  const e8now  = ema(closes, 8);
  const e3prev = ema(closes.slice(0, -1), 3);
  const e8prev = ema(closes.slice(0, -1), 8);

  const price  = closes.at(-1);
  const spread = Math.abs(e3now - e8now) / price;

  // Cross acabou de acontecer
  if (e3prev <= e8prev && e3now > e8now) {
    return { side: 'BUY', confidence: Math.min(0.80, 0.55 + spread * 80), bot: 'emaCross' };
  }
  if (e3prev >= e8prev && e3now < e8now) {
    return { side: 'SELL', confidence: Math.min(0.80, 0.55 + spread * 80), bot: 'emaCross' };
  }

  // EMAs já cruzadas e a divergir (momentum activo)
  const prevSpread = Math.abs(e3prev - e8prev) / price;
  if (spread > prevSpread && spread > 0.00008) {
    if (e3now > e8now) return { side: 'BUY',  confidence: Math.min(0.70, 0.50 + spread * 60), bot: 'emaCross' };
    if (e3now < e8now) return { side: 'SELL', confidence: Math.min(0.70, 0.50 + spread * 60), bot: 'emaCross' };
  }

  return null;
}

// ═══ 2. VOLUME BURST ═══════════════════════════════════════
function volumeBurstBot(candles) {
  if (!candles || candles.length < 15) return null;

  const getV = c => c.v || 0;
  const getC = c => c.c || 0;
  const getO = c => c.o || 0;

  const vols = candles.slice(-15).map(getV);
  const avgVol = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1 || 1);
  const lastVol = vols.at(-1);
  const ratio = avgVol > 0 ? lastVol / avgVol : 0;

  // 1.5x média já é relevante em 1m
  if (ratio < 1.5) return null;

  const last = candles.at(-1);
  const body = Math.abs(getC(last) - getO(last));
  const price = getC(last);

  // Corpo mínimo muito baixo — quase qualquer vela não-doji
  if (price > 0 && body / price < 0.00005) return null;

  const isBull = getC(last) > getO(last);
  const conf = Math.min(0.85, 0.55 + (ratio - 1.5) * 0.10);

  return { side: isBull ? 'BUY' : 'SELL', confidence: conf, bot: 'volumeBurst' };
}

// ═══ 3. RSI BOUNCE ═════════════════════════════════════════
// RSI(7) em extremo — zonas alargadas para 1m
function rsiBounceBot(closes) {
  if (closes.length < 15) return null;

  const rsi = rsiCalc(closes, 7);
  const last = closes.at(-1);
  const prev = closes.at(-2);
  const move = prev > 0 ? (last - prev) / prev : 0;

  // RSI < 28 + qualquer movimento bullish
  if (rsi < 28 && move > 0.00005) {
    return { side: 'BUY', confidence: Math.min(0.80, 0.50 + (28 - rsi) / 60), bot: 'rsiBounce' };
  }
  // RSI > 72 + qualquer movimento bearish
  if (rsi > 72 && move < -0.00005) {
    return { side: 'SELL', confidence: Math.min(0.80, 0.50 + (rsi - 72) / 60), bot: 'rsiBounce' };
  }

  return null;
}

// ═══ 4. MOMENTUM SPIKE ═════════════════════════════════════
// Aceleração de preço — 2 de 3 velas na mesma direcção basta
function momentumSpikeBot(closes) {
  if (closes.length < 8) return null;

  const c0 = closes.at(-1);
  const c3 = closes.at(-4);
  if (!c0 || !c3) return null;

  const roc = (c0 - c3) / c3;

  // 0.06% em 3 velas de 1m = movimento real
  if (Math.abs(roc) < 0.0006) return null;

  // Pelo menos 2 de 3 velas na mesma direcção
  const c1 = closes.at(-2);
  const c2 = closes.at(-3);
  const ups   = (c0 > c1 ? 1 : 0) + (c1 > c2 ? 1 : 0) + (c2 > c3 ? 1 : 0);
  const downs = (c0 < c1 ? 1 : 0) + (c1 < c2 ? 1 : 0) + (c2 < c3 ? 1 : 0);

  if (roc > 0 && ups >= 2) {
    return { side: 'BUY', confidence: Math.min(0.80, 0.55 + Math.abs(roc) * 40), bot: 'momentumSpike' };
  }
  if (roc < 0 && downs >= 2) {
    return { side: 'SELL', confidence: Math.min(0.80, 0.55 + Math.abs(roc) * 40), bot: 'momentumSpike' };
  }

  return null;
}

// ═══ 5. MICRO TREND ════════════════════════════════════════
// EMA 5/15 alinhadas + preço do lado certo — micro-tendência confirmada
function microTrendBot(closes) {
  if (closes.length < 20) return null;

  const e5  = ema(closes, 5);
  const e15 = ema(closes, 15);
  const price = closes.at(-1);

  // Preço acima de ambas EMAs + EMAs alinhadas
  if (price > e5 && e5 > e15) {
    const strength = (e5 - e15) / price;
    if (strength > 0.00005) {
      return { side: 'BUY', confidence: Math.min(0.75, 0.50 + strength * 100), bot: 'microTrend' };
    }
  }
  if (price < e5 && e5 < e15) {
    const strength = (e15 - e5) / price;
    if (strength > 0.00005) {
      return { side: 'SELL', confidence: Math.min(0.75, 0.50 + strength * 100), bot: 'microTrend' };
    }
  }

  return null;
}

// ═══ FILTRO SCALP ══════════════════════════════════════════
function scalpFilter(closes) {
  if (closes.length < 15) return false;

  const slice = closes.slice(-15);
  const mean = slice.reduce((a, b) => a + b) / slice.length;
  const vol = stddev(slice) / mean;

  // Muito parado → sem scalps
  if (vol < 0.00008) return false;
  // Demasiado volátil → perigoso
  if (vol > 0.006) return false;

  return true;
}

// ═══ CONSENSO SCALP ════════════════════════════════════════
function analyzeScalp(candles) {
  const closes = candles.map(c => c.c).filter(Boolean);
  if (closes.length < 20) return null;

  const signals = {
    emaCross:      emaCrossBot(closes),
    volumeBurst:   volumeBurstBot(candles),
    rsiBounce:     rsiBounceBot(closes),
    momentumSpike: momentumSpikeBot(closes),
    microTrend:    microTrendBot(closes),
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

  // 2+ bots concordantes, score total > 1.0
  if (buyCount >= 2 && buy > sell && buy > 1.0) {
    return { side: 'BUY', score: buy, bots: used, count: buyCount };
  }
  if (sellCount >= 2 && sell > buy && sell > 1.0) {
    return { side: 'SELL', score: sell, bots: used, count: sellCount };
  }

  return null;
}

module.exports = { analyzeScalp, scalpFilter };
