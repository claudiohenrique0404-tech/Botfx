const STRAT = require('./strategies');
const ML = require('./ml');
const { saveTrade, saveEquity } = require('./db');

let LOGS = [];
let LAST_TRADE = 0;

// ===== CAPITAL DISTRIBUTION =====
let BOT_SCORE = {
  trend: 1,
  rsi: 1,
  momentum: 1
};

// ===== TRACKING =====
let TRACKING = {};

const BREAK_EVEN = 0.3;
const TRAIL_START = 0.5;
const TRAIL_DIST = 0.3;

function log(msg){
  const time = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const entry = `[${time}] ${msg}`;
  console.log(entry);

  LOGS.unshift(entry);
  if(LOGS.length > 100) LOGS.pop();
}

// ===== NORMALIZE SCORES =====
function weights(){
  const total = Object.values(BOT_SCORE).reduce((a,b)=>a+b,0);
  let w = {};

  for(const k in BOT_SCORE){
    w[k] = BOT_SCORE[k]/total;
  }

  return w;
}

// ===== CONSENSUS =====
function consensus(closes){

  const w = weights();

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

  if(buy > 0.6) return 'BUY';
  if(sell > 0.6) return 'SELL';

  return null;
}

// ===== TWAP EXECUTION =====
async function executeTWAP(base, symbol, side, totalQty){

  const parts = 3;
  const partQty = totalQty / parts;

  for(let i=0;i<parts;i++){

    await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        action:'order',
        symbol,
        side,
        quantity:partQty.toFixed(4)
      })
    });

    await new Promise(r=>setTimeout(r, 1000));
  }
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

    // ===== POSITION MANAGEMENT =====
    for(const p of positions){

      const sym = p.symbol;
      const entry = parseFloat(p.openPriceAvg || p.openPrice);
      const price = parseFloat(p.markPrice || p.last);
      const side = p.holdSide;

      if(!entry || !price) continue;

      let pnl = side==='long'
        ? ((price-entry)/entry)*100
        : ((entry-price)/entry)*100;

      if(!TRACKING[sym]){
        TRACKING[sym] = {
          maxPnL: pnl,
          breakEven: false,
          partialTaken: false
        };
      }

      const t = TRACKING[sym];

      if(pnl > t.maxPnL) t.maxPnL = pnl;

      // BREAK EVEN
      if(pnl >= BREAK_EVEN && !t.breakEven){
        t.breakEven = true;
        log(`🟡 BE ${sym}`);
      }

      // PARTIAL TP
      if(pnl >= 0.6 && !t.partialTaken){
        log(`💰 PARTIAL TP ${sym}`);
        await closePartial(sym, side, base);
        t.partialTaken = true;
      }

      // BREAK EVEN EXIT
      if(t.breakEven && pnl <= 0){
        log(`⚖️ BE EXIT ${sym}`);
        await closeAll(sym, side, base);
        delete TRACKING[sym];
        continue;
      }

      // TRAILING
      if(t.maxPnL >= TRAIL_START){

        const trail = t.maxPnL - TRAIL_DIST;

        if(pnl <= trail){
          log(`📉 TRAIL EXIT ${sym}`);
          await closeAll(sym, side, base);
          delete TRACKING[sym];
          continue;
        }
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

      const ml = ML.optimize(closes);
      if(ml.winrate < 0.55) continue;

      const side = consensus(closes);
      if(!side) continue;

      const now = Date.now();
      if(now - LAST_TRADE < 10000) continue;

      const qty = Math.max(5, balance*0.01) / price;

      await executeTWAP(base, sym, side, qty);

      LAST_TRADE = Date.now();

      log(`🚀 ${side} ${sym}`);

      TRACKING[sym] = {
        maxPnL: 0,
        breakEven: false,
        partialTaken: false
      };

      await saveTrade({
        symbol:sym,
        side,
        qty,
        time:Date.now()
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

// ===== CLOSE HELPERS =====

async function closeAll(symbol, side, base){
  const closeSide = side==='long' ? 'SELL' : 'BUY';

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
}

async function closePartial(symbol, side, base){
  const closeSide = side==='long' ? 'SELL' : 'BUY';

  await fetch(base+'/api/bitget',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      action:'order',
      symbol,
      side:closeSide,
      quantity:0.5 // metade
    })
  });
}
