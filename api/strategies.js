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

  if (strength < 0.0035) return null; // só tendências com força real

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
  // Exige confirmação mínima: última vela tem de ir na direção esperada
  const lastClose = closes.at(-1);
  const prevClose = closes.at(-2);
  // Exige movimento real, não apenas um tick
  const recovery = prevClose > 0 ? (lastClose - prevClose) / prevClose : 0;
  if (r < 35 && recovery >  0.0005) return { side: 'BUY',  confidence: 0.5 + (35 - r) / 100, bot: 'rsi' };
  if (r > 65 && recovery < -0.0005) return { side: 'SELL', confidence: 0.5 + (r - 65) / 100, bot: 'rsi' };
  return null;
}

// ═══ 3. MOMENTUM BOT ════════════════════════════════════════
function momentumBot(closes) {
  if (closes.length < 20) return null;

  const shortAvg = closes.slice(-5).reduce((a, b) => a + b) / 5;
  const longAvg  = closes.slice(-20).reduce((a, b) => a + b) / 20;
  const mom = (shortAvg - longAvg) / longAvg;

  // Threshold reduzido de 0.002 → 0.0012:
  // volumeBot é instantâneo (vela actual), momentumBot é lento (média 5 vs 20)
  // Com 0.002 raramente coincidiam no mesmo ciclo — desalinhamento estrutural
  // 0.0012 sincroniza melhor os dois sem degradar qualidade (filtros posteriores intactos)
  if (mom >  0.0012) return { side: 'BUY',  confidence: Math.min(0.9, 0.6 + Math.abs(mom) * 20), bot: 'momentum' };
  if (mom < -0.0012) return { side: 'SELL', confidence: Math.min(0.9, 0.6 + Math.abs(mom) * 20), bot: 'momentum' };
  return null;
}

// ═══ 4. BREAKOUT BOT (suporte/resistência + confirmação volume) ════
function breakoutBot(candles) {
  // Aceita objetos {c}, arrays [ts,o,h,l,c,v] ou closes simples
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

  // Confirmação de volume — suporta objetos {v} e arrays [ts,o,h,l,c,v]
  let volConfirm = true;
  if (candles && typeof candles[0] !== 'number') {
    const getV = c => typeof c === 'object' && !Array.isArray(c)
      ? (c.v || 0) : parseFloat(c[5] || 0);
    const vols    = candles.slice(-20).map(getV);
    const avgVol  = vols.slice(0, -1).reduce((a, b) => a + b, 0) / (vols.length - 1 || 1);
    const lastVol = vols.at(-1);
    volConfirm = avgVol > 0 ? lastVol >= avgVol * 1.5 : true;
  }

  if (!volConfirm) return null; // fake breakout sem volume — ignorar

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
// Suporta candles como objetos {o,h,l,c,v} OU arrays [ts,o,h,l,c,v]
function volumeBot(candles) {
  if (!candles || candles.length < 20) return null;

  // Normalizar: extrair volume independentemente do formato
  const getV = c => typeof c === 'object' && !Array.isArray(c)
    ? (c.v || 0)
    : parseFloat(c[5] || 0);
  const getC = c => typeof c === 'object' && !Array.isArray(c)
    ? c.c
    : parseFloat(c[4] || 0);
  const getO = c => typeof c === 'object' && !Array.isArray(c)
    ? c.o
    : parseFloat(c[1] || 0);

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


// ═══ MARKET REGIME DETECTOR ════════════════════════════════
// Retorna 'TREND', 'RANGE' ou 'VOLATILE'
function detectRegime(closes) {
  if (closes.length < 50) return 'RANGE';

  const slice = closes.slice(-50);
  const e9    = ema(slice, 9);
  const e21   = ema(slice, 21);
  const e50   = ema(slice, 50);
  const price = closes.at(-1);

  // Força da tendência
  const trendStrength = Math.abs(e9 - e50) / price;

  // Volatilidade (coeficiente de variação)
  const mean = slice.reduce((a, b) => a + b) / slice.length;
  const vol  = stddev(slice) / mean;

  // Alta volatilidade → VOLATILE (cuidado)
  if (vol > 0.008) return 'VOLATILE'; // detetar volatilidade cedo

  // Tendência por estrutura de EMA (mais robusto que % change)
  // EMA alinhadas = tendência mesmo que lenta
  const emaAligned = (e9 > e21 && e21 > e50) || (e9 < e21 && e21 < e50);
  if (emaAligned && trendStrength > 0.001) return 'TREND';

  // Caso contrário → lateral
  return 'RANGE';
}

// Filtra sinais pelo regime de mercado
// Em TREND: desligar RSI e volatility (são de reversão)
// Em RANGE: desligar trend e momentum (são de continuação)
// Em VOLATILE: só entrar com alta confiança
function filterByRegime(signals, regime) {
  const filtered = { ...signals };

  if (regime === 'TREND') {
    // Mercado em tendência — reversões são perigosas
    delete filtered.rsi;
    delete filtered.volatility;
  } else if (regime === 'RANGE') {
    // Mercado lateral — seguir tendência é perigoso
    delete filtered.trend;
    delete filtered.momentum;
  } else if (regime === 'VOLATILE') {
    // Mercado volátil — filtro moderado
    // 0.75 era demasiado restritivo: apagava todos os sinais em VOLATILE
    // 0.60 mantém qualidade mínima mas permite que bots como volume participem
    // Continua a exigir 2 bots em consenso — a protecção real está aí
    Object.keys(filtered).forEach(k => {
      if (filtered[k] && filtered[k].confidence < 0.60) delete filtered[k];
    });
  }

  return filtered;
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



// ═══ EXIT BOT ═══════════════════════════════════════════════
// Decide quando sair de uma posição aberta
// pnl = PnL atual em %, timeOpen = ms, maxPnl = pico em %
function exitBot(pnl, timeOpen, maxPnl) {
  const MAX_TIME_MS = 20 * 60 * 1000; // 20 min

  // Trailing agressivo acima de 1%
  if (maxPnl >= 1.0 && pnl < maxPnl * 0.7) return 'TRAIL'; // recuo de 30%
  // Trailing normal entre 0.5% e 1%
  if (maxPnl >= 0.5 && pnl < maxPnl * 0.6) return 'TRAIL'; // recuo de 40%
  // Trailing para scalps pequenos (RANGE típico)
  if (maxPnl >= 0.25 && pnl < maxPnl * 0.65) return 'TRAIL'; // recuo de 35%

  // Trade fraca: 15min e ainda abaixo de 0.3% → libertar capital
  if (timeOpen > 18 * 60 * 1000 && pnl < 0.3 && pnl > -0.3) return 'TIME_WEAK'; // sideways 18min

  // Time stop: se passou 20min e está em lucro (mesmo pequeno) → sair
  if (timeOpen > MAX_TIME_MS && pnl > 0.2) return 'TIME';

  return null;
}

// EMA50 para uso externo no filtro de entrada
function ema50(closes) {
  if (closes.length < 50) return closes.at(-1) || 0;
  return ema(closes.slice(-50), 50);
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
