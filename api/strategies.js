// strategies.js v3 — 6 bots especializados + EMA warm-up fix

// ═══ HELPERS ═══════════════════════════════════════════════
function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsiCalc(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  // Wilder's smoothed RSI (standard, compatível com plataformas de charting)
  let avgGain = 0, avgLoss = 0;

  // Primeira média: SMA dos primeiros `period` changes
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;

  // Smoothing: Wilder's method para restantes
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

// ═══ 1. TREND BOT (EMA 9/21/50) ════════════════════════════
function trendBot(closes) {
  if (closes.length < 50) return null;

  // Usar array completo para warm-up da EMA (não apenas slice(-50))
  const e9  = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const price = closes.at(-1);
  const strength = Math.abs(e9 - e21) / price;

  if (strength < 0.0050) return null; // só tendências com força real

  const confidence = Math.min(1, 0.65 + strength * 12);

  if (e9 > e21 && e21 > e50) return { side: 'BUY',  confidence, bot: 'trend' };
  if (e9 < e21 && e21 < e50) return { side: 'SELL', confidence, bot: 'trend' };
  return null;
}

// ═══ 2. RSI BOT ═════════════════════════════════════════════
function rsiBot(closes) {
  if (closes.length < 20) return null;

  const r = rsiCalc(closes);

  const lastClose = closes.at(-1);
  const prevClose = closes.at(-2);
  const recovery = prevClose > 0 ? (lastClose - prevClose) / prevClose : 0;
  if (r < 32 && recovery >  0.0015) return { side: 'BUY',  confidence: 0.5 + (35 - r) / 100, bot: 'rsi' };
  if (r > 68 && recovery < -0.0015) return { side: 'SELL', confidence: 0.5 + (r - 65) / 100, bot: 'rsi' };
  return null;
}

// ═══ 3. MOMENTUM BOT ════════════════════════════════════════
function momentumBot(closes) {
  if (closes.length < 20) return null;

  const shortAvg = closes.slice(-5).reduce((a, b) => a + b) / 5;
  const longAvg  = closes.slice(-20).reduce((a, b) => a + b) / 20;
  const mom = (shortAvg - longAvg) / longAvg;

  if (mom >  0.0018) return { side: 'BUY',  confidence: Math.min(0.9, 0.6 + Math.abs(mom) * 20), bot: 'momentum' };
  if (mom < -0.0018) return { side: 'SELL', confidence: Math.min(0.9, 0.6 + Math.abs(mom) * 20), bot: 'momentum' };
  return null;
}

// ═══ 4. BREAKOUT BOT (suporte/resistência + confirmação volume) ════
function breakoutBot(candles) {
  const closes = typeof candles[0] === 'number'
    ? candles
    : candles.map(c => Array.isArray(c) ? parseFloat(c[4]) : parseFloat(c.c || 0));

  if (closes.length < 30) return null;

  const recent  = closes.slice(-30);
  const highest = Math.max(...recent.slice(0, -1));
  const lowest  = Math.min(...recent.slice(0, -1));
  const price   = closes.at(-1);
  const range   = highest - lowest;

  if (range === 0) return null;

  // Confirmação de volume
  let volConfirm = true;
  if (candles && typeof candles[0] !== 'number') {
    const getV = c => typeof c === 'object' && !Array.isArray(c)
      ? (c.v || 0) : parseFloat(c[5] || 0);
    const vols    = candles.slice(-20).map(getV);
    const avgVol  = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1 || 1);
    const lastVol = vols.at(-1);
    volConfirm = avgVol > 0 ? lastVol >= avgVol * 1.5 : true;
  }

  if (!volConfirm) return null;

  if (price > highest) {
    const strength = (price - highest) / (range || 1);
    return { side: 'BUY', confidence: Math.min(0.85, 0.65 + strength * 5), bot: 'breakout' };
  }

  if (price < lowest) {
    const strength = (lowest - price) / (range || 1);
    return { side: 'SELL', confidence: Math.min(0.85, 0.65 + strength * 5), bot: 'breakout' };
  }

  return null;
}

// ═══ 5. VOLUME BOT ══════════════════════════════════════════
function volumeBot(candles) {
  if (!candles || candles.length < 20) return null;

  const getV = c => typeof c === 'object' && !Array.isArray(c)
    ? (c.v || 0) : parseFloat(c[5] || 0);
  const getC = c => typeof c === 'object' && !Array.isArray(c)
    ? c.c : parseFloat(c[4] || 0);
  const getO = c => typeof c === 'object' && !Array.isArray(c)
    ? c.o : parseFloat(c[1] || 0);

  const recent   = candles.slice(-20);
  const vols     = recent.map(getV);
  const avgVol   = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1 || 1);
  const lastVol  = vols.at(-1);
  const volRatio = avgVol > 0 ? lastVol / avgVol : 0;

  if (volRatio < 1.5) return null;

  const last   = candles.at(-1);
  const isBull = getC(last) >= getO(last);

  const confidence = Math.min(0.85, 0.6 + (volRatio - 1.5) * 0.1);
  return { side: isBull ? 'BUY' : 'SELL', confidence, bot: 'volume' };
}

// ═══ 6. VOLATILITY BOT (Bollinger Bands) ════════════════════
function volatilityBot(closes) {
  if (closes.length < 20) return null;

  const slice = closes.slice(-20);
  const mean  = slice.reduce((a, b) => a + b) / 20;
  const std   = stddev(slice);
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  const price = closes.at(-1);
  const bandwidth = (upper - lower) / mean;

  if (bandwidth < 0.002) return null;

  if (price <= lower) {
    return { side: 'BUY',  confidence: Math.min(0.8, 0.6 + (lower - price) / std * 0.1), bot: 'volatility' };
  }

  if (price >= upper) {
    return { side: 'SELL', confidence: Math.min(0.8, 0.6 + (price - upper) / std * 0.1), bot: 'volatility' };
  }

  return null;
}

// ═══ MARKET REGIME DETECTOR ════════════════════════════════
function detectRegime(closes) {
  if (closes.length < 50) return 'RANGE';

  // Usar array completo para warm-up
  const e9    = ema(closes, 9);
  const e21   = ema(closes, 21);
  const e50   = ema(closes, 50);
  const price = closes.at(-1);

  const trendStrength = Math.abs(e9 - e50) / price;

  // Volatilidade sobre últimos 50 candles
  const slice = closes.slice(-50);
  const mean = slice.reduce((a, b) => a + b) / slice.length;
  const vol  = stddev(slice) / mean;

  if (vol > 0.012) return 'VOLATILE';

  const emaAligned = (e9 > e21 && e21 > e50) || (e9 < e21 && e21 < e50);
  if (emaAligned && trendStrength > 0.001) return 'TREND';

  return 'RANGE';
}

// Filtra sinais pelo regime de mercado
function filterByRegime(signals, regime) {
  const filtered = { ...signals };

  if (regime === 'TREND') {
    delete filtered.rsi;
    delete filtered.volatility;
  } else if (regime === 'RANGE') {
    delete filtered.trend;
    delete filtered.momentum;
  } else if (regime === 'VOLATILE') {
    Object.keys(filtered).forEach(k => {
      if (filtered[k] && filtered[k].confidence < 0.60) delete filtered[k];
    });
  }

  return filtered;
}

// ═══ FILTRO GLOBAL ══════════════════════════════════════════
function marketFilter(closes) {
  if (closes.length < 20) return true;

  const slice = closes.slice(-20);
  const mean  = slice.reduce((a, b) => a + b) / 20;
  const vol   = stddev(slice) / mean;

  if (vol < 0.0008) return false;
  return true;
}

// ═══ FILTRO DE CONTEXTO (multi-timeframe) ═══════════════════
function contextFilter(closesHigher) {
  if (!closesHigher || closesHigher.length < 50) return 'NEUTRAL';

  // Usar array completo para warm-up
  const e9  = ema(closesHigher, 9);
  const e21 = ema(closesHigher, 21);
  const e50 = ema(closesHigher, 50);

  if (e9 > e21 && e21 > e50) return 'BUY';
  if (e9 < e21 && e21 < e50) return 'SELL';
  return 'NEUTRAL';
}

// ═══ EXIT BOT ═══════════════════════════════════════════════
function exitBot(pnl, timeOpen, maxPnl) {
  // Trailing ajustado a SL 0.8% / TP largos
  if (maxPnl >= 1.5 && pnl < maxPnl * 0.7) return 'TRAIL'; // recuo 30% de 1.5%+
  if (maxPnl >= 0.9 && pnl < maxPnl * 0.6) return 'TRAIL'; // recuo 40% de 0.9%+
  return null;
}

// EMA50 para filtro de entrada — usa array completo
function ema50(closes) {
  if (closes.length < 50) return closes.at(-1) || 0;
  return ema(closes, 50);
}

module.exports = {
  trendBot,
  rsiBot,
  momentumBot,
  breakoutBot,
  volumeBot,
  volatilityBot,
  marketFilter,
  contextFilter,
  exitBot,
  detectRegime,
  filterByRegime,
  ema50,
};
