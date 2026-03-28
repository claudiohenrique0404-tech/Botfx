function ema(values, period){
  const k = 2/(period+1);
  let ema = values[0];

  for(let i=1;i<values.length;i++){
    ema = values[i]*k + ema*(1-k);
  }

  return ema;
}

function rsi(values, period=14){
  let gains = 0;
  let losses = 0;

  for(let i=values.length-period;i<values.length;i++){
    const diff = values[i] - values[i-1];
    if(diff >= 0) gains += diff;
    else losses -= diff;
  }

  const rs = gains / (losses || 1);
  return 100 - (100 / (1 + rs));
}

function volatility(values){
  const mean = values.reduce((a,b)=>a+b)/values.length;
  const variance = values.reduce((a,b)=>a + Math.pow(b-mean,2),0)/values.length;
  return Math.sqrt(variance);
}

function momentum(values){
  return (values.at(-1) - values[0]) / values[0];
}

function buildFeatures(closes){

  const ema9 = ema(closes.slice(-20),9);
  const ema21 = ema(closes.slice(-20),21);
  const rsi14 = rsi(closes,14);
  const vol = volatility(closes.slice(-20));
  const mom = momentum(closes.slice(-10));

  return [
    closes.at(-1),     // preço atual
    ema9,
    ema21,
    ema9 - ema21,      // tendência
    rsi14,
    vol,
    mom
  ];
}

module.exports = { buildFeatures };
