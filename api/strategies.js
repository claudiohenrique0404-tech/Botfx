function trendBot(closes){

  const ema = (arr,p)=>{
    const k=2/(p+1);
    let e=arr[0];
    for(let i=1;i<arr.length;i++){
      e = arr[i]*k + e*(1-k);
    }
    return e;
  };

  const ema9 = ema(closes.slice(-20),9);
  const ema21 = ema(closes.slice(-20),21);

  if(ema9 > ema21) return {side:'BUY', confidence:0.7};
  if(ema9 < ema21) return {side:'SELL', confidence:0.7};

  return null;
}

function rsiBot(closes){

  let gains=0, losses=0;

  for(let i=closes.length-14;i<closes.length;i++){
    const d = closes[i]-closes[i-1];
    if(d>=0) gains+=d;
    else losses-=d;
  }

  const rs = gains/(losses||1);
  const rsi = 100 - (100/(1+rs));

  if(rsi < 30) return {side:'BUY', confidence:0.6};
  if(rsi > 70) return {side:'SELL', confidence:0.6};

  return null;
}

function momentumBot(closes){

  const m = (closes.at(-1)-closes.at(-5))/closes.at(-5);

  if(m > 0.01) return {side:'BUY', confidence:0.6};
  if(m < -0.01) return {side:'SELL', confidence:0.6};

  return null;
}

module.exports = {
  trendBot,
  rsiBot,
  momentumBot
};
