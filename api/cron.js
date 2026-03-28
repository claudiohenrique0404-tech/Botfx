const MLAPI = require('./ml-client');
const { saveEquity } = require('./db');
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

    if(req.query.mode === 'logs'){
      return res.json({logs:LOGS});
    }

    const base = `https://${req.headers.host}`;

    // ===== BALANCE
    const balanceData = await (await fetch(base + '/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    const balance = parseFloat(balanceData?.[0]?.available || 0);

    // ===== POSITIONS
    const positions = await (await fetch(base + '/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    log(`💰 Balance ${balance}`);
    log(`📊 Positions ${positions.length}`);

    // =========================
    // 🔥 GESTÃO DE POSIÇÕES (FIX REAL AQUI)
    // =========================

    for(const pos of positions || []){

      const sym = pos.symbol;
      const pnl = parseFloat(pos.unrealizedPL || 0);

      // 🔥 FIX: size correto
      const size = parseFloat(pos.total || pos.available || pos.size || 0);

      if(size <= 0) continue;

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

      // =================
      // 🔥 BREAK EVEN
      // =================
      if(pnl > 1 && !state.breakeven){
        state.breakeven = true;
        log(`🟢 BREAK EVEN ${sym}`);
      }

      // =================
      // 🔥 PARTIAL CLOSE (FIX REAL)
      // =================
      if(pnl > 2 && !state.partialClosed){

        const half = (size * 0.5).toFixed(4);

        log(`✂️ PARTIAL CLOSE ${sym}`);

        const response = await fetch(base + '/api/bitget',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            action:'order',
            symbol:sym,
            side: pos.holdSide === 'long' ? 'close_long' : 'close_short',
            quantity:half
          })
        });

        const result = await response.json();
        log(`📤 PARTIAL RESULT ${sym}: ${JSON.stringify(result)}`);

        state.partialClosed = true;
      }

      // =================
      // 🔥 TRAILING STOP (FIX REAL)
      // =================
      const trail = state.maxPnl - 1.5;

      if(state.maxPnl > 2 && pnl < trail){

        log(`📉 TRAILING STOP ${sym}`);

        const response = await fetch(base + '/api/bitget',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            action:'order',
            symbol:sym,
            side: pos.holdSide === 'long' ? 'close_long' : 'close_short',
            quantity:size
          })
        });

        const result = await response.json();
        log(`📤 TRAIL RESULT ${sym}: ${JSON.stringify(result)}`);

        delete POS_STATE[sym];
        continue;
      }

      // =================
      // 🔥 STOP LOSS (FIX REAL)
      // =================
      if(pnl < -1.5){

        log(`🛑 STOP LOSS ${sym}`);

        const response = await fetch(base + '/api/bitget',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            action:'order',
            symbol:sym,
            side: pos.holdSide === 'long' ? 'close_long' : 'close_short',
            quantity:size
          })
        });

        const result = await response.json();
        log(`📤 STOP RESULT ${sym}: ${JSON.stringify(result)}`);

        delete POS_STATE[sym];
        continue;
      }
    }

    // =========================
    // 🔥 ENTRADAS (INALTERADO)
    // =========================

    if(!positions || positions.length === 0){

      const symbol = 'BTCUSDT';

      const candles = await (await fetch(base + '/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'candles',
          symbol,
          tf:'1m'
        })
      })).json();

      if(!candles || !candles.length){
        log(`❌ Sem dados de mercado`);
        return res.json({logs:LOGS});
      }

      const closes = candles.map(c=>+c[4]);

      const trendUp = closes.at(-1) > closes.at(-20);
      log(`📈 TrendBot: ${trendUp ? 'UPTREND' : 'DOWNTREND'}`);

      const avg = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
      const deviation = closes.at(-1) - avg;

      let meanSignal = null;

      if(deviation > 50) meanSignal = 'SELL';
      else if(deviation < -50) meanSignal = 'BUY';

      log(`📊 MeanBot: ${deviation.toFixed(2)} → ${meanSignal || 'NEUTRAL'}`);

      const features = buildFeatures(closes);
      const pred = await MLAPI.getPrediction(features);

      let mlSignal = null;
      if(pred && pred.confidence > 0.6){
        mlSignal = pred.direction;
      }

      log(`🧠 MLBot: ${mlSignal || 'NO SIGNAL'} (${(pred?.confidence||0).toFixed(2)})`);

      let votes = {BUY:0, SELL:0};

      if(trendUp) votes.BUY++; else votes.SELL++;
      if(meanSignal) votes[meanSignal]++;
      if(mlSignal) votes[mlSignal]++;

      log(`🗳️ Votes BUY:${votes.BUY} SELL:${votes.SELL}`);

      let final = null;
      if(votes.BUY > votes.SELL) final = 'BUY';
      if(votes.SELL > votes.BUY) final = 'SELL';

      if(!final){
        log(`⏸️ Sem consenso`);
        return res.json({logs:LOGS});
      }

      const price = closes.at(-1);
      const qty = ((balance * 0.005)/price).toFixed(4);

      log(`🚀 EXECUTAR ${final} ${symbol}`);

      const response = await fetch(base + '/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol,
          side:final,
          quantity:qty
        })
      });

      const result = await response.json();
      log(`📤 ORDER RESULT: ${JSON.stringify(result)}`);
    }

    await saveEquity(balance);

    return res.json({logs:LOGS});

  }catch(e){
    log(`🔥 ${e.message}`);
    return res.json({logs:LOGS});
  }
};