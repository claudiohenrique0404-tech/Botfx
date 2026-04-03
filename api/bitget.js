const { createHmac } = require('crypto');
const fetch = global.fetch || require('node-fetch');

const BASE = 'https://api.bitget.com';

// ===== SETTINGS =====
if (!global.BOT_SETTINGS) {
  global.BOT_SETTINGS = {
    active: true,
    risk: 1,
    lev: 5,
    symbols: [
      'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT',
      'BNBUSDT','ADAUSDT','AVAXUSDT','LINKUSDT',
      'DOTUSDT','ATOMUSDT'
    ]
  };
}

function getSettings()  { return global.BOT_SETTINGS; }
function setSettings(s) { global.BOT_SETTINGS = { ...global.BOT_SETTINGS, ...s }; }

// ===== SIGN =====
function sign(ts, method, path, body, secret) {
  return createHmac('sha256', secret)
    .update(ts + method.toUpperCase() + path + (body || ''))
    .digest('base64');
}

// ===== HANDLER =====
module.exports = async (req, res) => {
  try {
    let body = req.body;
    if (!body || typeof body === 'string') {
      try { body = JSON.parse(req.body); } catch { body = {}; }
    }

    const { action, ...p } = body;

    const KEY  = process.env.BITGET_API_KEY;
    const SEC  = process.env.BITGET_API_SECRET;
    const PASS = process.env.BITGET_PASSPHRASE;

    if (!KEY || !SEC || !PASS)
      return res.status(500).json({ error: 'Missing API keys' });

    const hdrs = (method, path, bodyStr) => {
      const ts = Date.now().toString();
      return {
        'ACCESS-KEY': KEY,
        'ACCESS-SIGN': sign(ts, method, path, bodyStr || '', SEC),
        'ACCESS-TIMESTAMP': ts,
        'ACCESS-PASSPHRASE': PASS,
        'Content-Type': 'application/json',
      };
    };

    const bg = async (method, path, body) => {
      const bs = body ? JSON.stringify(body) : undefined;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      try {
        const r = await fetch(BASE + path, {
          method,
          headers: hdrs(method, path, bs || ''),
          body: bs,
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        return await r.json();
      } catch(e) {
        clearTimeout(timer);
        return { code: 'NET_ERR', msg: e.message };
      }
    };

    if (action === 'balance') {
      const d = await bg('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
      const data = (d.data || []).map(acc => ({
        ...acc,
        available: acc.usdtEquity || acc.available,
      }));
      return res.json(data);
    }

    if (action === 'positions') {
      const d = await bg('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
      return res.json((d.data || []).filter(p => parseFloat(p.total) > 0));
    }

    // ===== ORDER =====
    if (action === 'order') {
      const sym      = p.symbol;
      const side     = p.side === 'BUY' ? 'buy' : 'sell';
      const holdSide = p.side === 'BUY' ? 'long' : 'short';
      const lev      = String(getSettings().lev || 3);
      const pt       = 'USDT-FUTURES';

      // ✅ FIX 1 — SIZE VALIDATION
      const safeSize = Number(p.quantity);
      if (!safeSize || safeSize <= 0) {
        console.error(`❌ SIZE INVÁLIDO ${sym}`);
        return res.json({ code: 'SIZE_ERR' });
      }

      await bg('POST', '/api/v2/mix/account/set-margin-mode', {
        symbol: sym, productType: pt, marginCoin: 'USDT', marginMode: 'isolated',
      }).catch(() => {});

      await new Promise(r => setTimeout(r, 200));

      await bg('POST', '/api/v2/mix/account/set-leverage', {
        symbol: sym, productType: pt, marginCoin: 'USDT', leverage: lev,
      });

      // ✅ FIX 2 — usar safeSize
      const orderRes = await bg('POST', '/api/v2/mix/order/place-order', {
        symbol: sym,
        productType: pt,
        marginCoin: 'USDT',
        marginMode: 'isolated',
        side,
        tradeSide: 'open',
        orderType: 'market',
        size: safeSize.toFixed(4),
      });

      if (!orderRes?.data?.orderId) return res.json(orderRes);

      console.log(`✅ ORDER ${side} ${sym} qty:${safeSize}`);

      await new Promise(r => setTimeout(r, 800));

      const price = parseFloat(p.price || 0);
      if (price > 0) {
        const slPrice = price * 0.994;
        const tpPrice = price * 1.02;

        // ✅ FIX 3 — usar safeSize no SL/TP
        const tpslBase = {
          symbol: sym,
          productType: pt,
          marginCoin: 'USDT',
          holdSide,
          triggerType: 'mark_price',
          executePrice: '0',
          size: safeSize.toFixed(4),
        };

        await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
          ...tpslBase,
          planType: 'loss_plan',
          triggerPrice: String(slPrice),
        });

        await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
          ...tpslBase,
          planType: 'profit_plan',
          triggerPrice: String(tpPrice),
        });

        console.log('🛡️ SL/TP enviados');
      }

      return res.json(orderRes);
    }

    if (action === 'close') {
      return res.json(await bg('POST', '/api/v2/mix/order/close-positions', {
        symbol: p.symbol,
        productType: 'USDT-FUTURES',
        holdSide: p.holdSide,
      }));
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
};
