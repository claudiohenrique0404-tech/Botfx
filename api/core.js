const { createHmac } = require('crypto');

if(!global.DB){
  global.DB = {
    settings:{active:false},
    logs:[],
    trades:[],
    equity:[]
  };
}

const DB = global.DB;

function log(msg){
  const t = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const e = `[${t}] ${msg}`;
  console.log(e);

  DB.logs.unshift(e);
  if(DB.logs.length > 200) DB.logs.pop();
}

// ===== STRATEGY SIMPLES
function decision(closes){

  const avg = closes.slice(-20).reduce((a,b)=>a+b)/20;
  const price = closes.at(-1);

  if(price > avg) return 'BUY';
  if(price < avg) return 'SELL';

  return null;
}

// ===== BITGET SIGN
function sign(ts, method, path, body, secret){
  return createHmac('sha256', secret)
    .update(ts + method.toUpperCase() + path + (body||''))
    .digest('base64');
}

module.exports = async (req,res)=>{

  const { action } = req.body || {};

  const BASE = 'https://api.bitget.com';

  const KEY  = process.env.BITGET_API_KEY;
  const SEC  = process.env.BITGET_API_SECRET;
  const PASS = process.env.BITGET_PASSPHRASE;

  const headers = (method,path,body)=>{
    const ts = Date.now().toString();
    return {
      'ACCESS-KEY':KEY,
      'ACCESS-SIGN':sign(ts,method,path,body||'',SEC),
      'ACCESS-TIMESTAMP':ts,
      'ACCESS-PASSPHRASE':PASS,
      'Content-Type':'application/json'
    };
  };

  const bg = async (method,path)=>{
    const r = await fetch(BASE+path,{
      method,
      headers:headers(method,path)
    });
    return await r.json();
  };

  // ===== SETTINGS
  if(action==='getSettings'){
    return res.json(DB.settings);
  }

  if(action==='toggleBot'){
    DB.settings.active = !DB.settings.active;
    return res.json(DB.settings);
  }

  // ===== LOGS
  if(action==='logs'){
    return res.json(DB.logs);
  }

  // ===== STATS
  if(action==='stats'){
    return res.json({
      trades:DB.trades,
      equity:DB.equity
    });
  }

  // ===== RUN BOT
  if(action==='run'){

    if(!DB.settings.active){
      log('⏸ BOT OFF');
      return res.json(DB.logs);
    }

    const bal = await bg(
      'GET',
      '/api/v2/mix/account/accounts?productType=USDT-FUTURES'
    );

    const balance = parseFloat(bal.data?.[0]?.available || 0);

    DB.equity.push({value:balance,time:Date.now()});

    log(`💰 ${balance}`);

    const symbols = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'];

    for(const sym of symbols){

      log(`🔍 ${sym}`);

      const c = await fetch(
        `${BASE}/api/v2/mix/market/history-candles?symbol=${sym}&productType=USDT-FUTURES&granularity=1m&limit=50`
      );

      const d = await c.json();

      if(!d.data){
        log('❌ sem candles');
        continue;
      }

      const closes = d.data.map(x=>+x[4]);

      const side = decision(closes);

      if(!side){
        log('❌ sem sinal');
        continue;
      }

      const price = closes.at(-1);

      const qty = ((balance * 0.01)/price).toFixed(4);

      log(`🚀 ${side} ${sym}`);

      DB.trades.push({
        symbol:sym,
        side,
        qty,
        time:Date.now()
      });

      break;
    }

    return res.json(DB.logs);
  }

  return res.json({error:'invalid action'});
};
