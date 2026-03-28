const STRAT = require('./strategies');
const MLAPI = require('./ml-client');
const { saveTrade, saveEquity } = require('./db');
const { buildFeatures } = require('./features');

let LOGS = [];
let LAST_TRADE = 0;

// ===== TRACKING =====
let TRACKING = {};

const BREAK_EVEN = 0.25;
const PARTIAL_TP = 0.5;
const TRAIL_START = 0.6;

function log(msg){
  const time = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const entry = `[${time}] ${msg}`;
  console.log(entry);

  LOGS.unshift(entry);
  if(LOGS.length > 150) LOGS.pop();
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

    // ===== GESTÃO AVANÇADA =====
    for(const p of positions){

      const sym = p.symbol;
      const entry = parseFloat(p.openPriceAvg || p.openPrice);
      const price = parseFloat(p.markPrice || p.last);
      const side = p.holdSide;

      if(!entry || !price) continue;

      let pnl = side === 'long'
        ? ((price - entry)/entry)*100
        : ((entry - price)/entry)*100;

      log(`📊 ${sym} ${pnl.toFixed(2)}%`);

      if(!TRACKING[sym]){
        TRACKING[sym] = {
          maxPnL: pnl,
          breakEven: false,
          partial: false
        };
      }

      const t = TRACKING[sym];

      if(pnl > t.maxPnL) t.maxPnL = pnl;

      // ===== PARTIAL TAKE PROFIT
      if(pnl >= PARTIAL_TP && !t.partial){
        log(`💰 PARTIAL TP ${sym}`);
        await closePartial(sym, side, base);
        t.partial = true;
      }

      // ===== BREAK EVEN
      if(pnl >= BREAK_EVEN && !t.breakEven){
        t.breakEven = true;
        log(`🟡 BE ATIVO ${sym}`);
      }

      // ===== STOP LOSS
      if(!t.breakEven && pnl <= -0.5){
        log(`🛑 STOP LOSS ${sym}`);
        await closeAll(sym, side, base, pnl);
        delete TRACKING[sym];
        continue;
      }

      // ===== BREAK EVEN EXIT
      if(t.breakEven && pnl <= 0){
        log(`⚖️ BE EXIT ${sym}`);
        await closeAll(sym, side, base, pnl);
        delete TRACKING[sym];
        continue;
      }

      // ===== TRAILING DINÂMICO
      if(t.maxPnL >= TRAIL_START){

        let dynamicTrail = 0.3;

        if(t.maxPnL > 1) dynamicTrail = 0.5;
        if(t.maxPnL > 2) dynamicTrail = 0.8;

        const trailLevel = t.maxPnL - dynamicTrail;

        if(pnl <= trailLevel){
          log(`📉 TRAIL EXIT ${sym}`);
          await closeAll(sym, side, base, pnl);
          delete TRACKING[sym];
          continue;
        }
      }

      // ===== REVERSÃO DE TENDÊNCIA
      const candles = await (await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'candles',
          symbol:sym,
          tf:'1m'
        })
      })).json();

      const closes = candles.map(c=>+c[4]);

      const signal = STRAT.trendBot(closes);

      if(signal && (
        (side === 'long' && signal.side === 'SELL') ||
        (side === 'short' && signal.side === 'BUY')
      )){
        log(`🔄 REVERSÃO ${sym}`);
        await closeAll(sym, side, base, pnl);
        delete TRACKING[sym];
        continue;
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

      if(!prediction || prediction.confidence < 0.65){
        log('🧠 ML bloqueou');
        continue;
      }

      const signal = STRAT.trendBot(closes);
      if(!signal) continue;

      const now = Date.now();
      if(now - LAST_TRADE < 8000) continue;

      const qty = (Math.max(5, balance*0.01)/price).toFixed(4);

      await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:sym,
          side:signal.side,
          quantity:qty
        })
      });

      LAST_TRADE = Date.now();

      log(`🚀 ${signal.side} ${sym}`);

      TRACKING[sym] = {
        maxPnL: 0,
        breakEven: false,
        partial: false
      };

      await saveTrade({
        symbol:sym,
        side:signal.side,
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

  const closeSide = side === 'long' ? 'SELL' : 'BUY';

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

  const closeSide = side === 'long' ? 'SELL' : 'BUY';

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
