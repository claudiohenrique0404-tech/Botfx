const STRAT = require('./strategies');
const ML = require('./ml');
const { saveTrade, saveEquity } = require('./db');

let LOGS = [];
let LAST_TRADE = 0;

// 🔥 TRACKING POSIÇÕES
let TRACKING = {};

// configs profissionais
const BREAK_EVEN = 0.3;   // %
const TRAIL_START = 0.5;  // %
const TRAIL_DIST = 0.3;   // %

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

    // ===== BALANCE =====
    const balanceData = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    const balance = parseFloat(balanceData[0]?.available || 0);

    log(`💰 ${balance.toFixed(2)}`);

    // ===== POSITIONS =====
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

      // init tracking
      if(!TRACKING[sym]){
        TRACKING[sym] = {
          maxPnL: pnl,
          breakEven: false
        };
      }

      const t = TRACKING[sym];

      // update máximo
      if(pnl > t.maxPnL){
        t.maxPnL = pnl;
      }

      // ===== BREAK EVEN
      if(pnl >= BREAK_EVEN && !t.breakEven){
        t.breakEven = true;
        log(`🟡 BREAK EVEN ATIVO ${sym}`);
      }

      // ===== STOP LOSS NORMAL
      if(!t.breakEven && pnl <= -0.5){
        log(`🛑 STOP LOSS ${sym}`);
        await closePosition(sym, side, base);
        delete TRACKING[sym];
        continue;
      }

      // ===== BREAK EVEN STOP
      if(t.breakEven && pnl <= 0){
        log(`⚖️ BREAK EVEN EXIT ${sym}`);
        await closePosition(sym, side, base);
        delete TRACKING[sym];
        continue;
      }

      // ===== TRAILING STOP
      if(t.maxPnL >= TRAIL_START){

        const trailLevel = t.maxPnL - TRAIL_DIST;

        if(pnl <= trailLevel){
          log(`📉 TRAILING STOP ${sym}`);
          await closePosition(sym, side, base);
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

      const signal = STRAT.trendBot(closes);
      if(!signal) continue;

      const now = Date.now();
      if(now - LAST_TRADE < 8000) continue;

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

      if(data.code !== '00000') continue;

      LAST_TRADE = Date.now();

      log(`🚀 ${signal.side} ${sym}`);

      TRACKING[sym] = {
        maxPnL: 0,
        breakEven: false
      };

      await saveTrade({
        symbol:sym,
        side:signal.side,
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

// ===== CLOSE =====
async function closePosition(symbol, side, base){

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
}
