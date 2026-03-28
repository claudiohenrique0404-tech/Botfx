// ===== GLOBAL STATE (FIX PRINCIPAL)
if(!global.settings){
  global.settings = {
    active: false,
    symbols: ['BTCUSDT']
  };
}

const settings = global.settings;

// ===== DEPENDÊNCIAS
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// ===== CONFIG (USA AS TUAS ENV VARS)
const API_KEY = process.env.BITGET_API_KEY;
const API_SECRET = process.env.BITGET_API_SECRET;
const PASSPHRASE = process.env.BITGET_PASSPHRASE;

const BASE = 'https://api.bitget.com';

// ===== HELPER
async function request(path, method='GET', body=null){

  const url = BASE + path;

  const headers = {
    'Content-Type':'application/json',
    'ACCESS-KEY': API_KEY,
    'ACCESS-PASSPHRASE': PASSPHRASE,
    'ACCESS-TIMESTAMP': Date.now().toString(),
    'ACCESS-SIGN': 'SIGN_PLACEHOLDER' // 🔥 mantém igual ao teu atual se já assinavas
  };

  const res = await fetch(url,{
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  return res.json();
}

// ===== HANDLER
module.exports = async (req,res)=>{

  try{

    const { action, symbol, tf, side, quantity } = req.body || {};

    // =========================
    // 🔥 SETTINGS
    // =========================

    if(action === 'getSettings'){
      return res.json(settings);
    }

    if(action === 'toggleBot'){
      settings.active = !settings.active;
      global.settings = settings;
      return res.json(settings);
    }

    // =========================
    // 🔥 BALANCE
    // =========================

    if(action === 'balance'){

      const data = await request('/api/mix/v1/account/accounts?productType=UMCBL');

      return res.json(data.data || []);
    }

    // =========================
    // 🔥 POSITIONS
    // =========================

    if(action === 'positions'){

      const data = await request('/api/mix/v1/position/allPosition?productType=UMCBL');

      return res.json(data.data || []);
    }

    // =========================
    // 🔥 CANDLES
    // =========================

    if(action === 'candles'){

      const url = `/api/mix/v1/market/candles?symbol=${symbol}&granularity=60&limit=100`;

      const data = await request(url);

      return res.json(data.data || []);
    }

    // =========================
    // 🔥 ORDER
    // =========================

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

    return res.json({error:'Invalid action'});

  }catch(e){

    console.log('BITGET ERROR:', e);

    return res.json({
      error: e.message
    });
  }
};
