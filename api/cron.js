const STRAT = require('./strategies');
const MLAPI = require('./ml-client');
const { saveTrade, saveEquity } = require('./db');
const { buildFeatures } = require('./features');

let LOGS = [];
let LAST_TRADE = 0;

let TRACKING = {};
let BOT_SCORE = {
  trend:1,
  rsi:1,
  momentum:1
};

const MAX_DAILY_LOSS = -3;
let START_BALANCE = null;

function log(msg){
  const t = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const e = `[${t}] ${msg}`;
  console.log(e);
  LOGS.unshift(e);
  if(LOGS.length>150) LOGS.pop();
}

function normalize(){
  const total = Object.values(BOT_SCORE).reduce((a,b)=>a+b,0);
  let w={};
  for(const k in BOT_SCORE){
    w[k]=BOT_SCORE[k]/total;
  }
  return w;
}

function consensus(closes){

  const w = normalize();

  const signals = {
    trend: STRAT.trendBot(closes),
    rsi: STRAT.rsiBot(closes),
    momentum: STRAT.momentumBot(closes)
  };

  let buy=0, sell=0;

  for(const k in signals){
    const s = signals[k];
    if(!s) continue;

    if(s.side==='BUY') buy += s.confidence * w[k];
    if(s.side==='SELL') sell += s.confidence * w[k];
  }

  log(`🗳️ BUY:${buy.toFixed(2)} SELL:${sell.toFixed(2)}`);

  if(buy > 0.7) return 'BUY';
  if(sell > 0.7) return 'SELL';

  return null;
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

    if(!START_BALANCE) START_BALANCE = balance;

    const pnlDay = ((balance-START_BALANCE)/START_BALANCE)*100;

    log(`💰 ${balance.toFixed(2)} | PnL: ${pnlDay.toFixed(2)}%`);

    if(pnlDay <= MAX_DAILY_LOSS){
      log('🛑 KILL SWITCH');
      return res.json({logs:LOGS});
    }

    const positions = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    // ===== GESTÃO POSIÇÕES SIMPLIFICADA (já tens sistema forte)
    for(const p of positions){

      const sym = p.symbol;
      const entry = parseFloat(p.openPriceAvg || p.openPrice);
      const price = parseFloat(p.markPrice || p.last);
      const side = p.holdSide;

      let pnl = side==='long'
        ? ((price-entry)/entry)*100
        : ((entry-price)/entry)*100;

      if(pnl < -0.6){
        await closeAll(sym,side,base,pnl);
        delete TRACKING[sym];
      }

      if(pnl > 1){
        await closePartial(sym,side,base);
      }
    }

    // ===== ENTRADAS =====
    for(const sym of settings.symbols){

      if(positions.find(p=>p.symbol===sym)) continue;

      const candles = await (await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'candles',
          symbol:sym,
          tf:'1m'
        })
      })).json();

      if(!candles.length) continue;

      const closes = candles.map(c=>+c[4]);
      const price = closes.at(-1);

      const features = buildFeatures(closes);

      const prediction = await MLAPI.getPrediction(features);

      if(!prediction || prediction.confidence < 0.7){
        log('🧠 bloqueado');
        continue;
      }

      const side = consensus(closes);
      if(!side){
        log('❌ sem consenso');
        continue;
      }

      const now = Date.now();
      if(now-LAST_TRADE < 6000) continue;

      let risk = 0.01;

      if(prediction.confidence > 0.85) risk=0.02;

      const qty = ((balance*risk)/price).toFixed(4);

      await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:sym,
          side,
          quantity:qty
        })
      });

      LAST_TRADE = Date.now();

      log(`🚀 ${side} ${sym}`);

      await saveTrade({
        symbol:sym,
        side,
        qty,
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

// ===== HELPERS =====
async function closeAll(symbol, side, base, pnl){

  const closeSide = side==='long'?'SELL':'BUY';

  await fetch(base+'/api/bitget',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      action:'order',
      symbol,
      side:closeSide,
      quantity:9999
    })
  });

  await fetch(base+'/api/db-update',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({symbol,pnl})
  });
}

async function closePartial(symbol, side, base){

  const closeSide = side==='long'?'SELL':'BUY';

  await fetch(base+'/api/bitget',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      action:'order',
      symbol,
      side:closeSide,
      quantity:0.5
    })
  });
}
