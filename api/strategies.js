function ema(data, period){
  const k = 2/(period+1);
  let val = data[0];

  for(let i=1;i<data.length;i++){
    val = data[i]*k + val*(1-k);
  }

  return val;
}

function trendBot(data){

  if(data.length < 50) return null;

  const ema9 = ema(data.slice(-20),9);
  const ema21 = ema(data.slice(-40),21);

  if(ema9 > ema21) return { side:'BUY', confidence:0.6 };
  if(ema9 < ema21) return { side:'SELL', confidence:0.6 };

  return null;
}

function rsiBot(data){
  return null; // simplificado (evita erro)
}

function momentumBot(data){
  return null; // simplificado
}

module.exports = { trendBot, rsiBot, momentumBot };
