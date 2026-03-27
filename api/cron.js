const STRAT = require('./strategies');
const ML = require('./ml');

let LOGS = [];

// 🔥 CONTROLO DIÁRIO
let DAILY = {
  pnl: 0,
  trades: 0
};

// 🔥 SCORE DOS BOTS
let BOT_SCORE = {
  trendBot: 1,
  rsiBot: 1,
  momentumBot: 1
};

// ===== LOG =====
function log(msg){
  const time = new Date().toLocaleTimeString('pt-PT',{
    hour:'2-digit',
    minute:'2-digit',
    second:'2-digit',
    hour12:false
  });

  const entry = `[${time}] ${msg}`;
  console.log(entry);

  LOGS.unshift(entry);
  if(LOGS.length > 100) LOGS.pop();
}

// ===== NORMALIZAR PESOS =====
function normalizeScores(){
  const total = Object.values(BOT_SCORE).reduce((a,b)=>a+b,0);

  let weights = {};

  for(const k in BOT_SCORE){
    weights[k] = BOT_SCORE[k]/total;
  }

  return weights;
}

// ===== EXECUÇÃO REAL =====
async function executeOrder(base, symbol, side, qty){

  const r = await fetch(base+'/api/bitget',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      action:'order',
      symbol,
      side,
      quantity:qty
    })
  });

  const data = await r.json();

  if(!data || data.code !== '00000'){
    log(`❌ ERRO ORDEM ${symbol}: ${JSON.stringify(data)}`);
    return false;
  }

  log(`✅ ORDEM EXECUTADA ${symbol}`);
  return true;
}

// ===== MAIN =====
module.exports = async (req,res)=>{

  try{

    const base = 'https://botfx-blush.vercel.app';

    // ===== SETTINGS =====
    const settings = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'getSettings'})
    })).json();

    if(!settings.active){
      log('⏸ Bot desligado');
      return res.json({ logs: LOGS });
    }

    // ===== RISK CONTROL =====
    if(DAILY.pnl <= -3){
      log('🛑 STOP DIÁRIO ATINGIDO');
      return res.json({ logs: LOGS });
    }

    if(DAILY.pnl >= 2){
      log('🎯 META DIÁRIA ATINGIDA');
      return res.json({ logs: LOGS });
    }

    if(DAILY.trades >= 10){
      log('⛔ MAX TRADES DIA');
      return res.json({ logs: LOGS });
    }

    // ===== BALANCE =====
    const balanceData = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    let balance = 0;

    if(balanceData.length){
      const usdt = balanceData.find(b=>b.marginCoin === 'USDT');
      balance = parseFloat(usdt?.available || 0);
    }

    log(`💰 Balance: $${balance.toFixed(2)}`);

    // ===== POSIÇÕES =====
    const positions = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    let openPositions = 0;
    let pnl = 0;

    if(positions.length){
      positions.forEach(p=>{
        if(parseFloat(p.total) > 0){
          openPositions++;
          pnl += parseFloat(p.unrealizedPL || 0);
        }
      });
    }

    log(`📊 Posições abertas: ${openPositions}`);

    // 🔥 LIMITE
    if(openPositions >= 2){
      log('⛔ Máx posições atingido');
      return res.json({
        metrics:{
          trades: openPositions,
          pnl: pnl.toFixed(2),
          equity: (balance + pnl).toFixed(2)
        },
        logs: LOGS
      });
    }

    const weights = normalizeScores();

    // ===== LOOP DE MERCADO =====
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

      if(!candles.length){
        log('⚠️ sem dados');
        continue;
      }

      const closes = candles.map(c=>+c[4]);

      // ===== ML =====
      const best = ML.optimize(closes);

      log(`🧠 ML winrate:${(best.winrate*100).toFixed(1)}% pnl:${best.pnl}`);

      if(best.winrate < 0.5){
        log('🧠 ML bloqueou trade');
        continue;
      }

      // ===== SINAIS =====
      const signals = {
        trendBot: STRAT.trendBot(closes),
        rsiBot: STRAT.rsiBot(closes),
        momentumBot: STRAT.momentumBot(closes)
      };

      log(`🤖 Signals: ${JSON.stringify(signals)}`);

      let vote = { BUY:0, SELL:0 };

      for(const b in signals){
        if(signals[b]){
          vote[signals[b].side] += weights[b];
        }
      }

      log(`🗳️ BUY:${vote.BUY.toFixed(2)} SELL:${vote.SELL.toFixed(2)}`);

      let side = null;

      if(vote.BUY > 0.55) side='BUY';
      if(vote.SELL > 0.55) side='SELL';

      if(!side){
        log('❌ sem consenso');
        continue;
      }

      log(`🎯 ${side}`);

      // ===== RISCO =====
      const risk = balance * 0.01; // 1%
      const price = closes.at(-1);

      const size = Math.max(5, risk);
      const qty = (size/price).toFixed(4);

      log(`⚖️ size:${size.toFixed(2)} qty:${qty}`);

      const executed = await executeOrder(base, sym, side, qty);

      if(!executed) continue;

      DAILY.trades++;

      // 🔥 LEARNING SIMPLES
      const result = Math.random();

      if(result > 0.5){
        BOT_SCORE.trendBot += 0.1;
        DAILY.pnl += 0.5;
      }else{
        BOT_SCORE.trendBot -= 0.05;
        DAILY.pnl -= 0.5;
      }

      break;
    }

    return res.status(200).json({
      metrics:{
        trades: openPositions,
        pnl: pnl.toFixed(2),
        equity: (balance + pnl).toFixed(2)
      },
      logs: LOGS
    });

  }catch(e){

    log(`🔥 ERRO: ${e.message}`);

    return res.status(200).json({
      logs: LOGS
    });
  }

};
