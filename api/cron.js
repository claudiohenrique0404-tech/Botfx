let logs = [];
let lossStreak = 0;

function log(msg){
 logs.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
 if(logs.length>80) logs.pop();
 console.log(msg);
}

// EMA
function calcEMA(data, period){
 let k = 2/(period+1);
 let ema = data[0];
 for(let i=1;i<data.length;i++){
   ema = data[i]*k + ema*(1-k);
 }
 return ema;
}

// RSI
function calcRSI(data, period=14){
 let gains=0, losses=0;

 for(let i=data.length-period;i<data.length;i++){
   const diff = data[i]-data[i-1];
   if(diff>0) gains+=diff;
   else losses-=diff;
 }

 if(losses===0) return 100;
 let rs = gains/losses;
 return 100 - (100/(1+rs));
}

module.exports = async (req,res)=>{

 try{

  const base = 'https://' + process.env.VERCEL_URL;

  const settings = await (await fetch(base+'/api/bitget',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'getSettings'})
  })).json();

  const positions = await (await fetch(base+'/api/bitget',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'positions'})
  })).json();

  log(`📊 posições: ${positions.length}/${settings.maxPositions}`);

  if(positions.length>=settings.maxPositions){
    log('⏸ limite atingido');
    return res.json({logs});
  }

  if(lossStreak >= settings.maxLossStreak){
    log('🛑 bloqueado por perdas');
    return res.json({logs});
  }

  for(const sym of settings.symbols){

    const candles = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'candles', symbol:sym})
    })).json();

    if(!candles.length) continue;

    const closes = candles.map(c=>parseFloat(c[4]));

    const ema20 = calcEMA(closes.slice(-20),20);
    const ema50 = calcEMA(closes.slice(-50),50);
    const rsi = calcRSI(closes);

    const trendUp = ema20 > ema50;

    log(`${sym} EMA20:${ema20.toFixed(2)} EMA50:${ema50.toFixed(2)} RSI:${rsi.toFixed(1)}`);

    const last = closes[closes.length-1];

    const size = Math.max(5, 120*(settings.risk/100));
    const qty = (size/last).toFixed(4);

    // LONG
    if(trendUp && rsi < 35){
      log(`🚀 LONG ${sym}`);

      await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:sym,
          side:'BUY',
          quantity:qty
        })
      });

      break;
    }

    // SHORT
    if(!trendUp && rsi > 65){
      log(`🔻 SHORT ${sym}`);

      await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:sym,
          side:'SELL',
          quantity:qty
        })
      });

      break;
    }

    log(`❌ sem entrada ${sym}`);
  }

  return res.json({logs});

 }catch(e){
  return res.status(500).json({error:e.message});
 }

};
