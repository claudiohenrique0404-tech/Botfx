function ema(data, period){
  const k = 2/(period+1);
  let ema = data[0];

  for(let i=1;i<data.length;i++){
    ema = data[i]*k + ema*(1-k);
  }

  return ema;
}

function rsi(data, period=14){
  let gains=0, losses=0;

  for(let i=1;i<=period;i++){
    const diff = data[i]-data[i-1];
    if(diff>=0) gains+=diff;
    else losses-=diff;
  }

  const rs = gains/(losses||1);
  return 100 - (100/(1+rs));
}

// 🔥 TREND BOT (EMA CROSS)
function trendBot(data){

  const ema9 = ema(data.slice(-20),9);
  const ema21 = ema(data.slice(-40),21);

  if(ema9 > ema21) return { side:'BUY', confidence:0.6 };
  if(ema9 < ema21) return { side:'SELL', confidence:0.6 };

  return null;
}

// 🔥 RSI BOT
function rsiBot(data){

  const val = rsi(data.slice(-20));

  if(val < 30) return { side:'BUY', confidence:0.7 };
  if(val > 70) return { side:'SELL', confidence:0.7 };

  return null;
}

// 🔥 MOMENTUM
function momentumBot(data){

  const change = (data.at(-1)-data.at(-5))/data.at(-5);

  if(change > 0.002) return { side:'BUY', confidence:0.5 };
  if(change < -0.002) return { side:'SELL', confidence:0.5 };

  return null;
}

module.exports = { trendBot, rsiBot, momentumBot };
