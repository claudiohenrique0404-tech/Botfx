const { saveEquity } = require('./db');

if(!global.LOGS) global.LOGS = [];

let LOGS = global.LOGS;

function log(msg){
  const t = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const e = `[${t}] ${msg}`;
  console.log(e);
  LOGS.unshift(e);
  if(LOGS.length > 200) LOGS.pop();
}

module.exports = async (req,res)=>{

  try{

    if(req.query.mode === 'logs'){
      return res.json({logs:LOGS});
    }

    const base = `https://${req.headers.host}`;

    // ===== BALANCE
    const balanceData = await (await fetch(base + '/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    const balance = parseFloat(balanceData?.[0]?.available || 0);

    log(`💰 Balance ${balance}`);

    // ===== POSITIONS
    const positions = await (await fetch(base + '/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    log(`📊 Positions ${positions.length}`);

    // =========================
    // 🔥 TESTE FORÇADO
    // =========================

    if(positions.length === 0){

      const price = 50000; // fake price para teste
      const qty = ((balance * 0.001)/price).toFixed(4);

      log(`🧪 TEST TRADE BUY BTCUSDT`);

      await fetch(base + '/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:'BTCUSDT',
          side:'BUY',
          quantity:qty
        })
      });

    }else{
      log(`⏸️ Já existe posição`);
    }

    await saveEquity(balance);

    return res.json({logs:LOGS});

  }catch(e){
    log(`🔥 ${e.message}`);
    return res.json({logs:LOGS});
  }
};