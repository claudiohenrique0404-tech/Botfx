const STRAT = require('./strategies');
const MLAPI = require('./ml-client');
const { saveTrade, saveEquity } = require('./db');
const { buildFeatures } = require('./features');
const BRAIN = require('./brain');

let LOGS=[];
let LAST_TRADE=0;

function log(m){
  const t=new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const e=`[${t}] ${m}`;
  console.log(e);
  LOGS.unshift(e);
  if(LOGS.length>150) LOGS.pop();
}

function consensus(closes){

  const signals=[
    STRAT.trendBot(closes),
    STRAT.rsiBot(closes),
    STRAT.momentumBot(closes)
  ];

  const weights = BRAIN.getWeights();

  let buy=0, sell=0, used=[];

  for(const s of signals){

    if(!s) continue;

    const w = weights[s.bot] || 0.5;

    if(s.side==='BUY') buy += s.confidence * w;
    if(s.side==='SELL') sell += s.confidence * w;

    used.push(s.bot);
  }

  log(`🧠 weights ${JSON.stringify(weights)}`);
  log(`🗳️ BUY:${buy.toFixed(2)} SELL:${sell.toFixed(2)}`);

  if(buy>0.7) return {side:'BUY', bots:used};
  if(sell>0.7) return {side:'SELL', bots:used};

  return null;
}

module.exports = async (req,res)=>{

  try{

    const base='https://botfx-blush.vercel.app';

    const settings=await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'getSettings'})
    })).json();

    if(!settings.active){
      log('⏸ off');
      return res.json({logs:LOGS});
    }

    const balanceData=await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    const balance=parseFloat(balanceData[0]?.available||0);

    const positions=await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    // ===== ENTRADAS =====
    for(const sym of settings.symbols){

      if(positions.find(p=>p.symbol===sym)) continue;

      const candles=await (await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'candles',
          symbol:sym,
          tf:'1m'
        })
      })).json();

      if(!candles.length) continue;

      const closes=candles.map(c=>+c[4]);
      const price=closes.at(-1);

      const features=buildFeatures(closes);

      const pred=await MLAPI.getPrediction(features);

      if(!pred || pred.confidence<0.7){
        log('🧠 ML block');
        continue;
      }

      const c=consensus(closes);

      if(!c){
        log('❌ no consensus');
        continue;
      }

      const now=Date.now();
      if(now-LAST_TRADE<5000) continue;

      let risk=0.01;

      if(pred.confidence>0.85) risk=0.02;

      const qty=((balance*risk)/price).toFixed(4);

      await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:sym,
          side:c.side,
          quantity:qty
        })
      });

      LAST_TRADE=Date.now();

      log(`🚀 ${c.side} ${sym}`);

      await saveTrade({
        symbol:sym,
        side:c.side,
        qty,
        bots:c.bots,
        time:Date.now(),
        features
      });

      await saveEquity(balance);

      break;
    }

    res.json({logs:LOGS});

  }catch(e){
    log(`🔥 ${e.message}`);
    res.json({logs:LOGS});
  }
};
