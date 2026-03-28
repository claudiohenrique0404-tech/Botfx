const STRAT = require('./strategies');
const MLAPI = require('./ml-client');
const { saveTrade, saveEquity } = require('./db');
const { buildFeatures } = require('./features');
const BRAIN = require('./brain');

if(!global.LOGS){
  global.LOGS = [];
}
let LOGS = global.LOGS;

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

    const base = 'https://botfx-blush.vercel.app';

    // ===== SETTINGS
    const settings = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'getSettings'})
    })).json();

    if(!settings.active){
      log('⏸ BOT OFF');
      return res.json({logs:LOGS});
    }

    // ===== BALANCE
    const balanceData = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    const balance = parseFloat(balanceData[0]?.available || 0);

    log(`💰 ${balance.toFixed(2)}`);

    // ===== POSITIONS
    const positions = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    // 🔥 GESTÃO DE POSIÇÕES (AUTONOMIA)
    for(const pos of positions){

      const pnl = parseFloat(pos.unrealizedPL || 0);
      const size = parseFloat(pos.total || 0);
      const sym = pos.symbol;

      log(`📊 ${sym} PnL: ${pnl.toFixed(2)}`);

      // TAKE PROFIT
      if(pnl > 2){
        log(`💰 TAKE PROFIT ${sym}`);

        await fetch(base+'/api/bitget',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            action:'order',
            symbol:sym,
            side: pos.holdSide === 'long' ? 'SELL' : 'BUY',
            quantity:size
          })
        });

        continue;
      }

      // STOP LOSS
      if(pnl < -1){
        log(`🛑 STOP LOSS ${sym}`);

        await fetch(base+'/api/bitget',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            action:'order',
            symbol:sym,
            side: pos.holdSide === 'long' ? 'SELL' : 'BUY',
            quantity:size
          })
        });

        continue;
      }
    }

    // ===== NOVAS ENTRADAS (SE NÃO HOUVER POSIÇÕES)
    if(positions.length === 0){

      for(const sym of settings.symbols){

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

        if(!candles.length) continue;

        const closes = candles.map(c=>+c[4]);
        const price = closes.at(-1);

        const features = buildFeatures(closes);
        const pred = await MLAPI.getPrediction(features);

        if(!pred || pred.confidence < 0.55){
          log('❌ ML fraco');
          continue;
        }

        const side = closes.at(-1) > closes.at(-10) ? 'BUY' : 'SELL';

        const qty = ((balance * 0.005)/price).toFixed(4);

        log(`🚀 ${side} ${sym}`);

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

        break;
      }
    }

    await saveEquity(balance);

    res.json({logs:LOGS});

  }catch(e){
    log(`🔥 ${e.message}`);
    res.json({logs:LOGS});
  }
};
