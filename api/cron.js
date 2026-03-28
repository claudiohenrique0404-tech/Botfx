const STRAT = require('./strategies');
const ML = require('./ml');
const { saveTrade, saveEquity } = require('./db');

let LOGS = [];
let LAST_TRADE = 0;

const TP = 0.5;   // +0.5%
const SL = -0.5;  // -0.5%
const TRAIL = 0.3;

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

    // ===== GERIR POSIÇÕES (🔥 NOVO)
    for(const p of positions){

      const sym = p.symbol;
      const entry = parseFloat(p.openPriceAvg || p.openPrice);
      const mark = parseFloat(p.markPrice || p.last);
      const side = p.holdSide; // long / short

      if(!entry || !mark) continue;

      let pnl = 0;

      if(side === 'long'){
        pnl = ((mark - entry)/entry)*100;
      }else{
        pnl = ((entry - mark)/entry)*100;
      }

      log(`📊 ${sym} PnL: ${pnl.toFixed(2)}%`);

      // ===== TAKE PROFIT
      if(pnl >= TP){
        log(`💰 TP atingido ${sym}`);

        await closePosition(sym, side, base);
        continue;
      }

      // ===== STOP LOSS
      if(pnl <= SL){
        log(`🛑 SL atingido ${sym}`);

        await closePosition(sym, side, base);
        continue;
      }

      // ===== TRAILING
      if(pnl > TRAIL){
        log(`📈 trailing ativo ${sym}`);
      }
    }

    // ===== NOVAS ENTRADAS (igual antes, simplificado)
    // só entra se não houver posição no ativo

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

// ===== CLOSE POSITION =====
async function closePosition(symbol, side, base){

  const closeSide = side === 'long' ? 'SELL' : 'BUY';

  await fetch(base+'/api/bitget',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      action:'order',
      symbol,
      side:closeSide,
      quantity:9999 // fecha tudo
    })
  });
}
