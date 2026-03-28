function trendBot(closes){

  if(closes.length < 50) return null;

  const ema = (arr, period) => {
    const k = 2/(period+1);
    let e = arr[0];
    for(let i=1;i<arr.length;i++){
      e = arr[i]*k + e*(1-k);
    }
    return e;
  };

  const ema20 = ema(closes.slice(-50), 20);
  const ema50 = ema(closes.slice(-50), 50);

  const price = closes.at(-1);

  const strength = Math.abs(ema20 - ema50) / price;

  if(strength < 0.002) return null;

  const conf = Math.min(1, 0.8 + strength*5);

  if(ema20 > ema50){
    return { side:'BUY', confidence: conf, bot:'trend' };
  }

  if(ema20 < ema50){
    return { side:'SELL', confidence: conf, bot:'trend' };
  }

  return null;
}

function rsiBot(closes){

  if(closes.length < 15) return null;

  let gains=0, losses=0;

  for(let i=closes.length-14;i<closes.length;i++){
    const d = closes[i]-closes[i-1];
    if(d>=0) gains+=d;
    else losses-=d;
  }

  const rs = gains/(losses||1);
  const rsi = 100-(100/(1+rs));

  if(rsi<30) return {side:'BUY', confidence:0.6, bot:'rsi'};
  if(rsi>70) return {side:'SELL', confidence:0.6, bot:'rsi'};

  return null;
}

function momentumBot(closes){

  if(closes.length < 6) return null;

  const m = (closes.at(-1)-closes.at(-5))/closes.at(-5);

  if(m>0.01) return {side:'BUY', confidence:0.6, bot:'momentum'};
  if(m<-0.01) return {side:'SELL', confidence:0.6, bot:'momentum'};

  return null;
}

module.exports = {trendBot,rsiBot,momentumBot};
