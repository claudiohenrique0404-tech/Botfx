const STRAT = require('./strategies');
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

    if(pnlDay <= MAX_DAILY_LOSS){
      log('🛑 KILL SWITCH');
      return;
    }

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

    // 🔥 GERIR POSIÇÕES (NOVO)
    for(const pos of positions){

      const symbol = pos.symbol;
      const entry = parseFloat(pos.openPrice || pos.avgPrice || 0);
      const current = parseFloat(pos.markPrice || pos.last || 0);
      const size = parseFloat(pos.total || pos.size || 0);

      if(!entry || !current || !size) continue;

      const pnl = ((current - entry) / entry) * 100;

      log(`📊 ${symbol} PnL: ${pnl.toFixed(2)}%`);

      if(pnl > 0.8){
        log(`✅ TAKE PROFIT ${symbol}`);

        await fetch(base+'/api/bitget',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            action:'order',
            symbol,
            side:'SELL',
            quantity: Math.abs(size),
            close:true
          })
        });

        continue;
      }

      if(pnl < -0.5){
        log(`🛑 STOP LOSS ${symbol}`);

        await fetch(base+'/api/bitget',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            action:'order',
            symbol,
            side:'SELL',
            quantity: Math.abs(size),
            close:true
          })
        });

        continue;
      }
    }

    // ===== NOVAS ENTRADAS
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

      const high = Math.max(...closes.slice(-20));
      const low = Math.min(...closes.slice(-20));
      const range20 = (high - low) / price;

      if(range20 < 0.003){
        log('📉 mercado lateral');
        continue;
      }

      const decision = analyzeBots(closes);

      if(!decision){
        log('❌ sem consenso');
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

      log(`🚀 ${decision.side} ${sym}`);

      LAST_TRADE = Date.now();
      TRADES_TODAY++;

      await saveTrade({
        symbol:sym,
        side:decision.side,
        qty,
        bots:decision.bots,
        time:Date.now()
      });

      await saveEquity(balance);

      break;
    }

  }catch(e){
    log(`🔥 ${e.message}`);
  }
};
