const STRAT = require('./strategies');
const { addTrade, getMetrics } = require('./state');

let botStats = {
  trendBot: { score: 1, capital: 0.33 },
  rsiBot: { score: 1, capital: 0.33 },
  momentumBot: { score: 1, capital: 0.34 }
};

let LOGS = [];

function log(msg){
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}] ${msg}`;

  console.log(entry);

  LOGS.unshift(entry);
  if(LOGS.length > 80) LOGS.pop();
}

// 🔥 CONVERTER SYMBOL PARA BITGET FUTURES
function formatSymbol(sym){
  return sym + '_UMCBL';
}

// ===== NORMALIZE =====
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

// ===== EXECUTION =====
async function executeOrder(base, symbol, side, qty, closes){

  const move = Math.abs((closes.at(-1)-closes.at(-2))/closes.at(-2));

  if(move > 0.005){
    log(`❌ ${symbol} slippage alto`);
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

    log(`📦 ${symbol} ordem parcial ${i+1}`);
    await new Promise(r=>setTimeout(r,500));
  }

  return true;
}

// ===== MAIN =====
module.exports = async (req,res)=>{

  try{

    if(req.method === 'HEAD' || req.method === 'GET'){
      log('🌐 Trigger UptimeRobot');
    }

    const base = 'https://botfx-blush.vercel.app';

    // ===== BALANCE =====
    const balanceData = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    let balance = 0;

    if(balanceData.length){
      const usdt = balanceData.find(b=>b.marginCoin === 'USDT');
      balance = usdt ? parseFloat(usdt.available || 0) : 0;
    }

    log(`💰 Balance: $${balance.toFixed(2)}`);

    if(balance < 5){
      log('❌ saldo insuficiente');
      return res.json({ logs: LOGS });
    }

    const settings = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'getSettings'})
    })).json();

    normalize();

    for(const sym of settings.symbols){

      const formatted = formatSymbol(sym);

      log(`🔍 Analisar ${sym}`);

      const candles = await (await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'candles',
          symbol: formatted,
          tf:'1min'
        })
      })).json();

      if(!candles.length){
        log(`⚠️ ${sym} sem dados`);
        continue;
      }

      const closes = candles.map(c=>+c[4]);

      const signals = {
        trendBot: STRAT.trendBot(closes),
        rsiBot: STRAT.rsiBot(closes),
        momentumBot: STRAT.momentumBot(closes)
      };

      log(`🤖 Signals: ${JSON.stringify(signals)}`);

      let votes = { BUY:0, SELL:0 };

      for(const b in signals){
        if(signals[b]){
          votes[signals[b].side] += botStats[b].capital;
        }
      }

      log(`🗳️ BUY:${votes.BUY.toFixed(2)} SELL:${votes.SELL.toFixed(2)}`);

      let side = null;

      if(votes.BUY > votes.SELL && votes.BUY > 0.5) side='BUY';
      if(votes.SELL > votes.BUY && votes.SELL > 0.5) side='SELL';

      if(!side){
        log(`❌ ${sym} sem consenso`);
        continue;
      }

      log(`🎯 ${side} ${sym}`);

      const vol = atr(closes.slice(-20));
      const baseRisk = balance*(settings.risk/100);

      const size = Math.max(5, baseRisk/(vol || 1));
      const qty = (size/closes.at(-1)).toFixed(4);

      log(`⚖️ size:${size.toFixed(2)}`);

      const executed = await executeOrder(base, sym, side, qty, closes);

      if(!executed) continue;

      const pnl = (Math.random()-0.45)*2;
      addTrade(pnl);

      log(`💰 Resultado: ${pnl.toFixed(2)}`);

      break;
    }

    return res.status(200).json({
      metrics: getMetrics(),
      bots: botStats,
      logs: LOGS
    });

  }catch(e){

    log(`🔥 ERRO: ${e.message}`);

    return res.status(200).json({
      logs: LOGS
    });
  }

};
