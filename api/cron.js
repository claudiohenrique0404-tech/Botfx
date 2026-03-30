// ===== IMPORTS =====
const STRAT = require('./strategies');
const { saveTrade, saveEquity, setTradePnL } = require('./db');
const BRAIN = require('./brain');

const fetch = global.fetch || require('node-fetch');

// ===== LOGS =====
if(!global.LOGS){
  global.LOGS = [];
}
let LOGS = global.LOGS;

// ===== STATE =====
let LAST_TRADE = 0;
let TRADES_TODAY = 0;
let START_BALANCE = null;

const MAX_TRADES_DAY = 10;
const MAX_DAILY_LOSS = -3;

// ===== LOGGER =====
function log(msg){
  const t = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const e = `[${t}] ${msg}`;
  console.log(e);

  LOGS.unshift(e);
  if(LOGS.length > 200) LOGS.pop();
}

// ===== CONSENSO =====
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

  if(buy > sell && buy > 0.55) return { side:'BUY', bots:used, buy, sell };
  if(sell > buy && sell > 0.55) return { side:'SELL', bots:used, buy, sell };

  return null;
}

// ===== MAIN BOT =====
module.exports = async function runBot(){

  try{

    const base = process.env.BASE_URL;

    const settings = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'getSettings'})
    })).json();

    if(!settings.active){
      log('⏸ BOT OFF');
      return;
    }

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

    const positions = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    for(const pos of positions){

      const symbol = pos.symbol;
      const entry = parseFloat(pos.openPrice || pos.avgPrice || 0);
      const current = parseFloat(pos.markPrice || pos.last || 0);
      const size = parseFloat(pos.total || pos.size || 0);

      if(!entry || !current || !size) continue;

      const pnl = ((current - entry) / entry) * 100;

      log(`📊 ${symbol} PnL: ${pnl.toFixed(2)}%`);

      if(pnl > 0.8 || pnl < -0.5){

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

        log(pnl > 0 ? `✅ TP ${symbol}` : `🛑 SL ${symbol}`);

        const trade = setTradePnL(symbol, pnl);

        if(trade?.bots){
          for(const b of trade.bots){
            BRAIN.updateBot(b, pnl);
          }
        }

        continue;
      }
    }

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

      if(!STRAT.marketFilter(closes)){
        log('😴 mercado parado');
        continue;
      }

      const decision = analyzeBots(closes);

      if(!decision){
        log('❌ sem consenso');
        continue;
      }

      const minOrder = 5;
      const maxRisk = 0.05;

      const confidence = decision.side === 'BUY' ? decision.buy : decision.sell;

      let strength = (confidence - 0.55) / (1 - 0.55);
      if(strength < 0) strength = 0;
      if(strength > 1) strength = 1;

      let orderValue = balance * (0.01 + strength * (maxRisk - 0.01));

      if(orderValue < minOrder){
        orderValue = minOrder;
      }

      // 🔥 FIX MIN ORDER
      let qty = orderValue / price;

      qty = Math.ceil(qty * 1000) / 1000;

      if(qty * price < 5){
        qty = 5 / price;
        qty = Math.ceil(qty * 1000) / 1000;
      }

      qty = qty.toFixed(3);

      log(`📊 conf:${confidence.toFixed(2)} size:${orderValue.toFixed(2)}$ qty:${qty}`);

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

      await saveTrade({
        symbol:sym,
        side:decision.side,
        qty,
        bots:decision.bots,
        time:Date.now()
      });

      await saveEquity(balance);

      TRADES_TODAY++;
      LAST_TRADE = Date.now();

      break;
    }

  }catch(e){
    log(`🔥 ${e.message}`);
  }
};
