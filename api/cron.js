const STRAT = require('./strategies');
const MLAPI = require('./ml-client');
const { saveTrade, saveEquity } = require('./db');
const { buildFeatures } = require('./features');
const BRAIN = require('./brain');

let LOGS=[];
let LAST_TRADE=0;

function log(msg){
  const t=new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const e=`[${t}] ${msg}`;
  console.log(e);
  LOGS.unshift(e);
  if(LOGS.length>200) LOGS.pop();
}

function analyzeBots(closes){

  const signals={
    trend: STRAT.trendBot(closes),
    rsi: STRAT.rsiBot(closes),
    momentum: STRAT.momentumBot(closes)
  };

  const weights=BRAIN.getWeights();

  log(`🤖 BOT SIGNALS:`);

  for(const k in signals){
    const s=signals[k];
    if(s){
      log(`${k} → ${s.side} (${s.confidence})`);
    }else{
      log(`${k} → null`);
    }
  }

  log(`🧠 WEIGHTS:`);

  for(const k in weights){
    log(`${k}: ${weights[k].toFixed(2)}`);
  }

  let buy=0, sell=0, used=[];

  for(const k in signals){
    const s=signals[k];
    if(!s) continue;

    const w=weights[k]||0.5;

    if(s.side==='BUY') buy+=s.confidence*w;
    if(s.side==='SELL') sell+=s.confidence*w;

    used.push(k);
  }

  log(`🗳️ RESULT → BUY:${buy.toFixed(2)} SELL:${sell.toFixed(2)}`);

  if(buy>0.6) return {side:'BUY',bots:used};
  if(sell>0.6) return {side:'SELL',bots:used};

  return null;
}

module.exports=async(req,res)=>{

  try{

    const base='https://botfx-blush.vercel.app';

    const settings=await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'getSettings'})
    })).json();

    if(!settings.active){
      log('⏸ BOT OFF');
      return res.json({logs:LOGS});
    }

    const balanceData=await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    const balance=parseFloat(balanceData[0]?.available||0);

    log(`💰 Balance: ${balance.toFixed(2)}`);

    const positions=await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    for(const sym of settings.symbols){

      if(positions.find(p=>p.symbol===sym)) continue;

      log(`🔍 ANALISAR ${sym}`);

      const candles=await (await fetch(base+'/api/bitget',{
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

      const closes=candles.map(c=>+c[4]);

      const features=buildFeatures(closes);

      const pred=await MLAPI.getPrediction(features);

      if(!pred){
        log('🧠 ML erro');
        continue;
      }

      log(`🧠 ML confidence: ${pred.confidence.toFixed(2)}`);

      const decision=analyzeBots(closes);

      if(!decision){
        log('❌ SEM CONSENSO');
        continue;
      }

      log(`🎯 DECISÃO FINAL: ${decision.side}`);

      const price=closes.at(-1);

      const qty=((balance*0.01)/price).toFixed(4);

      await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:sym,
          side:decision.side,
          quantity:qty
        })
      });

      LAST_TRADE=Date.now();

      log(`🚀 EXECUTADO ${decision.side} ${sym}`);

      await saveTrade({
        symbol:sym,
        side:decision.side,
        qty,
        bots:decision.bots,
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
