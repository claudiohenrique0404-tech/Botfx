const STRAT = require('./strategies');
// const MLAPI = require('./ml-client'); // ML desligado
const { saveTrade, saveEquity } = require('./db');
const { buildFeatures } = require('./features');
const BRAIN = require('./brain');

const fetch = global.fetch || require('node-fetch');

// 🔥 LOGS GLOBAIS
if(!global.LOGS){
  global.LOGS = [];
}
let LOGS = global.LOGS;

let LAST_TRADE = 0;
let TRADES_TODAY = 0;
let START_BALANCE = null;

const MAX_TRADES_DAY = 10;
const MAX_DAILY_LOSS = -3;

// ===== LOG
function log(msg){
  const t = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const e = `[${t}] ${msg}`;
  console.log(e);

  LOGS.unshift(e);
  if(LOGS.length > 200) LOGS.pop();
}

// ===== CONSENSO
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

    const w = weights[k] || 0.6;

    if(s.side === 'BUY') buy += s.confidence * w;
    if(s.side === 'SELL') sell += s.confidence * w;

    used.push(k);
  }

  log(`🗳️ BUY:${buy.toFixed(2)} SELL:${sell.toFixed(2)}`);

  if(buy > 0.6) return { side:'BUY', bots:used };
  if(sell > 0.6) return { side:'SELL', bots:used };

  return null;
}

// ===== BOT MAIN
module.exports = async function runBot(){

  try{

    const base = process.env.BASE_URL;

    // ===== SETTINGS
    const settings = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'getSettings'})
    })).json();

    if(!settings.active){
      log('⏸ BOT OFF');
      return;
    }

    // ===== BALANCE
    const balanceData = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    const balance = parseFloat(balanceData[0]?.available || 0);

    if(!balance || balance <= 0){
      log('❌ balance inválido');
      return;
    }

    if(!START_BALANCE) START_BALANCE = balance;

    const pnlDay = ((balance - START_BALANCE)/START_BALANCE)*100;

    log(`💰 ${balance.toFixed(2)} | Day: ${pnlDay.toFixed(2)}%`);

    // 🚨 KILL SWITCH
    if(pnlDay <= MAX_DAILY_LOSS){
      log('🛑 KILL SWITCH');
      return;
    }

    // 🚫 LIMITES
    if(TRADES_TODAY >= MAX_TRADES_DAY){
      log('⏸ LIMITE ATINGIDO');
      return;
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

      // ===== MARKET FILTER (20)
      const high = Math.max(...closes.slice(-20));
      const low = Math.min(...closes.slice(-20));
      const range20 = (high - low) / price;

      if(range20 < 0.003){
        log('📉 mercado lateral (range)');
        continue;
      }

      // ===== MARKET FILTER (10)
      const range10 = Math.max(...closes.slice(-10)) - Math.min(...closes.slice(-10));
      if(range10 / price < 0.002){
        log('📉 mercado parado');
        continue;
      }

      const features = buildFeatures(closes);

      const decision = analyzeBots(closes);

      if(!decision){
        log('❌ sem consenso');
        continue;
      }

      // ===== CONFIRMAR BREAKOUT
      const last = closes.at(-1);
      const prevHigh = Math.max(...closes.slice(-10, -1));
      const prevLow = Math.min(...closes.slice(-10, -1));

      if(decision.side === 'BUY' && last < prevHigh){
        log('❌ sem breakout BUY');
        continue;
      }

      if(decision.side === 'SELL' && last > prevLow){
        log('❌ sem breakout SELL');
        continue;
      }

      const now = Date.now();

      if(now - LAST_TRADE < 15000){
        log('⏱ cooldown');
        continue;
      }

      const risk = 0.005;
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

  }catch(e){
    log(`🔥 ${e.message}`);
  }
};
