// ===== HELPERS =====
function ema(values, period){
  const k = 2/(period+1);
  let ema = values[0];

  for(let i=1;i<values.length;i++){
    ema = values[i]*k + ema*(1-k);
  }

  return ema;
}

function volatility(values){
  const mean = values.reduce((a,b)=>a+b)/values.length;
  const variance = values.reduce((a,b)=>a + Math.pow(b-mean,2),0)/values.length;
  return Math.sqrt(variance);
}

// ===== TREND BOT =====
function trendBot(closes){

  if(closes.length < 50) return null;

  const recent = closes.slice(-50);

  const ema9 = ema(recent, 9);
  const ema21 = ema(recent, 21);
  const ema50 = ema(recent, 50);

  const price = closes.at(-1);

  const strength = Math.abs(ema9 - ema21) / price;

  // 🔥 menos restritivo
  if(strength < 0.001) return null;

  let confidence = Math.min(1, 0.7 + strength * 10);

  if(ema9 > ema21 && ema21 > ema50){
    return { side:'BUY', confidence, bot:'trend' };
  }

  if(ema9 < ema21 && ema21 < ema50){
    return { side:'SELL', confidence, bot:'trend' };
  }

  return null;
}

// ===== RSI BOT =====
function rsiBot(closes){

  if(closes.length < 20) return null;

  let gains = 0, losses = 0;

  for(let i=closes.length-14;i<closes.length;i++){
    const d = closes[i] - closes[i-1];
    if(d >= 0) gains += d;
    else losses -= d;
  }

  const rs = gains/(losses || 1);
  const rsi = 100 - (100 / (1 + rs));

  if(rsi < 35){
    return { side:'BUY', confidence:0.55, bot:'rsi' };
  }

  if(rsi > 65){
    return { side:'SELL', confidence:0.55, bot:'rsi' };
  }

  return null;
}

// ===== MOMENTUM BOT =====
function momentumBot(closes){

  if(closes.length < 20) return null;

  const short = closes.slice(-5);
  const long = closes.slice(-20);

  const shortAvg = short.reduce((a,b)=>a+b)/short.length;
  const longAvg = long.reduce((a,b)=>a+b)/long.length;

  const momentum = (shortAvg - longAvg) / longAvg;

  // 🔥 menos restritivo
  if(momentum > 0.002){
    return { side:'BUY', confidence:0.65, bot:'momentum' };
  }

  if(momentum < -0.002){
    return { side:'SELL', confidence:0.65, bot:'momentum' };
  }

  return null;
}

// ===== FILTRO GLOBAL =====
function marketFilter(closes){
  if(closes.length < 20) return true;

  const vol = volatility(closes.slice(-20));

  // 🔥 menos restritivo
  if(vol < 0.0003) return false;

  return true;
}

module.exports = {
  trendBot,
  rsiBot,
  momentumBot,
  marketFilter
};
