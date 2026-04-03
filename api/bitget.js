// (mantive tudo igual até à parte do TPSL — só mostro completo já corrigido)

const { createHmac } = require('crypto');
const fetch = global.fetch || require('node-fetch');

const BASE = 'https://api.bitget.com';

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

function sign(ts, method, path, body, secret) {
  return createHmac('sha256', secret)
    .update(ts + method.toUpperCase() + path + (body || ''))
    .digest('base64');
}

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
      const bs  = body ? JSON.stringify(body) : undefined;
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
        console.error(`bg error [${method} ${path}]:`, e.message);
        return { code: 'NET_ERR', msg: e.message };
      }
    };

    // ===== ORDER =====
    if (action === 'order') {
      const sym      = p.symbol;
      const side     = p.side === 'BUY' ? 'buy' : 'sell';
      const holdSide = p.side === 'BUY' ? 'long' : 'short';
      const lev      = String(getSettings().lev || 3);
      const pt       = 'USDT-FUTURES';

      await bg('POST', '/api/v2/mix/account/set-margin-mode', {
        symbol: sym, productType: pt, marginCoin: 'USDT', marginMode: 'isolated',
      });

      await new Promise(r => setTimeout(r, 300));

      await bg('POST', '/api/v2/mix/account/set-leverage', {
        symbol: sym, productType: pt, marginCoin: 'USDT', leverage: lev, holdSide,
      });

      await new Promise(r => setTimeout(r, 300));

      const orderRes = await bg('POST', '/api/v2/mix/order/place-order', {
        symbol: sym,
        productType: pt,
        marginCoin: 'USDT',
        marginMode: 'isolated',
        side,
        tradeSide: 'open',
        orderType: 'market',
        size: String(Math.abs(p.quantity)),
      });

      if (!orderRes?.data?.orderId) {
        console.error('ORDER FAIL:', orderRes);
        return res.json(orderRes);
      }

      console.log(`✅ ORDER ${side} ${sym} qty:${p.quantity}`);

      await new Promise(r => setTimeout(r, 800));

      const price = parseFloat(p.price || 0);
      if (price <= 0) return res.json(orderRes);

      const dp = price > 100 ? 2 : 4;

      const slPrice = parseFloat((price * 0.994).toFixed(dp));
      const tpPrice = parseFloat((price * 1.02).toFixed(dp));

      // ===== FIX SIZE =====
      const safeSize = Number(p.quantity);
      if (!safeSize || safeSize <= 0) {
        console.error(`❌ SIZE INVÁLIDO ${sym}`);
        return res.json({ code: 'SIZE_ERR' });
      }

      const sizeStr = safeSize.toFixed(4);

      const base = {
        symbol: sym,
        productType: pt,
        marginCoin: 'USDT',
        holdSide,
        triggerType: 'mark_price',
        executePrice: '0',
        size: sizeStr,
      };

      await new Promise(r => setTimeout(r, 1200));

      let slRes = await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
        ...base,
        planType: 'loss_plan',
        triggerPrice: String(slPrice),
      });

      let tpRes = await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
        ...base,
        planType: 'profit_plan',
        triggerPrice: String(tpPrice),
      });

      const slOk = slRes?.code === '00000';
      const tpOk = tpRes?.code === '00000';

      if (!slOk || !tpOk) {
        console.log(`🔁 RETRY SL/TP ${sym}`);

        await new Promise(r => setTimeout(r, 500));

        slRes = await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
          ...base,
          planType: 'loss_plan',
          triggerPrice: String(slPrice),
        });

        tpRes = await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
          ...base,
          planType: 'profit_plan',
          triggerPrice: String(tpPrice),
        });

        if (slRes?.code !== '00000' || tpRes?.code !== '00000') {
          console.error(`❌ SL/TP FAIL ${sym}`);
          return res.json({ code: '00000', warning: true });
        }
      }

      console.log(`🛡️ SL/TP OK ${sym}`);

      return res.json(orderRes);
    }

    return res.json({ ok: true });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
