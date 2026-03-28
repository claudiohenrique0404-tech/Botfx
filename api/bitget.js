const { createHmac } = require('crypto');

const BASE = 'https://api.bitget.com';

// memória simples (substitui DB)
let BOT_SETTINGS = {
  risk: 1,
  lev: 3,
  tp: 2,
  sl: 1.5
};

function sign(ts, method, path, body, secret) {
  return createHmac('sha256', secret)
    .update(ts + method.toUpperCase() + path + (body || ''))
    .digest('base64');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

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

  const bg = async (method, path, body) => {
    const bs = body ? JSON.stringify(body) : undefined;
    const r = await fetch(BASE + path, { method, headers: headers(method, path, bs), body: bs });
    const d = await r.json();

    if (!d || d.code !== '00000') {
      throw new Error(d?.msg || 'Bitget error');
    }

    return d;
  };

  try {
    const { action, ...p } = req.body || {};

    // SETTINGS
    if (action === 'getSettings') {
      return res.json(BOT_SETTINGS);
    }

    if (action === 'setSettings') {
      BOT_SETTINGS = { ...BOT_SETTINGS, ...p };
      return res.json({ ok: true });
    }

    // PREÇOS
    if (action === 'allPrices') {
      const r = await fetch(`${BASE}/api/v2/mix/market/tickers?productType=usdt-futures`);
      const d = await r.json();

      return res.json(
        d.data.map(x => ({
          symbol: x.symbol,
          price: parseFloat(x.lastPr || x.last)
        })).filter(x => x.price > 0)
      );
    }

    // POSIÇÕES
    if (action === 'positions') {
      const data = await bg('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
      return res.json(data.data || []);
    }

    // HISTÓRICO
    if (action === 'history') {
      const data = await bg('GET', '/api/v2/mix/order/history-orders?productType=USDT-FUTURES&pageSize=50');
      return res.json(data.data || []);
    }

    // ORDEM
    if (action === 'order') {
      const { symbol, side, quantity } = p;

      const result = await bg('POST', '/api/v2/mix/order/place-order', {
        symbol,
        productType: 'USDT-FUTURES',
        marginCoin: 'USDT',
        side: side === 'BUY' ? 'buy' : 'sell',
        tradeSide: 'open',
        orderType: 'market',
        size: String(quantity),
        leverage: String(BOT_SETTINGS.lev)
      });

      return res.json(result);
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};