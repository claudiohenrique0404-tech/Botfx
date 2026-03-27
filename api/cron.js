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

    log(`💰 Balance: ${balance.toFixed(2)}`);

    // ===== POSITIONS =====
    const positions = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    const openSymbols = positions.map(p => p.symbol);

    log(`📊 Posições abertas: ${openSymbols.length}`);

    // ===== RISK LIMIT =====
    if(openSymbols.length >= 3){
      log('⛔ Máx posições atingido');
      return res.json({logs:LOGS});
    }

    for(const sym of settings.symbols){

      // ❌ evitar duplicar posição
      if(openSymbols.includes(sym)){
        log(`⚠️ Já em posição: ${sym}`);
        continue;
      }

      log(`🔍 ${sym}`);

      // ===== MARKET DATA =====
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

      // ===== ML FILTER =====
      const ml = ML.optimize(closes);

      log(`🧠 winrate ${ml.winrate.toFixed(2)}`);

      if(ml.winrate < 0.55){
        log('🧠 bloqueado');
        continue;
      }

      // ===== STRATEGY =====
      const signal = STRAT.trendBot(closes);

      if(!signal){
        log('❌ sem sinal');
        continue;
      }

      // ===== COOLDOWN =====
      const now = Date.now();

      if(now - LAST_TRADE < 8000){
        log('⏱ cooldown ativo');
        continue;
      }

      // ===== SIZE CONTROL =====
      const riskSize = balance * 0.02; // 2% por trade
      const sizeUSD = Math.max(5, riskSize);

      const qty = (sizeUSD / closes.at(-1)).toFixed(4);

      log(`⚖️ size:${sizeUSD.toFixed(2)} qty:${qty}`);

      // ===== EXECUTION =====
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
        log(`❌ ERRO ORDEM: ${JSON.stringify(data)}`);
        continue;
      }

      LAST_TRADE = Date.now();

      log(`✅ ${signal.side} ${sym}`);

      // ===== SAVE =====
      await saveTrade({
        symbol:sym,
        side:signal.side,
        qty,
        time:Date.now()
      });

      await saveEquity(balance);

      break; // só 1 trade por ciclo
    }

    res.json({logs:LOGS});

  }catch(e){
    log(`🔥 ${e.message}`);
    res.json({logs:LOGS});
  }
};
