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

// ===== SIGN
function sign(timestamp, method, path, body=''){
  const msg = timestamp + method + path + body;
  return crypto
    .createHmac('sha256', API_SECRET)
    .update(msg)
    .digest('base64');
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

  return res.json();
}

// ===== HANDLER
module.exports = async (req,res)=>{

  try{

    const { action, symbol, side, quantity } = req.body || {};

    // SETTINGS
    if(action === 'getSettings'){
      return res.json(settings);
    }

    if(action === 'toggleBot'){
      settings.active = !settings.active;
      return res.json(settings);
    }

    // BALANCE
    if(action === 'balance'){
      const data = await request('/api/mix/v1/account/accounts?productType=UMCBL');
      return res.json(data.data || []);
    }

    // POSITIONS
    if(action === 'positions'){
      const data = await request('/api/mix/v1/position/allPosition?productType=UMCBL');
      return res.json(data.data || []);
    }

    // CANDLES
    if(action === 'candles'){
      const data = await request(`/api/mix/v1/market/candles?symbol=${symbol}&granularity=60&limit=100`);
      return res.json(data.data || []);
    }

    // ===== 🔥 REAL ORDER
    if(action === 'order'){

      const body = {
        symbol,
        marginCoin: 'USDT',
        size: quantity,
        side: side.toLowerCase(),
        orderType: 'market',
        timeInForceValue: 'normal'
      };

      const data = await request('/api/mix/v1/order/placeOrder','POST',body);

      return res.json(data);
    }

    return res.json({error:'invalid action'});

  }catch(e){
    return res.json({error:e.message});
  }
};