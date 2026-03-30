// strategies.js v2 — 6 bots especializados

// ═══ HELPERS ═══════════════════════════════════════════════
function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsiCalc(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  return 100 - (100 / (1 + g / (l || 0.001)));
}

function atr(closes, highs, lows, period = 14) {
  if (!highs || !lows) {
    // fallback sem H/L — usa só closes
    const s = closes.slice(-period);
    let sum = 0;
    for (let i = 1; i < s.length; i++) sum += Math.abs(s[i] - s[i - 1]);
    return sum / (s.length - 1 || 1);
  }
  const s = closes.slice(-period);
  let sum = 0;
  for (let i = 1; i < s.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );
    sum += tr;
  }
  return sum / (s.length - 1 || 1);
}

function stddev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length);
}

// ═══ 1. TREND BOT (EMA 9/21/50) ════════════════════════════
function trendBot(closes) {
  if (closes.length < 50) return null;

  const e9  = ema(closes.slice(-50), 9);
  const e21 = ema(closes.slice(-50), 21);
  const e50 = ema(closes.slice(-50), 50);
  const price = closes.at(-1);
  const strength = Math.abs(e9 - e21) / price;

  if (strength < 0.001) return null;

  const confidence = Math.min(1, 0.65 + strength * 12);

  if (e9 > e21 && e21 > e50) return { side: 'BUY',  confidence, bot: 'trend' };
  if (e9 < e21 && e21 < e50) return { side: 'SELL', confidence, bot: 'trend' };
  return null;
}

// ═══ 2. RSI BOT ═════════════════════════════════════════════
function rsiBot(closes) {
  if (closes.length < 20) return null;

  const r = rsiCalc(closes);

  // Confiança proporcional ao extremo do RSI
  if (r < 35) return { side: 'BUY',  confidence: 0.5 + (35 - r) / 100, bot: 'rsi' };
  if (r > 65) return { side: 'SELL', confidence: 0.5 + (r - 65) / 100, bot: 'rsi' };
  return null;
}

// ═══ 3. MOMENTUM BOT ════════════════════════════════════════
function momentumBot(closes) {
  if (closes.length < 20) return null;

  const shortAvg = closes.slice(-5).reduce((a, b) => a + b) / 5;
  const longAvg  = closes.slice(-20).reduce((a, b) => a + b) / 20;
  const mom = (shortAvg - longAvg) / longAvg;

  if (mom >  0.002) return { side: 'BUY',  confidence: Math.min(0.9, 0.6 + Math.abs(mom) * 20), bot: 'momentum' };
  if (mom < -0.002) return { side: 'SELL', confidence: Math.min(0.9, 0.6 + Math.abs(mom) * 20), bot: 'momentum' };
  return null;
}

// ═══ 4. BREAKOUT BOT (suporte/resistência) ══════════════════
function breakoutBot(closes) {
  if (closes.length < 30) return null;

  const recent   = closes.slice(-30);
  const highest  = Math.max(...recent.slice(0, -1)); // exclui última vela
  const lowest   = Math.min(...recent.slice(0, -1));
  const price    = closes.at(-1);
  const range    = highest - lowest;

  if (range === 0) return null;

  const posInRange = (price - lowest) / range;

  // Breakout para cima — preço saiu acima da resistência
  if (price > highest) {
    const strength = (price - highest) / (range || 1);
    return { side: 'BUY', confidence: Math.min(0.85, 0.6 + strength * 5), bot: 'breakout' };
  }

  // Breakout para baixo — preço saiu abaixo do suporte
  if (price < lowest) {
    const strength = (lowest - price) / (range || 1);
    return { side: 'SELL', confidence: Math.min(0.85, 0.6 + strength * 5), bot: 'breakout' };
  }

  return null;
}

// ═══ 5. VOLUME BOT ══════════════════════════════════════════
// Recebe candles completos [{o,h,l,c,v}] em vez de só closes
function volumeBot(candles) {
  if (!candles || candles.length < 20) return null;

  const recent  = candles.slice(-20);
  const avgVol  = recent.slice(0, -1).reduce((a, c) => a + (c.v || 0), 0) / 19;
  const lastVol = candles.at(-1).v || 0;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

  // Volume tem de ser pelo menos 1.5x a média para ser relevante
  if (volRatio < 1.5) return null;

  const last  = candles.at(-1);
  const isBull = (last.c || last[4]) > (last.o || last[1]);

  // Volume alto + vela direcional
  const confidence = Math.min(0.85, 0.6 + (volRatio - 1.5) * 0.1);
  return {
    side: isBull ? 'BUY' : 'SELL',
    confidence,
    bot: 'volume'
  };
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

  // Não entra em mercado sem volatilidade
  if (bandwidth < 0.002) return null;

  // Preço toca banda inferior → possível reversão BUY
  if (price <= lower) {
    return { side: 'BUY',  confidence: Math.min(0.8, 0.6 + (lower - price) / std * 0.1), bot: 'volatility' };
  }

  // Preço toca banda superior → possível reversão SELL
  if (price >= upper) {
    return { side: 'SELL', confidence: Math.min(0.8, 0.6 + (price - upper) / std * 0.1), bot: 'volatility' };
  }

  return null;
}

// ═══ FILTRO GLOBAL ══════════════════════════════════════════
function marketFilter(closes) {
  if (closes.length < 20) return true;

  // Volume de movimento mínimo (evita mercado morto)
  const slice = closes.slice(-20);
  const mean  = slice.reduce((a, b) => a + b) / 20;
  const vol   = stddev(slice) / mean; // coeficiente de variação

  if (vol < 0.0003) return false;

  return true;
}

// ═══ FILTRO DE CONTEXTO (multi-timeframe) ═══════════════════
// Recebe closes do timeframe maior (5m ou 15m)
// Retorna 'BUY', 'SELL' ou 'NEUTRAL'
function contextFilter(closesHigher) {
  if (!closesHigher || closesHigher.length < 50) return 'NEUTRAL';

  const e9  = ema(closesHigher.slice(-50), 9);
  const e21 = ema(closesHigher.slice(-50), 21);
  const e50 = ema(closesHigher.slice(-50), 50);

  if (e9 > e21 && e21 > e50) return 'BUY';
  if (e9 < e21 && e21 < e50) return 'SELL';
  return 'NEUTRAL';
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
};
