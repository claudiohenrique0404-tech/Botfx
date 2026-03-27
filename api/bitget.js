const STRAT = require('./strategies');
const ML = require('./ml');
const { saveTrade, saveEquity } = require('./db');

let LOGS = [];

function log(msg){
  const time = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const entry = `[${time}] ${msg}`;
  console.log(entry);

  LOGS.unshift(entry);
  if(LOGS.length > 100) LOGS.pop();
}

module.exports = async (req,res)=>{

  try{

    const base = 'https://botfx-blush.vercel.app';

    const settings = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'getSettings'})
    })).json();

    if(!settings.active){
      log('⏸ Bot desligado');
      return res.json({logs:LOGS});
    }

    const balanceData = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    const balance = parseFloat(balanceData[0]?.available || 0);

    log(`💰 ${balance}`);

    for(const sym of settings.symbols){

      const candles = await (await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'candles',symbol:sym,tf:'1m'})
      })).json();

      if(!candles.length) continue;

      const closes = candles.map(c=>+c[4]);

      const best = ML.optimize(closes);

      if(best.winrate < 0.5){
        log('🧠 ML bloqueou');
        continue;
      }

      const signal = STRAT.trendBot(closes);
      if(!signal) continue;

      const qty = (Math.max(5, balance*0.01)/closes.at(-1)).toFixed(4);

      const r = await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:sym,
          side:signal.side,
          quantity:qty
        })
      });

      const data = await r.json();

      if(data.code !== '00000'){
        log('❌ erro ordem');
        continue;
      }

      log(`✅ ${signal.side} ${sym}`);

      await saveTrade({symbol:sym,side:signal.side,qty,time:Date.now()});
      await saveEquity(balance);

      break;
    }

    res.json({logs:LOGS});

  }catch(e){
    log(e.message);
    res.json({logs:LOGS});
  }
};
