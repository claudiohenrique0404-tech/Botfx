const { createHmac } = require('crypto');
const fetch = global.fetch || require('node-fetch');

const BASE = 'https://api.bitget.com';

// 🔥 SETTINGS GLOBAIS
if(!global.BOT_SETTINGS){
  global.BOT_SETTINGS = {
    active: false,
    risk: 1,
    lev: 3,
    symbols: ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT']
  };
}

function getSettings(){
  return global.BOT_SETTINGS;
}

function setSettings(newSettings){
  global.BOT_SETTINGS = { ...global.BOT_SETTINGS, ...newSettings };
}

// ===== SIGN =====
function sign(ts, method, path, body, secret) {
  return createHmac('sha256', secret)
    .update(ts + method.toUpperCase() + path + (body || ''))
    .digest('base64');
}

module.exports = async (req, res) => {

  try{

    // 🔥 FIX BODY VERCEL
    let body = req.body;

    if (!body || typeof body === "string") {
      try {
        body = JSON.parse(req.body);
      } catch {
        body = {};
      }
    }

    const { action, ...p } = body;

    const KEY  = process.env.BITGET_API_KEY;
    const SEC  = process.env.BITGET_API_SECRET;
    const PASS = process.env.BITGET_PASSPHRASE;

    if (!KEY || !SEC || !PASS) {
      return res.status(500).json({ error: 'Missing API keys' });
    }

    const headers = (method, path, body) => {
      const ts = Date.now().toString();
      return {
        'ACCESS-KEY': KEY,
        'ACCESS-SIGN': sign(ts, method, path, body || '', SEC),
        'ACCESS-TIMESTAMP': ts,
        'ACCESS-PASSPHRASE': PASS,
        'Content-Type': 'application/json'
      };
    };

    const bg = async (method, path) => {
      const r = await fetch(BASE + path, {
        method,
        headers: headers(method, path)
      });
      return await r.json();
    };

    // ===== SETTINGS =====
    if (action === 'getSettings') {
      return res.json(getSettings());
    }

    if (action === 'toggleBot') {
      const current = getSettings().active;
      setSettings({ active: !current });
      return res.json({ active: !current });
    }

    // ===== BALANCE =====
    if (action === 'balance') {
      const d = await bg('GET','/api/v2/mix/account/accounts?productType=USDT-FUTURES');
      return res.json(d.data || []);
    }

    // ===== CANDLES =====
    if (action === 'candles') {
      const url = `${BASE}/api/v2/mix/market/history-candles?symbol=${p.symbol}&productType=USDT-FUTURES&granularity=${p.tf}&limit=100`;
      const r = await fetch(url);
      const d = await r.json();
      return res.json(d.data || []);
    }

    // ===== POSITIONS =====
    if (action === 'positions') {
      const d = await bg('GET','/api/v2/mix/position/all-position?productType=USDT-FUTURES');
      return res.json(d.data || []);
    }

    // ===== ORDER =====
    if (action === 'order') {

      // 🔥 lado correto (abrir vs fechar)
      const side = p.close
        ? (p.side === 'BUY' ? 'sell' : 'buy')
        : (p.side === 'BUY' ? 'buy' : 'sell');

      // 🔥 posição (necessário para futures)
      const positionSide = p.side === 'BUY' ? 'long' : 'short';

      const orderBody = JSON.stringify({
        symbol: p.symbol,
        productType: 'USDT-FUTURES',
        marginCoin: 'USDT',
        marginMode: 'isolated',
        side,
        positionSide,
        tradeSide: p.close ? 'close' : 'open',
        orderType: 'market',
        size: String(Math.abs(p.quantity)),
        leverage: "3",
        reduceOnly: p.close ? true : false
      });

      const r = await fetch(BASE + '/api/v2/mix/order/place-order', {
        method: 'POST',
        headers: headers('POST','/api/v2/mix/order/place-order', orderBody),
        body: orderBody
      });

      const data = await r.json();

      // 🔥 DEBUG REAL (IMPORTANTE)
      if(data.code !== '00000'){
        console.error('BITGET ERROR:', data);
      }

      return res.json(data);
    }

    return res.status(400).json({ error:'Invalid action' });

  }catch(e){
    return res.status(500).json({ error:e.message });
  }
};
