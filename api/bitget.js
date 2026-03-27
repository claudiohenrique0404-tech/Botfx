const { createHmac } = require('crypto');

const BASE = 'https://api.bitget.com';

let BOT_SETTINGS = {
  risk: 2,
  lev: 3,
  tpDollar: 2,
  slDollar: 1,
  symbols: ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT'],
  maxPositions: 2
};

// ===== SIGN =====
function sign(ts, method, path, body, secret) {
  return createHmac('sha256', secret)
    .update(ts + method.toUpperCase() + path + (body || ''))
    .digest('base64');
}

module.exports = async (req, res) => {

  try{

    const { action, ...p } = req.body || {};

    const KEY  = process.env.BITGET_API_KEY;
    const SEC  = process.env.BITGET_API_SECRET;
    const PASS = process.env.BITGET_PASSPHRASE;

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
      return res.json(BOT_SETTINGS);
    }

    if (action === 'setSettings') {
      BOT_SETTINGS = { ...BOT_SETTINGS, ...p };
      return res.json({ ok:true });
    }

    // ===== BALANCE =====
    if (action === 'balance') {
      const d = await bg(
        'GET',
        '/api/v2/mix/account/accounts?productType=USDT-FUTURES'
      );
      return res.json(d.data || []);
    }

    // ===== CANDLES (🔥 FIX REAL) =====
    if (action === 'candles') {

      const url = `${BASE}/api/v2/mix/market/history-candles?symbol=${p.symbol}&productType=USDT-FUTURES&granularity=${p.tf}&limit=100`;

      const r = await fetch(url);
      const d = await r.json();

      return res.json(d.data || []);
    }

    // ===== POSITIONS =====
    if (action === 'positions') {
      const d = await bg(
        'GET',
        '/api/v2/mix/position/all-position?productType=USDT-FUTURES'
      );
      return res.json(d.data || []);
    }

    // ===== ORDER =====
    if (action === 'order') {

      const body = JSON.stringify({
        symbol: p.symbol,
        productType: 'USDT-FUTURES',
        marginCoin: 'USDT',
        side: p.side === 'BUY' ? 'buy' : 'sell',
        tradeSide: 'open',
        orderType: 'market',
        size: String(p.quantity),
        leverage: String(BOT_SETTINGS.lev)
      });

      const r = await fetch(BASE + '/api/v2/mix/order/place-order', {
        method: 'POST',
        headers: headers(
          'POST',
          '/api/v2/mix/order/place-order',
          body
        ),
        body
      });

      const data = await r.json();

      console.log('📦 ORDER:', data);

      return res.json(data);
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch(e){
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
