// scalp-strategies.js — sinais de scalping para 1m candles
// Optimizados para entradas rápidas com SL/TP apertados

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
// Detecta micro-tendências muito cedo
function emaCrossBot(closes) {
  if (closes.length < 20) return null;

  const e3now  = ema(closes, 3);
  const e8now  = ema(closes, 8);
  const e3prev = ema(closes.slice(0, -1), 3);
  const e8prev = ema(closes.slice(0, -1), 8);

  const price = closes.at(-1);
  const spread = Math.abs(e3now - e8now) / price;

  // Cross acabou de acontecer (ou está muito recente)
  if (e3prev <= e8prev && e3now > e8now && spread > 0.0002) {
    return { side: 'BUY', confidence: Math.min(0.85, 0.60 + spread * 50), bot: 'emaCross' };
  }
  if (e3prev >= e8prev && e3now < e8now && spread > 0.0002) {
    return { side: 'SELL', confidence: Math.min(0.85, 0.60 + spread * 50), bot: 'emaCross' };
  }

  return null;
}

// ═══ 2. VOLUME BURST ═══════════════════════════════════════
// Volume spike com direcção clara — indica movimento institucional
function volumeBurstBot(candles) {
  if (!candles || candles.length < 15) return null;

  const getV = c => c.v || 0;
  const getC = c => c.c || 0;
  const getO = c => c.o || 0;

  const vols = candles.slice(-15).map(getV);
  const avgVol = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1 || 1);
  const lastVol = vols.at(-1);
  const ratio = avgVol > 0 ? lastVol / avgVol : 0;

  // Volume > 2.5x média — spike significativo
  if (ratio < 2.5) return null;

  const last = candles.at(-1);
  const body = Math.abs(getC(last) - getO(last));
  const price = getC(last);

  // Vela tem de ter corpo real (não doji)
  if (body / price < 0.0003) return null;

  const isBull = getC(last) > getO(last);
  const conf = Math.min(0.90, 0.60 + (ratio - 2.5) * 0.08);

  return { side: isBull ? 'BUY' : 'SELL', confidence: conf, bot: 'volumeBurst' };
}

// ═══ 3. RSI EXTREME BOUNCE ═════════════════════════════════
// RSI(7) em extremo com vela de reversão — scalp contra-tendência
function rsiBounceBot(closes) {
  if (closes.length < 15) return null;

  const rsi = rsiCalc(closes, 7);
  const last = closes.at(-1);
  const prev = closes.at(-2);
  const move = prev > 0 ? (last - prev) / prev : 0;

  // RSI < 18 + vela bullish = bounce
  if (rsi < 18 && move > 0.0003) {
    return { side: 'BUY', confidence: Math.min(0.80, 0.55 + (18 - rsi) / 50), bot: 'rsiBounce' };
  }
  // RSI > 82 + vela bearish = bounce
  if (rsi > 82 && move < -0.0003) {
    return { side: 'SELL', confidence: Math.min(0.80, 0.55 + (rsi - 82) / 50), bot: 'rsiBounce' };
  }

  return null;
}

// ═══ 4. MOMENTUM SPIKE ═════════════════════════════════════
// Aceleração de preço nas últimas 3 velas — momentum puro
function momentumSpikeBot(closes) {
  if (closes.length < 10) return null;

  const c0 = closes.at(-1);
  const c3 = closes.at(-4);
  if (!c0 || !c3) return null;

  const roc = (c0 - c3) / c3; // rate of change 3 candles

  // Precisa de movimento mínimo para ser scalp-worthy
  if (Math.abs(roc) < 0.0015) return null;

  // Consistência: as 3 velas têm de ir na mesma direcção
  const c1 = closes.at(-2);
  const c2 = closes.at(-3);
  const allUp   = c0 > c1 && c1 > c2 && c2 > c3;
  const allDown = c0 < c1 && c1 < c2 && c2 < c3;

  if (!allUp && !allDown) return null;

  const conf = Math.min(0.85, 0.60 + Math.abs(roc) * 30);
  return { side: allUp ? 'BUY' : 'SELL', confidence: conf, bot: 'momentumSpike' };
}

// ═══ 5. BOLLINGER SQUEEZE BREAKOUT ═════════════════════════
// Volatilidade comprime e depois expande — entrada no breakout
function squeezeBot(closes) {
  if (closes.length < 25) return null;

  const recent = closes.slice(-20);
  const older  = closes.slice(-25, -5);

  const bwRecent = stddev(recent) / (recent.reduce((a, b) => a + b) / recent.length);
  const bwOlder  = stddev(older) / (older.reduce((a, b) => a + b) / older.length);

  // Squeeze: volatilidade actual > volatilidade anterior (expansão)
  // Mas a anterior tem de ter sido baixa (squeeze verdadeiro)
  if (bwOlder > 0.002 || bwRecent < bwOlder * 1.5) return null;

  const price = closes.at(-1);
  const mean  = recent.reduce((a, b) => a + b) / recent.length;

  // Direcção: preço acima da média = bullish breakout
  if (price > mean) {
    return { side: 'BUY', confidence: Math.min(0.80, 0.60 + (bwRecent / bwOlder - 1.5) * 0.2), bot: 'squeeze' };
  }
  if (price < mean) {
    return { side: 'SELL', confidence: Math.min(0.80, 0.60 + (bwRecent / bwOlder - 1.5) * 0.2), bot: 'squeeze' };
  }

  return null;
}

// ═══ FILTRO SCALP ══════════════════════════════════════════
// Mercado tem de ter movimento mínimo (sem flat) mas não demasiado (sem crash)
function scalpFilter(closes) {
  if (closes.length < 15) return false;

  const slice = closes.slice(-15);
  const mean = slice.reduce((a, b) => a + b) / slice.length;
  const vol = stddev(slice) / mean;

  // Muito parado (< 0.02% CV) → sem scalps
  if (vol < 0.0002) return false;
  // Demasiado volátil (> 0.5% CV) → perigoso para scalps apertados
  if (vol > 0.005) return false;

  return true;
}

// ═══ CONSENSO SCALP ════════════════════════════════════════
function analyzeScalp(candles) {
  const closes = candles.map(c => c.c).filter(Boolean);
  if (closes.length < 25) return null;

  const signals = {
    emaCross:      emaCrossBot(closes),
    volumeBurst:   volumeBurstBot(candles),
    rsiBounce:     rsiBounceBot(closes),
    momentumSpike: momentumSpikeBot(closes),
    squeeze:       squeezeBot(closes),
  };

  let buy = 0, sell = 0, used = [];

  for (const k in signals) {
    const s = signals[k];
    if (!s) continue;
    if (s.side === 'BUY')  buy  += s.confidence;
    if (s.side === 'SELL') sell += s.confidence;
    used.push(k);
  }

  // Mínimo 2 sinais concordantes
  const buyCount  = Object.values(signals).filter(s => s && s.side === 'BUY').length;
  const sellCount = Object.values(signals).filter(s => s && s.side === 'SELL').length;

  if (buyCount >= 2 && buy > sell && buy > 0.90) {
    return { side: 'BUY', score: buy, bots: used, count: buyCount };
  }
  if (sellCount >= 2 && sell > buy && sell > 0.90) {
    return { side: 'SELL', score: sell, bots: used, count: sellCount };
  }

  return null;
}

module.exports = { analyzeScalp, scalpFilter };
