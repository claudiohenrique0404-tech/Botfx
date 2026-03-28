const STRAT = require('./strategies');
const MLAPI = require('./ml-client');
const { saveTrade, saveEquity } = require('./db');
const { buildFeatures } = require('./features');
const BRAIN = require('./brain');

let LOGS = [];
let LAST_TRADE = 0;

function log(msg){
  const t = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const e = `[${t}] ${msg}`;
  console.log(e);

  LOGS.unshift(e);
  if(LOGS.length > 200) LOGS.pop();
}

// ===== ANALISAR BOTS =====
function analyzeBots(closes){

  const signals = {
    trend: STRAT.trendBot(closes),
    rsi: STRAT.rsiBot(closes),
    momentum: STRAT.momentumBot(closes)
  };

  const weights = BRAIN.getWeights();

  log(`🤖 BOT SIGNALS:`);

  for(const k in signals){
    const s = signals[k];
    if(s){
      log(`${k} → ${s.side} (${s.confidence})`);
    } else {
      log(`${k} → null`);
    }
  }

  log(`🧠 WEIGHTS:`);

  for(const k in weights){
    log(`${k}: ${weights[k].toFixed(2)}`);
  }

  let buy = 0, sell = 0, used = [];

  for(const k in signals){

    const s = signals[k];
    if(!s) continue;

    const w = weights[k] || 0.5;

    if(s.side === 'BUY') buy += s.confidence * w;
    if(s.side === 'SELL') sell += s.confidence * w;

    used.push(k);
  }

  log(`🗳️ RESULT → BUY:${buy.toFixed(2)} SELL:${sell.toFixed(2)}`);

  if(buy > 0.6) return { side:'BUY', bots:used };
  if(sell > 0.6) return { side:'SELL', bots:used };

  return null;
}

module.exports = async (req,res)=>{

  try{

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

    log(`💰 Balance: ${balance.toFixed(2)}`);

    // 🚨 ALERTAS
    if(balance < 90){
      log('🚨 ALERTA: perda significativa');
    }

    // ===== POSITIONS
    const positions = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    // ===== LOOP SYMBOLS
    for(const sym of settings.symbols){

      // ignora se já tem posição
      if(positions.find(p=>p.symbol===sym)) continue;

      log(`🔍 ANALISAR ${sym}`);

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

      // ===== FEATURES
      const features = buildFeatures(closes);

      // ===== ML
      const pred = await MLAPI.getPrediction(features);

      if(!pred){
        log('🧠 ML erro');
        continue;
      }

      log(`🧠 ML confidence: ${pred.confidence.toFixed(2)}`);

      // 🚨 alerta ML fraco
      if(pred.confidence < 0.5){
        log('⚠️ ALERTA: ML muito fraco');
      }

      // 👉 NÃO BLOQUEIA NA FASE INICIAL
      // só ignora valores absurdos
      if(pred.confidence < 0.3){
        log('🧠 ignorado (muito fraco)');
        continue;
      }

      // ===== CONSENSO BOTS
      const decision = analyzeBots(closes);

      if(!decision){
        log('❌ SEM CONSENSO');
        continue;
      }

      log(`🎯 DECISÃO FINAL: ${decision.side}`);

      const price = closes.at(-1);

      // ===== RISK DINÂMICO
      let risk = 0.01;

      if(pred.confidence > 0.8) risk = 0.02;
      if(pred.confidence > 0.9) risk = 0.03;

      const qty = ((balance * risk) / price).toFixed(4);

      log(`⚖️ qty:${qty} risk:${risk}`);

      // ===== EXECUÇÃO
      const r = await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:sym,
          side:decision.side,
          quantity:qty
        })
      });

      const data = await r.json();

      if(data.code !== '00000'){
        log(`❌ erro ordem ${data.msg}`);
        continue;
      }

      LAST_TRADE = Date.now();

      log(`🚀 EXECUTADO ${decision.side} ${sym}`);

      // ===== SAVE TRADE
      await saveTrade({
        symbol:sym,
        side:decision.side,
        qty,
        bots:decision.bots,
        time:Date.now(),
        features
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
