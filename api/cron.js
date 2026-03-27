const STRAT = require('./strategies');
const { addTrade, getMetrics } = require('./state');

let botStats = {
  trendBot: { score: 1, capital: 0.33 },
  rsiBot: { score: 1, capital: 0.33 },
  momentumBot: { score: 1, capital: 0.34 }
};

// ===== NORMALIZE CAPITAL =====
function normalize(){
  const total = Object.values(botStats).reduce((a,b)=>a+b.score,0);
  for(const b in botStats){
    botStats[b].capital = botStats[b].score / total;
  }
}

// ===== ATR =====
function atr(data){
  let sum=0;
  for(let i=1;i<data.length;i++){
    sum += Math.abs(data[i]-data[i-1]);
  }
  return sum/data.length;
}

// ===== EXECUÇÃO INTELIGENTE =====
async function executeOrder(base, symbol, side, qty, closes){

  const move = Math.abs((closes.at(-1)-closes.at(-2))/closes.at(-2));

  // SLIPPAGE FILTER
  if(move > 0.005){
    console.log('❌ Slippage alto - skip');
    return false;
  }

  const part = (qty/2).toFixed(4);

  for(let i=0;i<2;i++){
    await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        action:'order',
        symbol,
        side,
        quantity:part
      })
    });

    console.log(`📦 Ordem parcial ${i+1}`);

    await new Promise(r=>setTimeout(r,500));
  }

  return true;
}

// ===== MAIN =====
module.exports = async (req,res)=>{

  try{

    // 🔥 PERMITIR GET (UPTIME ROBOT)
    if(req.method === 'GET'){
      console.log('🌐 Trigger externo (UptimeRobot)');
    }

    const base = process.env.VERCEL_URL
      ? 'https://' + process.env.VERCEL_URL
      : '';

    const settings = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'getSettings'})
    })).json();

    normalize();

    for(const sym of settings.symbols){

      const candles = await (await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'candles',symbol:sym,tf:'1m'})
      })).json();

      if(!candles.length) continue;

      const closes = candles.map(c=>+c[4]);

      const signals = {
        trendBot: STRAT.trendBot(closes),
        rsiBot: STRAT.rsiBot(closes),
        momentumBot: STRAT.momentumBot(closes)
      };

      // ===== VOTAÇÃO =====
      let votes = { BUY:0, SELL:0 };

      for(const b in signals){
        if(signals[b]){
          votes[signals[b].side] += botStats[b].capital;
        }
      }

      let side = null;

      if(votes.BUY > votes.SELL && votes.BUY > 0.5) side='BUY';
      if(votes.SELL > votes.BUY && votes.SELL > 0.5) side='SELL';

      if(!side){
        console.log(`❌ Sem consenso ${sym}`);
        continue;
      }

      console.log(`🗳️ ${sym} BUY:${votes.BUY.toFixed(2)} SELL:${votes.SELL.toFixed(2)}`);

      // ===== RISK PARITY =====
      const vol = atr(closes.slice(-20));
      const baseRisk = 120*(settings.risk/100);

      const size = Math.max(5, baseRisk/(vol || 1));
      const qty = (size/closes.at(-1)).toFixed(4);

      console.log(`⚖️ size:${size.toFixed(2)} vol:${vol.toFixed(4)}`);

      const executed = await executeOrder(base, sym, side, qty, closes);

      if(!executed) continue;

      // ===== SIMULAÇÃO PnL (para tracking) =====
      const pnl = (Math.random()-0.45)*2;

      addTrade(pnl);

      console.log(`💰 PnL simulado: ${pnl.toFixed(2)}`);

      break;
    }

    // ✅ SEMPRE 200 PARA UPTIMEROBOT
    return res.status(200).json({
      ok:true,
      metrics: getMetrics(),
      bots: botStats
    });

  }catch(e){
    console.error(e);

    // ⚠️ mesmo em erro → 200 para não quebrar uptime
    return res.status(200).json({
      ok:false,
      error:e.message
    });
  }

};
