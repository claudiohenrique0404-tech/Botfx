const STRAT = require('./strategies');
const ML = require('./ml');
const { saveTrade, saveEquity } = require('./db');

let LOGS = [];
let LAST_TRADE = 0;

// 🔥 RISK CONTROL
let DAILY_START = null;
let DAILY_PNL = 0;
const MAX_DAILY_LOSS = -3; // -3%
const MAX_POSITIONS = 3;

// mínimos por ativo
const MIN_QTY = {
  BTCUSDT: 0.001,
  ETHUSDT: 0.01,
  SOLUSDT: 0.1,
  XRPUSDT: 10
};

function log(msg){
  const time = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const entry = `[${time}] ${msg}`;
  console.log(entry);

  LOGS.unshift(entry);
  if(LOGS.length > 100) LOGS.pop();
}

// ===== VOTING SYSTEM =====
function getConsensus(closes){

  const signals = {
    trend: STRAT.trendBot(closes),
    rsi: STRAT.rsiBot(closes),
    momentum: STRAT.momentumBot(closes)
  };

  let buy = 0;
  let sell = 0;

  for(const k in signals){
    const s = signals[k];
    if(!s) continue;

    if(s.side === 'BUY') buy += s.confidence;
    if(s.side === 'SELL') sell += s.confidence;
  }

  log(`🗳️ BUY:${buy.toFixed(2)} SELL:${sell.toFixed(2)}`);

  if(buy > sell && buy >= 1.2) return 'BUY';
  if(sell > buy && sell >= 1.2) return 'SELL';

  return null;
}

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
      return res.json({logs:LOGS});
    }

    // ===== BALANCE =====
    const balanceData = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    const balance = parseFloat(balanceData[0]?.available || 0);

    // init daily tracking
    if(!DAILY_START) DAILY_START = balance;

    DAILY_PNL = ((balance - DAILY_START)/DAILY_START)*100;

    log(`💰 Balance: ${balance.toFixed(2)} | PnL diário: ${DAILY_PNL.toFixed(2)}%`);

    // ===== KILL SWITCH =====
    if(DAILY_PNL <= MAX_DAILY_LOSS){
      log('🛑 KILL SWITCH ATIVO');
      return res.json({logs:LOGS});
    }

    // ===== POSITIONS =====
    const positions = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    const openSymbols = positions.map(p => p.symbol);

    log(`📊 Posições abertas: ${openSymbols.length}`);

    if(openSymbols.length >= MAX_POSITIONS){
      log('⛔ Máx posições atingido');
      return res.json({logs:LOGS});
    }

    for(const sym of settings.symbols){

      if(openSymbols.includes(sym)){
        log(`⚠️ Já em posição: ${sym}`);
        continue;
      }

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

      // ===== ML FILTER =====
      const ml = ML.optimize(closes);

      log(`🧠 ML winrate ${ml.winrate.toFixed(2)}`);

      if(ml.winrate < 0.55){
        log('🧠 bloqueado');
        continue;
      }

      // ===== CONSENSUS =====
      const side = getConsensus(closes);

      if(!side){
        log('❌ sem consenso');
        continue;
      }

      // ===== COOLDOWN =====
      const now = Date.now();

      if(now - LAST_TRADE < 10000){
        log('⏱ cooldown ativo');
        continue;
      }

      // ===== POSITION SIZE =====
      const riskUSD = balance * 0.01;
      let qty = riskUSD / price;

      if(qty < MIN_QTY[sym]){
        qty = MIN_QTY[sym];
      }

      qty = Number(qty.toFixed(4));

      log(`⚖️ ${sym} qty:${qty}`);

      // ===== EXECUTE =====
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
        log(`❌ ERRO: ${data.msg}`);
        continue;
      }

      LAST_TRADE = Date.now();

      log(`✅ ${side} ${sym}`);

      await saveTrade({
        symbol:sym,
        side,
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
