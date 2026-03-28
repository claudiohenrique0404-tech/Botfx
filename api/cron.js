const STRAT = require('./strategies');
const MLAPI = require('./ml-client');
const { saveTrade, saveEquity } = require('./db');
const { buildFeatures } = require('./features');
const BRAIN = require('./brain');

let LOGS = [];
let LAST_TRADE = 0;
let TRADES_TODAY = 0;
let START_BALANCE = null;

const MAX_TRADES_DAY = 10;
const MAX_DAILY_LOSS = -3; // %

function log(msg){
  const t = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const e = `[${t}] ${msg}`;
  console.log(e);

  LOGS.unshift(e);
  if(LOGS.length > 200) LOGS.pop();
}

// ===== CONSENSO FORTE
function analyzeBots(closes){

  const signals = {
    trend: STRAT.trendBot(closes),
    rsi: STRAT.rsiBot(closes),
    momentum: STRAT.momentumBot(closes)
  };

  const weights = BRAIN.getWeights();

  let buy = 0, sell = 0, used = [];

  for(const k in signals){

    const s = signals[k];
    if(!s) continue;

    const w = weights[k] || 0.5;

    if(s.side === 'BUY') buy += s.confidence * w;
    if(s.side === 'SELL') sell += s.confidence * w;

    used.push(k);
  }

  log(`🗳️ BUY:${buy.toFixed(2)} SELL:${sell.toFixed(2)}`);

  if(buy > 0.75) return { side:'BUY', bots:used };
  if(sell > 0.75) return { side:'SELL', bots:used };

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

    if(!START_BALANCE) START_BALANCE = balance;

    const pnlDay = ((balance - START_BALANCE)/START_BALANCE)*100;

    log(`💰 ${balance.toFixed(2)} | Day: ${pnlDay.toFixed(2)}%`);

    // 🚨 KILL SWITCH
    if(pnlDay <= MAX_DAILY_LOSS){
      log('🛑 KILL SWITCH ATIVADO');
      return res.json({logs:LOGS});
    }

    // 🚫 LIMITE DE TRADES
    if(TRADES_TODAY >= MAX_TRADES_DAY){
      log('⏸ LIMITE DE TRADES ATINGIDO');
      return res.json({logs:LOGS});
    }

    // ===== POSITIONS
    const positions = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    for(const sym of settings.symbols){

      if(positions.find(p=>p.symbol===sym)) continue;

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
      const price = closes.at(-1);

      const features = buildFeatures(closes);

      const pred = await MLAPI.getPrediction(features);

      if(!pred){
        log('🧠 ML erro');
        continue;
      }

      log(`🧠 ML: ${pred.confidence.toFixed(2)}`);

      // 🔥 FILTRO CONSERVADOR
      if(pred.confidence < 0.55){
        log('❌ ML fraco');
        continue;
      }

      const decision = analyzeBots(closes);

      if(!decision){
        log('❌ sem consenso forte');
        continue;
      }

      const now = Date.now();

      // ⏱ COOLDOWN MAIS LONGO
      if(now - LAST_TRADE < 15000){
        log('⏱ cooldown');
        continue;
      }

      // 🔥 RISCO BAIXO
      const risk = 0.005; // 0.5%

      const qty = ((balance * risk)/price).toFixed(4);

      log(`⚖️ qty:${qty}`);

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
        log(`❌ erro ${data.msg}`);
        continue;
      }

      LAST_TRADE = Date.now();
      TRADES_TODAY++;

      log(`🚀 ${decision.side} ${sym}`);

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
