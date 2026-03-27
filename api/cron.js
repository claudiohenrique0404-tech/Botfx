const STRAT = require('./strategies');

let LOGS = [];

function log(msg){
  const time = new Date().toLocaleTimeString('pt-PT', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const entry = `[${time}] ${msg}`;
  console.log(entry);

  LOGS.unshift(entry);
  if(LOGS.length > 100) LOGS.pop();
}

function atr(data){
  let sum=0;
  for(let i=1;i<data.length;i++){
    sum += Math.abs(data[i]-data[i-1]);
  }
  return sum/data.length;
}

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

    // ===== BALANCE =====
    const balanceData = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    let balance = 0;

    if(balanceData.length){
      const usdt = balanceData.find(b=>b.marginCoin === 'USDT');
      balance = parseFloat(usdt.available || 0);
    }

    log(`💰 Balance: $${balance.toFixed(2)}`);

    // ===== POSITIONS =====
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

    // 🔥 LIMITADOR
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

    // ===== LOOP =====
    for(const sym of settings.symbols){

      log(`🔍 ${sym}`);

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
        log(`⚠️ sem dados`);
        continue;
      }

      const closes = candles.map(c=>+c[4]);

      const signal = STRAT.trendBot(closes);

      if(!signal || signal.confidence < 0.55){
        log(`❌ sem sinal`);
        continue;
      }

      log(`🎯 ${signal.side}`);

      // 🔥 RISCO CONSISTENTE
      const risk = balance * 0.01; // 1%

      const vol = atr(closes.slice(-20));
      const size = Math.max(5, risk/(vol || 1));
      const qty = (size/closes.at(-1)).toFixed(4);

      log(`⚖️ size:${size.toFixed(2)} qty:${qty}`);

      const executed = await executeOrder(base, sym, signal.side, qty);

      if(!executed) continue;

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
