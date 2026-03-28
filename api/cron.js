const STRAT = require('./strategies');
const MLAPI = require('./ml-client');
const { saveTrade, saveEquity } = require('./db');
const { buildFeatures } = require('./features');

if(!global.LOGS) global.LOGS = [];
if(!global.POS_STATE) global.POS_STATE = {};

let LOGS = global.LOGS;
let POS_STATE = global.POS_STATE;

function log(msg){
  const t = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const e = `[${t}] ${msg}`;
  console.log(e);
  LOGS.unshift(e);
  if(LOGS.length > 200) LOGS.pop();
}

module.exports = async (req,res)=>{

  try{

    // ===== LOGS MODE
    if(req.query.mode === 'logs'){
      return res.json({logs:LOGS});
    }

    // 🔥 LOCAL (SEM URL EXTERNO)
    const endpoint = '/api/bitget';

    // ===== BALANCE
    const balanceData = await (await fetch(endpoint,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    const balance = parseFloat(balanceData?.[0]?.available || 0);

    // ===== POSITIONS
    const positions = await (await fetch(endpoint,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    // =========================
    // 🔥 GESTÃO DE POSIÇÕES
    // =========================

    for(const pos of positions || []){

      const sym = pos.symbol;
      const pnl = parseFloat(pos.unrealizedPL || 0);
      const size = parseFloat(pos.total || 0);

      if(!POS_STATE[sym]){
        POS_STATE[sym] = {
          maxPnl: pnl,
          breakeven:false,
          partialClosed:false
        };
      }

      let state = POS_STATE[sym];

      if(pnl > state.maxPnl){
        state.maxPnl = pnl;
      }

      log(`📊 ${sym} pnl:${pnl.toFixed(2)} max:${state.maxPnl.toFixed(2)}`);

      // BREAK EVEN
      if(pnl > 1 && !state.breakeven){
        state.breakeven = true;
        log(`🟢 BREAK EVEN ${sym}`);
      }

      // PARTIAL CLOSE
      if(pnl > 2 && !state.partialClosed){

        const half = (size * 0.5).toFixed(4);

        log(`✂️ PARTIAL ${sym}`);

        await fetch(endpoint,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            action:'order',
            symbol:sym,
            side: pos.holdSide === 'long' ? 'SELL' : 'BUY',
            quantity:half
          })
        });

        state.partialClosed = true;
      }

      // TRAILING
      const trail = state.maxPnl - 1.5;

      if(state.maxPnl > 2 && pnl < trail){

        log(`📉 TRAILING ${sym}`);

        await fetch(endpoint,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            action:'order',
            symbol:sym,
            side: pos.holdSide === 'long' ? 'SELL' : 'BUY',
            quantity:size
          })
        });

        delete POS_STATE[sym];
        continue;
      }

      // STOP LOSS
      if(pnl < -1.5){

        log(`🛑 STOP ${sym}`);

        await fetch(endpoint,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            action:'order',
            symbol:sym,
            side: pos.holdSide === 'long' ? 'SELL' : 'BUY',
            quantity:size
          })
        });

        delete POS_STATE[sym];
        continue;
      }
    }

    // =========================
    // 🔥 ENTRADAS
    // =========================

    if(!positions || positions.length === 0){

      const symbols = ['BTCUSDT'];

      for(const sym of symbols){

        const candles = await (await fetch(endpoint,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            action:'candles',
            symbol:sym,
            tf:'1m'
          })
        })).json();

        if(!candles || !candles.length) continue;

        const closes = candles.map(c=>+c[4]);
        const price = closes[closes.length - 1];

        const features = buildFeatures(closes);
        const pred = await MLAPI.getPrediction(features);

        if(!pred || pred.confidence < 0.6){
          log(`⏭️ SKIP ${sym}`);
          continue;
        }

        const side = closes.at(-1) > closes.at(-10) ? 'BUY' : 'SELL';
        const qty = ((balance * 0.005)/price).toFixed(4);

        log(`🚀 ${side} ${sym}`);

        await fetch(endpoint,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            action:'order',
            symbol:sym,
            side,
            quantity:qty
          })
        });

        break;
      }
    }

    await saveEquity(balance);

    return res.json({logs:LOGS});

  }catch(e){

    log(`🔥 ${e.message}`);

    return res.json({logs:LOGS});
  }
};