const STRAT = require('./strategies');

let LOGS = [];

function log(msg){
  const time = new Date().toLocaleTimeString();
  const entry = `[${time}] ${msg}`;
  console.log(entry);

  LOGS.unshift(entry);
  if(LOGS.length > 80) LOGS.pop();
}

function atr(data){
  let sum=0;
  for(let i=1;i<data.length;i++){
    sum += Math.abs(data[i]-data[i-1]);
  }
  return sum/data.length;
}

// 🔥 EXECUÇÃO REAL COM VALIDAÇÃO
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

  // 🔥 VALIDAR RESPOSTA REAL
  if(!data || data.code !== '00000'){
    log(`❌ ERRO ORDEM ${symbol}: ${JSON.stringify(data)}`);
    return false;
  }

  log(`✅ ORDEM REAL EXECUTADA ${symbol}`);

  return true;
}

module.exports = async (req,res)=>{

  try{

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

    const settings = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'getSettings'})
    })).json();

    if(!settings.active){
      log('⏸ Bot desligado');
      return res.json({ logs: LOGS });
    }

    for(const sym of settings.symbols){

      log(`🔍 Analisar ${sym}`);

      const candles = await (await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'candles',
          symbol: sym,
          tf:'1m'
        })
      })).json();

      if(!candles.length){
        log(`⚠️ ${sym} sem dados`);
        continue;
      }

      const closes = candles.map(c=>+c[4]);

      const trend = STRAT.trendBot(closes);

      if(!trend || trend.confidence < 0.5){
        log(`❌ ${sym} sem sinal`);
        continue;
      }

      log(`🎯 ${trend.side} ${sym}`);

      const vol = atr(closes.slice(-20));
      const risk = balance * (settings.risk/100);

      const size = Math.max(5, risk/(vol || 1));
      const qty = (size/closes.at(-1)).toFixed(4);

      log(`⚖️ size:${size.toFixed(2)} qty:${qty}`);

      const executed = await executeOrder(base, sym, trend.side, qty);

      if(!executed){
        log(`❌ Trade falhou`);
        continue;
      }

      break;
    }

    return res.status(200).json({
      logs: LOGS
    });

  }catch(e){

    log(`🔥 ERRO: ${e.message}`);

    return res.status(200).json({
      logs: LOGS
    });
  }

};
