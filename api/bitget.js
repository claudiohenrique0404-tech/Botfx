const { createHmac } = require('crypto');

function sign(ts, method, path, body, secret) {
  return createHmac('sha256', secret)
    .update(ts + method.toUpperCase() + path + (body || ''))
    .digest('base64');
}

const STOCKS = ['NVDA','TSLA','AAPL','META','GOOGL','MSFT','AMZN','NFLX','AMD','INTC','COIN','MSTR','MA','LLY','PLTR','MCD','QQQ','GME','MRVL','RIOT','ORCL','CRCL'];
const isStock = s => STOCKS.some(x => (s||'').toUpperCase().startsWith(x));
const getPT = (s, o) => o ? o.toUpperCase() : isStock(s) ? 'SUSDT-FUTURES' : 'USDT-FUTURES';
const BASE = 'https://api.bitget.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Quick test endpoint - GET /api/bitget?test=candles
  if (req.method === 'GET' && req.url && req.url.includes('test=candles')) {
    try {
      const r = await fetch('https://api.bitget.com/api/mix/v1/market/candles?symbol=BTCUSDT_UMCBL&granularity=60&limit=5');
      const d = await r.json();
      return res.json({ ok: true, type: typeof d, isArray: Array.isArray(d), length: Array.isArray(d) ? d.length : 0, sample: Array.isArray(d) ? d[0] : d });
    } catch(e) {
      return res.json({ ok: false, error: e.message });
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KEY = process.env.BITGET_API_KEY;
  const SEC = process.env.BITGET_API_SECRET;
  const PASS = process.env.BITGET_PASSPHRASE;
  if (!KEY || !SEC || !PASS) return res.status(500).json({ error: 'API keys missing' });

  const hdrs = (method, path, body) => {
    const ts = Date.now().toString();
    return {
      'ACCESS-KEY': KEY,
      'ACCESS-SIGN': sign(ts, method, path, body || '', SEC),
      'ACCESS-TIMESTAMP': ts,
      'ACCESS-PASSPHRASE': PASS,
      'Content-Type': 'application/json',
      'locale': 'en-US'
    };
  };

  const bg = async (method, path, body) => {
    const bs = body ? JSON.stringify(body) : undefined;
    const r = await fetch(BASE + path, { method, headers: hdrs(method, path, bs || ''), body: bs });
    const d = await r.json();
    if (d && d.code && d.code !== '00000') throw new Error(d.code + ': ' + d.msg);
    return d;
  };

  try {
    const { action, ...p } = req.body || {};
    let result;

    if (action === 'ping') {
      result = { ok: true };
    } else if (action === 'account') {
      result = await bg('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
    } else if (action === 'candles') {
      // Bitget v2 API - v1 was decommissioned
      const sym = p.symbol || 'BTCUSDT';
      const isStockSym = STOCKS.some(function(x) { return (sym||'').toUpperCase().startsWith(x); });
      const pt = isStockSym ? 'susdt-futures' : 'usdt-futures';
      const gran = p.granularity || '1m';
      const limit = Math.min(parseInt(p.limit) || 300, 1000);
      const url = BASE + '/api/v2/mix/market/candles?symbol=' + sym + '&productType=' + pt + '&granularity=' + gran + '&limit=' + limit;
      const r = await fetch(url);
      const d = await r.json();
      if (d && d.code === '00000' && Array.isArray(d.data) && d.data.length > 0) {
        result = d.data.map(function(c) {
          return {
            ts: parseFloat(c[0]),
            o: parseFloat(c[1]), h: parseFloat(c[2]),
            l: parseFloat(c[3]), c: parseFloat(c[4]),
            v: parseFloat(c[5])
          };
        }).reverse();
      } else {
        result = [];
      }
    } else if (action === 'allPrices') {
      // Try v2 with lowercase productType first
      const pt = (p.productType || 'USDT-FUTURES').toLowerCase();
      const url = BASE + '/api/v2/mix/market/tickers?productType=' + pt;
      console.log('allPrices url:', url);
      const r = await fetch(url);
      const d = await r.json();
      console.log('allPrices response:', d?.code, 'items:', d?.data?.length);
      if (!d || d.code !== '00000') {
        // Fallback: use v1 tickers
        const ptv1 = pt === 'susdt-futures' ? 'sumcbl' : 'umcbl';
        const r2 = await fetch(BASE + '/api/mix/v1/market/tickers?productType=' + ptv1);
        const d2 = await r2.json();
        console.log('allPrices v1 fallback:', d2?.code, 'items:', d2?.data?.length);
        if (d2 && d2.code === '00000') {
          result = (d2.data || []).map(function(item) {
            return { symbol: item.symbol?.replace('_UMCBL','')?.replace('_SUMCBL',''), price: item.last || item.close || '0' };
          }).filter(function(x) { return parseFloat(x.price) > 0; });
        } else { result = []; }
      } else {
        result = (d.data || []).map(function(item) {
          return { symbol: item.symbol, price: item.lastPr || item.last || item.close || '0' };
        }).filter(function(x) { return parseFloat(x.price) > 0; });
      }
    } else if (action === 'prices') {
      const syms = p.symbols || ['BTCUSDT'];
      const pt = getPT(syms[0], p.productType);
      const out = await Promise.all(syms.map(async sym => {
        try {
          const r = await fetch(`${BASE}/api/v2/mix/market/symbol-price?productType=${pt}&symbol=${sym}`);
          const d = await r.json();
          if (!d || d.code !== '00000') return { symbol: sym, price: '0' };
          const item = Array.isArray(d.data) ? d.data[0] : d.data;
          return { symbol: sym, price: (item && (item.price || item.indexPrice)) || '0' };
        } catch { return { symbol: sym, price: '0' }; }
      }));
      result = out.filter(x => parseFloat(x.price) > 0);
    } else if (action === 'positions') {
      const [u, s] = await Promise.all([
        bg('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT'),
        bg('GET', '/api/v2/mix/position/all-position?productType=SUSDT-FUTURES&marginCoin=USDT').catch(() => ({ data: [] }))
      ]);
      result = [...(u?.data||[]), ...(s?.data||[])].filter(x => parseFloat(x.total) > 0);
    } else if (action === 'order') {
      const { symbol, side, quantity, stopLoss, takeProfit, leverage } = p;
      const pt = getPT(symbol, p.productType);
      const pos = side === 'BUY' ? 'long' : 'short';
      const lev = isStock(symbol) ? Math.min(parseInt(leverage)||2, 10) : parseInt(leverage)||2;
      
      // Set margin mode first
      try {
        await bg('POST', '/api/v2/mix/account/set-margin-mode', { symbol, productType: pt, marginCoin: 'USDT', marginMode: 'isolated' });
      } catch(e) { console.log('margin mode:', e.message); }
      await new Promise(r => setTimeout(r, 200));
      
      // Set leverage - if this fails, abort the order
      try {
        await bg('POST', '/api/v2/mix/account/set-leverage', { symbol, productType: pt, marginCoin: 'USDT', leverage: String(lev), holdSide: pos });
      } catch(e) {
        // Try without holdSide
        try {
          await bg('POST', '/api/v2/mix/account/set-leverage', { symbol, productType: pt, marginCoin: 'USDT', leverage: String(lev) });
        } catch(e2) {
          console.log('leverage set failed:', e2.message);
          throw new Error('Nao foi possivel definir alavancagem ' + lev + 'x: ' + e2.message);
        }
      }
      await new Promise(r => setTimeout(r, 300));
      
      const order = await bg('POST', '/api/v2/mix/order/place-order', {
        symbol, productType: pt, marginCoin: 'USDT', marginMode: 'isolated',
        side: side === 'BUY' ? 'buy' : 'sell', tradeSide: 'open',
        orderType: 'market', size: String(quantity), leverage: String(lev)
      });
      if (order?.data?.orderId) {
        await new Promise(r => setTimeout(r, 300));
        if (stopLoss) await bg('POST', '/api/v2/mix/order/place-tpsl-order', { symbol, productType: pt, marginCoin: 'USDT', planType: 'loss_plan', holdSide: pos, triggerPrice: String(stopLoss), triggerType: 'mark_price', executePrice: '0', size: String(quantity) }).catch(() => {});
        if (takeProfit) await bg('POST', '/api/v2/mix/order/place-tpsl-order', { symbol, productType: pt, marginCoin: 'USDT', planType: 'profit_plan', holdSide: pos, triggerPrice: String(takeProfit), triggerType: 'mark_price', executePrice: '0', size: String(quantity) }).catch(() => {});
      }
      result = order;
    } else if (action === 'closePosition') {
      const { symbol, side, quantity } = p;
      result = await bg('POST', '/api/v2/mix/order/place-order', {
        symbol, productType: getPT(symbol, p.productType), marginCoin: 'USDT',
        side: side === 'LONG' ? 'sell' : 'buy', tradeSide: 'close',
        orderType: 'market', size: String(Math.abs(parseFloat(quantity)))
      });
    } else if (action === 'cancelAll') {
      await Promise.all([
        bg('POST', '/api/v2/mix/order/cancel-all-orders', { productType: 'USDT-FUTURES', marginCoin: 'USDT' }),
        bg('POST', '/api/v2/mix/order/cancel-all-orders', { productType: 'SUSDT-FUTURES', marginCoin: 'USDT' }).catch(() => {})
      ]);
      result = { ok: true };
    } else {
      return res.status(400).json({ error: 'Unknown: ' + action });
    }

    return res.json(result);
  } catch (err) {
    console.error('BotFX:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
