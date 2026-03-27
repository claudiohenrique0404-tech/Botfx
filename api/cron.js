const STRAT = require('./strategies');
const MLAPI = require('./ml-client');
const { saveTrade, saveEquity } = require('./db');

let LOGS = [];
let LAST_TRADE = 0;

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

    log(`💰 ${balance.toFixed(2)}`);

    const positions = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    for(const sym of settings.symbols){

      if(positions.find(p=>p.symbol===sym)) continue;

      log(`🔍 ${sym}`);

      const candles = await (await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'candles',
          symbol:sym,
          tf:'1m'
        })
      })).json();

      if(!candles.length){
        log('⚠️ sem dados');
        continue;
      }

      const closes = candles.map(c=>+c[4]);
      const price = closes.at(-1);

      // ===== ML FILTER
      const prediction = await MLAPI.getPrediction(closes);

      if(!prediction || prediction.confidence < 0.6){
        log('🧠 ML bloqueou');
        continue;
      }

      log(`🧠 ML ok ${prediction.confidence.toFixed(2)}`);

      const signal = STRAT.trendBot(closes);

      if(!signal){
        log('❌ sem sinal');
        continue;
      }

      const now = Date.now();
      if(now - LAST_TRADE < 8000){
        log('⏱ cooldown');
        continue;
      }

      const qty = (Math.max(5, balance*0.01)/price).toFixed(4);

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
        log(`❌ erro ordem ${data.msg}`);
        continue;
      }

      LAST_TRADE = Date.now();

      log(`🚀 ${signal.side} ${sym}`);

      await saveTrade({
        symbol:sym,
        side:signal.side,
        qty,
        time:Date.now(),
        features: closes.slice(-10)
      });

      await saveEquity(balance);

      break;
    }

    // 🔥 TREINAR AUTOMATICAMENTE
    await fetch(base+'/api/ml-train',{
      method:'POST'
    });

    res.json({logs:LOGS});

  }catch(e){
    log(`🔥 ${e.message}`);
    res.json({logs:LOGS});
  }
};
