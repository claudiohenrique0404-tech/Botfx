const STRAT = require('./strategies');

let LOGS = [];
let DAILY = {
  pnl:0,
  trades:0
};

let BOT_SCORE = {
  trendBot:1,
  rsiBot:1,
  momentumBot:1
};

function log(msg){
  const time = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const entry = `[${time}] ${msg}`;

  console.log(entry);
  LOGS.unshift(entry);
  if(LOGS.length > 100) LOGS.pop();
}

function normalizeScores(){
  const total = Object.values(BOT_SCORE).reduce((a,b)=>a+b,0);
  let out = {};

  for(const k in BOT_SCORE){
    out[k] = BOT_SCORE[k]/total;
  }

  return out;
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
      return res.json({ logs:LOGS });
    }

    // ===== RISK CONTROL =====
    if(DAILY.pnl <= -3){
      log('🛑 STOP DIÁRIO ATINGIDO');
      return res.json({ logs:LOGS });
    }

    if(DAILY.pnl >= 2){
      log('🎯 META DIÁRIA ATINGIDA');
      return res.json({ logs:LOGS });
    }

    if(DAILY.trades >= 10){
      log('⛔ MAX TRADES DIA');
      return res.json({ logs:LOGS });
    }

    const balanceData = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    let balance = parseFloat(balanceData[0]?.available || 0);

    log(`💰 ${balance}`);

    const weights = normalizeScores();

    for(const sym of settings.symbols){

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

      const signals = {
        trendBot: STRAT.trendBot(closes),
        rsiBot: STRAT.rsiBot(closes),
        momentumBot: STRAT.momentumBot(closes)
      };

      let vote = {BUY:0, SELL:0};

      for(const b in signals){
        if(signals[b]){
          vote[signals[b].side] += weights[b];
        }
      }

      log(`🗳️ ${sym} BUY:${vote.BUY.toFixed(2)} SELL:${vote.SELL.toFixed(2)}`);

      let side=null;

      if(vote.BUY > 0.55) side='BUY';
      if(vote.SELL > 0.55) side='SELL';

      if(!side) continue;

      const risk = balance * 0.01;
      const price = closes.at(-1);
      const qty = (Math.max(5,risk)/price).toFixed(4);

      const r = await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:sym,
          side,
          quantity:qty
        })
      });

      const data = await r.json();

      if(data.code !== '00000'){
        log(`❌ erro ordem`);
        continue;
      }

      log(`✅ ${side} ${sym}`);

      DAILY.trades++;

      // 🔥 pseudo learning
      const result = Math.random();

      if(result > 0.5){
        BOT_SCORE.trendBot += 0.1;
      }else{
        BOT_SCORE.trendBot -= 0.05;
      }

      break;
    }

    return res.json({
      logs:LOGS,
      bots:BOT_SCORE
    });

  }catch(e){
    log(`🔥 ${e.message}`);
    return res.json({logs:LOGS});
  }

};
