const STRAT = require('./strategies');
const ML = require('./ml');
const { saveTrade, saveEquity } = require('./db');

let LOGS = [];
let LAST_TRADE = 0;

function log(msg){
  const time = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const entry = `[${time}] ${msg}`;
  console.log(entry);

  LOGS.unshift(entry);
  if(LOGS.length > 100) LOGS.pop();
}

// 🔥 mínimos por ativo (CRÍTICO)
const MIN_QTY = {
  BTCUSDT: 0.001,
  ETHUSDT: 0.01,
  SOLUSDT: 0.1,
  XRPUSDT: 10
};

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
      return res.json({logs:LOGS});
    }

    // ===== BALANCE =====
    const balanceData = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    const balance = parseFloat(balanceData[0]?.available || 0);

    log(`💰 Balance: ${balance.toFixed(2)}`);

    // ===== POSITIONS =====
    const positions = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    const openSymbols = positions.map(p => p.symbol);

    log(`📊 Posições abertas: ${openSymbols.length}`);

    if(openSymbols.length >= 3){
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

      const ml = ML.optimize(closes);

      log(`🧠 winrate ${ml.winrate.toFixed(2)}`);

      if(ml.winrate < 0.55){
        log('🧠 bloqueado');
        continue;
      }

      const signal = STRAT.trendBot(closes);

      if(!signal){
        log('❌ sem sinal');
        continue;
      }

      const now = Date.now();

      if(now - LAST_TRADE < 8000){
        log('⏱ cooldown ativo');
        continue;
      }

      // ===== SIZE =====
      const riskUSD = balance * 0.02;
      let qty = riskUSD / price;

      // 🔥 FORÇA MÍNIMO
      if(qty < MIN_QTY[sym]){
        qty = MIN_QTY[sym];
        log(`⚠️ ajustado mínimo ${qty}`);
      }

      qty = Number(qty.toFixed(4));

      log(`⚖️ qty:${qty}`);

      // ===== ORDER =====
      const r = await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:sym,
          side:signal.side,
          quantity:qty
        })
      });

      const data = await r.json();

      if(data.code !== '00000'){
        log(`❌ ERRO ORDEM: ${data.msg}`);
        continue;
      }

      LAST_TRADE = Date.now();

      log(`✅ ${signal.side} ${sym}`);

      await saveTrade({
        symbol:sym,
        side:signal.side,
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
