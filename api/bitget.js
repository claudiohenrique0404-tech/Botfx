const crypto = require('crypto');

if(!global.settings){
  global.settings = { active:false };
}

const settings = global.settings;

// ===== CONFIG
const API_KEY = process.env.BITGET_API_KEY;
const API_SECRET = process.env.BITGET_API_SECRET;
const PASSPHRASE = process.env.BITGET_PASSPHRASE;

const BASE = 'https://api.bitget.com';

// ===== SIGN (V2)
function sign(timestamp, method, path, body=''){
  const message = timestamp + method + path + body;
  return crypto.createHmac('sha256', API_SECRET).update(message).digest('base64');
}

// ===== REQUEST
async function request(path, method='GET', body=null){

  const timestamp = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';

  const headers = {
    'ACCESS-KEY': API_KEY,
    'ACCESS-SIGN': sign(timestamp, method, path, bodyStr),
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': PASSPHRASE,
    'Content-Type': 'application/json'
  };

  const res = await fetch(BASE + path,{
    method,
    headers,
    body: bodyStr || undefined
  });

  const data = await res.json();

  console.log('BITGET V2:', path, data);

  return data;
}

// ===== HANDLER
module.exports = async (req,res)=>{

  try{

    const { action, symbol, side, quantity } = req.body || {};

    // ===== SETTINGS
    if(action === 'getSettings'){
      return res.json(settings);
    }

    if(action === 'toggleBot'){
      settings.active = !settings.active;
      return res.json(settings);
    }

    // ===== BALANCE (V2)
    if(action === 'balance'){

      const data = await request('/api/v2/mix/account/accounts?productType=USDT-FUTURES');

      return res.json(data.data || []);
    }

    // ===== POSITIONS (V2)
    if(action === 'positions'){

      const data = await request('/api/v2/mix/position/all-position?productType=USDT-FUTURES');

      return res.json(data.data || []);
    }

    // ===== 🔥 CANDLES (FIX FINAL)
    if(action === 'candles'){

      const data = await request(
        `/api/v2/mix/market/candles?symbol=${symbol}&granularity=60&limit=100`
      );

      return res.json(data.data || []);
    }

    // ===== ORDER (V2)
    if(action === 'order'){

      const pair = symbol.replace('USDT','USDT_UMCBL');

      const body = {
        symbol: pair,
        productType: 'USDT-FUTURES',
        marginMode: 'crossed',
        marginCoin: 'USDT',
        size: quantity,
        side: side.toLowerCase(), // buy / sell / close_long / close_short
        orderType: 'market'
      };

      const data = await request('/api/v2/mix/order/place-order','POST',body);

      return res.json(data);
    }

    return res.json({error:'invalid action'});

  }catch(e){
    console.log('BITGET ERROR:', e);
    return res.json({error:e.message});
  }
};