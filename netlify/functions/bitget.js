const crypto = require(‘crypto’);

function sign(ts, method, path, body, secret) {
return crypto.createHmac(‘sha256’, secret)
.update(ts + method.toUpperCase() + path + (body || ‘’))
.digest(‘base64’);
}

const STOCKS = [‘NVDA’,‘TSLA’,‘AAPL’,‘META’,‘GOOGL’,‘MSFT’,‘AMZN’,‘NFLX’,‘AMD’,‘INTC’,‘COIN’,‘MSTR’,‘MA’,‘LLY’,‘PLTR’,‘MCD’,‘QQQ’,‘GME’,‘MRVL’,‘RIOT’,‘ORCL’,‘CRCL’];
const isStock = s => STOCKS.some(x => (s||’’).toUpperCase().startsWith(x));
const getPT = (s, o) => o ? o.toLowerCase() : isStock(s) ? ‘susdt-futures’ : ‘usdt-futures’;

exports.handler = async (event) => {
const headers = {
‘Access-Control-Allow-Origin’: ‘*’,
‘Access-Control-Allow-Methods’: ‘POST, OPTIONS’,
‘Access-Control-Allow-Headers’: ‘Content-Type’,
‘Content-Type’: ‘application/json’
};

if (event.httpMethod === ‘OPTIONS’) return { statusCode: 200, headers, body: ‘’ };

const KEY  = process.env.BITGET_API_KEY;
const SEC  = process.env.BITGET_API_SECRET;
const PASS = process.env.BITGET_PASSPHRASE;
const BASE = ‘https://api.bitget.com’;

if (!KEY || !SEC || !PASS) return { statusCode: 500, headers, body: JSON.stringify({ error: ‘API keys missing’ }) };

const hdrs = (method, path, body) => {
const ts = Date.now().toString();
return {
‘ACCESS-KEY’: KEY,
‘ACCESS-SIGN’: sign(ts, method, path, body || ‘’, SEC),
‘ACCESS-TIMESTAMP’: ts,
‘ACCESS-PASSPHRASE’: PASS,
‘Content-Type’: ‘application/json’,
‘locale’: ‘en-US’
};
};

const bg = async (method, path, body) => {
const bs = body ? JSON.stringify(body) : undefined;
const r = await fetch(BASE + path, { method, headers: hdrs(method, path, bs || ‘’), body: bs });
const d = await r.json();
if (d?.code && d.code !== ‘00000’) throw new Error(d.code + ’: ’ + d.msg);
return d;
};

try {
const { action, …p } = JSON.parse(event.body || ‘{}’);
let result;

```
if (action === 'ping') {
  result = { ok: true };
} else if (action === 'account') {
  result = await bg('GET', '/api/v2/mix/account/accounts?productType=usdt-futures');
} else if (action === 'prices') {
  const syms = p.symbols || ['BTCUSDT'];
  const pt = getPT(syms[0], p.productType);
  const out = await Promise.all(syms.map(async sym => {
    try {
      const r = await fetch(`${BASE}/api/v2/mix/market/symbol-price?productType=${pt}&symbol=${sym}`);
      const d = await r.json();
      if (d?.code !== '00000') return { symbol: sym, price: '0' };
      const item = Array.isArray(d.data) ? d.data[0] : d.data;
      return { symbol: sym, price: item?.price || item?.indexPrice || '0' };
    } catch { return { symbol: sym, price: '0' }; }
  }));
  result = out.filter(x => parseFloat(x.price) > 0);
} else if (action === 'positions') {
  const [u, s] = await Promise.all([
    bg('GET', '/api/v2/mix/position/all-position?productType=usdt-futures&marginCoin=USDT'),
    bg('GET', '/api/v2/mix/position/all-position?productType=susdt-futures&marginCoin=USDT').catch(() => ({ data: [] }))
  ]);
  result = [...(u?.data||[]), ...(s?.data||[])].filter(x => parseFloat(x.total) > 0);
} else if (action === 'order') {
  const { symbol, side, quantity, stopLoss, takeProfit, leverage } = p;
  const pt = getPT(symbol, p.productType);
  const pos = side === 'BUY' ? 'long' : 'short';
  const lev = isStock(symbol) ? Math.min(parseInt(leverage)||5, 10) : parseInt(leverage)||5;
  await bg('POST', '/api/v2/mix/account/set-leverage', { symbol, productType: pt, marginCoin: 'USDT', leverage: String(lev), holdSide: pos }).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  const order = await bg('POST', '/api/v2/mix/order/place-order', { symbol, productType: pt, marginCoin: 'USDT', side: side === 'BUY' ? 'buy' : 'sell', tradeSide: 'open', orderType: 'market', size: String(quantity), leverage: String(lev) });
  if (order?.data?.orderId) {
    await new Promise(r => setTimeout(r, 300));
    if (stopLoss) await bg('POST', '/api/v2/mix/order/place-tpsl-order', { symbol, productType: pt, marginCoin: 'USDT', planType: 'loss_plan', holdSide: pos, triggerPrice: String(stopLoss), triggerType: 'mark_price', executePrice: '0', size: String(quantity) }).catch(() => {});
    if (takeProfit) await bg('POST', '/api/v2/mix/order/place-tpsl-order', { symbol, productType: pt, marginCoin: 'USDT', planType: 'profit_plan', holdSide: pos, triggerPrice: String(takeProfit), triggerType: 'mark_price', executePrice: '0', size: String(quantity) }).catch(() => {});
  }
  result = order;
} else if (action === 'closePosition') {
  const { symbol, side, quantity } = p;
  result = await bg('POST', '/api/v2/mix/order/place-order', { symbol, productType: getPT(symbol, p.productType), marginCoin: 'USDT', side: side === 'LONG' ? 'sell' : 'buy', tradeSide: 'close', orderType: 'market', size: String(Math.abs(parseFloat(quantity))) });
} else if (action === 'cancelAll') {
  await Promise.all([
    bg('POST', '/api/v2/mix/order/cancel-all-orders', { productType: 'usdt-futures', marginCoin: 'USDT' }),
    bg('POST', '/api/v2/mix/order/cancel-all-orders', { productType: 'susdt-futures', marginCoin: 'USDT' }).catch(() => {})
  ]);
  result = { ok: true };
} else {
  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown: ' + action }) };
}

return { statusCode: 200, headers, body: JSON.stringify(result) };
```

} catch (err) {
console.error(‘BotFX:’, err.message);
return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
}
};