function trendBot(closes){
  const avg = closes.slice(-20).reduce((a,b)=>a+b)/20;
  const price = closes.at(-1);

  if(price > avg) return {side:'BUY', confidence:0.7, bot:'trend'};
  if(price < avg) return {side:'SELL', confidence:0.7, bot:'trend'};

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
  const rsi = 100-(100/(1+rs));

  if(rsi<30) return {side:'BUY', confidence:0.6, bot:'rsi'};
  if(rsi>70) return {side:'SELL', confidence:0.6, bot:'rsi'};

  return null;
}

function momentumBot(closes){

  const m = (closes.at(-1)-closes.at(-5))/closes.at(-5);

  if(m>0.01) return {side:'BUY', confidence:0.6, bot:'momentum'};
  if(m<-0.01) return {side:'SELL', confidence:0.6, bot:'momentum'};

  return null;
}

module.exports = {trendBot,rsiBot,momentumBot};
