const { createHmac } = require('crypto');
const fetch = global.fetch || require('node-fetch');
const { formatSize, formatPrice } = require('./contracts');

const BASE = 'https://api.bitget.com';

// ===== SETTINGS =====
if (!global.BOT_SETTINGS) {
  global.BOT_SETTINGS = {
    active: true,
    risk: 1,
    lev: 10,
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

    // ── helpers ──────────────────────────────────────────────
    const hdrs = (method, path, bodyStr) => {
      const ts = Date.now().toString();
      return {
        'ACCESS-KEY':        KEY,
        'ACCESS-SIGN':       sign(ts, method, path, bodyStr || '', SEC),
        'ACCESS-TIMESTAMP':  ts,
        'ACCESS-PASSPHRASE': PASS,
        'Content-Type':      'application/json',
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
        return await Promise.race([
          r.json(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('bg json timeout')), 5000)),
        ]);
      } catch(e) {
        clearTimeout(timer);
        console.error(`bg error [${method} ${path}]:`, e.message);
        return { code: 'NET_ERR', msg: e.message };
      }
    };

    // ===== SETTINGS =====
    if (action === 'getSettings') return res.json(getSettings());

    if (action === 'toggleBot') {
      const cur = getSettings().active;
      setSettings({ active: !cur });
      return res.json({ active: !cur });
    }

    // ===== BALANCE =====
    if (action === 'balance') {
      const d = await bg('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
      // Expor ambos campos separados:
      //   equity    → total (com unrealized PnL) → para daily PnL e kill switch
      //   available → margem livre → para position sizing
      const data = (d.data || []).map(acc => ({
        ...acc,
        equity:    parseFloat(acc.usdtEquity || 0),
        available: parseFloat(acc.available  || 0),
      }));
      return res.json(data);
    }

    // ===== CANDLES =====
    if (action === 'candles') {
      const gran = p.tf === '1m' ? '1m' : (p.tf || '1m');
      const url  = `${BASE}/api/v2/mix/market/history-candles?symbol=${p.symbol}&productType=usdt-futures&granularity=${gran}&limit=100`;
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      let d;
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        d = await Promise.race([
          r.json(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('candles json timeout')), 5000)),
        ]);
      } catch(e) {
        console.error(`CANDLES FAIL ${p.symbol}:`, e.message);
        return res.json([]);
      } finally {
        clearTimeout(timer);
      }
      if (d.code && d.code !== '00000') {
        console.error('CANDLES ERROR:', p.symbol, d.msg);
        return res.json([]);
      }
      // Bitget history-candles devolve newest-first — inverter para oldest-first
      const raw = (d.data || []).reverse();
      const normalized = raw.map(c => ({
        ts: parseFloat(c[0]),
        o:  parseFloat(c[1]),
        h:  parseFloat(c[2]),
        l:  parseFloat(c[3]),
        c:  parseFloat(c[4]),
        v:  parseFloat(c[5]),
      }));
      return res.json(normalized);
    }

    // ===== POSITIONS =====
    if (action === 'positions') {
      const d = await bg('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
      const open = (d.data || []).filter(pos => parseFloat(pos.total) > 0);
      return res.json(open);
    }

    // ===== TICKERS (preços actuais — combate stale candles) =====
    if (action === 'tickers') {
      const d = await bg('GET', '/api/v2/mix/market/tickers?productType=USDT-FUTURES');
      // Devolver dict { BTCUSDT: lastPrice, ETHUSDT: lastPrice, ... }
      const map = {};
      for (const t of (d.data || [])) {
        // Bitget v2 pode usar lastPr, last, ou markPrice — tentar todos
        const price = parseFloat(t.lastPr || t.last || t.markPrice || t.indexPrice || 0);
        if (price > 0 && t.symbol) map[t.symbol] = price;
      }
      return res.json(map);
    }

    // ===== SETUP SYMBOLS (pré-configurar margin+leverage no arranque) =====
    if (action === 'setupSymbols') {
      const pt  = 'USDT-FUTURES';
      const lev = String(getSettings().lev || 5);
      const syms = p.symbols || [];
      console.log(`⚙️ Pre-setup ${syms.length} symbols @ ${lev}x...`);

      for (const sym of syms) {
        await bg('POST', '/api/v2/mix/account/set-margin-mode', {
          symbol: sym, productType: pt, marginCoin: 'USDT', marginMode: 'isolated',
        }).catch(() => {});

        // Set leverage para ambos os lados
        for (const hs of ['long', 'short']) {
          await bg('POST', '/api/v2/mix/account/set-leverage', {
            symbol: sym, productType: pt, marginCoin: 'USDT', leverage: lev, holdSide: hs,
          }).catch(() => {});
        }
      }
      console.log(`✅ Setup done: ${syms.join(', ')} @ ${lev}x isolated`);
      return res.json({ ok: true });
    }

    // ===== ORDER (abrir posição) =====
    if (action === 'order') {
      const sym      = p.symbol;
      const side     = p.side === 'BUY' ? 'buy' : 'sell';
      const holdSide = p.side === 'BUY' ? 'long' : 'short';
      const lev      = String(getSettings().lev || 3);
      const pt       = 'USDT-FUTURES';
      const fast     = p.fast === true; // skip margin/leverage se já configurado

      if (!fast) {
        // Setup completo (usado pelo swing)
        await bg('POST', '/api/v2/mix/account/set-margin-mode', {
          symbol: sym, productType: pt, marginCoin: 'USDT', marginMode: 'isolated',
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 200));

        let levOk = false;
        const lev1 = await bg('POST', '/api/v2/mix/account/set-leverage', {
          symbol: sym, productType: pt, marginCoin: 'USDT', leverage: lev, holdSide,
        });
        if (!lev1.code || lev1.code === '00000') {
          levOk = true;
        } else {
          const lev2 = await bg('POST', '/api/v2/mix/account/set-leverage', {
            symbol: sym, productType: pt, marginCoin: 'USDT', leverage: lev,
          });
          if (!lev2.code || lev2.code === '00000') levOk = true;
          else console.error('LEVERAGE FAIL:', lev2.msg);
        }
        if (!levOk) {
          return res.status(500).json({ code: 'LEV_FAIL', msg: `Leverage ${lev}x failed` });
        }
        await new Promise(r => setTimeout(r, 300));
      }

      // Formatar size
      const rawQty = Math.abs(parseFloat(p.quantity));
      const finalSize = formatSize(sym, rawQty);

      if (parseFloat(finalSize) <= 0) {
        return res.status(400).json({ code: 'SIZE_ERR', msg: `Size ${rawQty} truncado a 0` });
      }
      p._finalSize = parseFloat(finalSize);

      // Abrir ordem market
      const orderRes = await bg('POST', '/api/v2/mix/order/place-order', {
        symbol: sym, productType: pt, marginCoin: 'USDT',
        marginMode: 'isolated', side, tradeSide: 'open',
        orderType: 'market', size: finalSize,
      });

      if (!orderRes?.data?.orderId) {
        console.error('ORDER FAIL:', orderRes);
        return res.json(orderRes);
      }

      console.log(`✅ ORDER ${side} ${sym} size:${finalSize} ${lev}x${fast ? ' ⚡FAST' : ''}`);

      // Buscar preço real de execução SEMPRE — essencial para SL/TP correctos
      // Fast mode: delay mínimo (200ms). Normal: delay conservador (600ms)
      await new Promise(r => setTimeout(r, fast ? 200 : 600));

      let price = parseFloat(p.price || 0);
      try {
        const od = await bg('GET', `/api/v2/mix/order/detail?symbol=${sym}&productType=${pt}&orderId=${orderRes.data.orderId}`);
        const fp = parseFloat(od?.data?.fillPrice || od?.data?.priceAvg || 0);
        if (fp > 0) {
          console.log(`💱 Exec: ${fp} (candle: ${price})`);
          price = fp;
        }
      } catch(e) {
        // Fallback: buscar mark price actual (mais fiável que candle price)
        try {
          const pos = await bg('GET', `/api/v2/mix/position/all-position?productType=${pt}&marginCoin=USDT`);
          const myPos = (pos.data || []).find(p => p.symbol === sym && parseFloat(p.total) > 0);
          if (myPos) {
            const mark = parseFloat(myPos.markPrice || 0);
            if (mark > 0) { price = mark; console.log(`💱 Mark price: ${mark}`); }
          }
        } catch(e2) {}
      }

      if (price > 0) {
        // SL/TP: usar valores do cron.js se fornecidos, senão defaults
        const slPct = parseFloat(p.slPct) || 0.006;
        const conf = parseFloat(p.confidence || 0.6);
        const tpPct = p.tpPct ? parseFloat(p.tpPct)
                    : conf > 0.75 ? 0.022 : conf > 0.65 ? 0.016 : 0.012;
        console.log(`📐 SL:${(slPct*100).toFixed(2)}% TP:${(tpPct*100).toFixed(2)}% (conf:${conf.toFixed(2)})`);

        const slRaw = p.side === 'BUY' ? price * (1 - slPct) : price * (1 + slPct);
        const tpRaw = p.side === 'BUY' ? price * (1 + tpPct) : price * (1 - tpPct);

        // Formatar com precisão exacta do contrato — 1 chamada, sem loops
        const slPriceFmt = formatPrice(sym, slRaw);
        const tpPriceFmt = formatPrice(sym, tpRaw);

        await new Promise(r => setTimeout(r, fast ? 200 : 800));

        // 6. Colocar SL — chamada directa + fallbacks para checkScale
        const placeTpslDirect = async (planType, triggerPrice) => {
          // Tentativa 1: size exacto do contrato
          const r1 = await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
            symbol: sym, productType: pt, marginCoin: 'USDT',
            holdSide, triggerType: 'mark_price',
            executePrice: '0', size: finalSize,
            planType, triggerPrice,
          }).catch(e => ({ code: 'ERR', msg: e.message }));

          if (r1 && r1.code === '00000') {
            console.log(`✅ ${planType} OK size=${finalSize} price=${triggerPrice}`);
            return r1;
          }

          // Tentativa 2: size inteiro (checkScale=0 — Bitget TPSL pode exigir inteiros)
          const intSize = String(Math.floor(parseFloat(finalSize)));
          if (intSize !== finalSize && parseInt(intSize) > 0) {
            console.log(`⚠️ ${planType} falhou size=${finalSize}: ${r1?.msg} — retry com inteiro ${intSize}`);
            const r2 = await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
              symbol: sym, productType: pt, marginCoin: 'USDT',
              holdSide, triggerType: 'mark_price',
              executePrice: '0', size: intSize,
              planType, triggerPrice,
            }).catch(e => ({ code: 'ERR', msg: e.message }));

            if (r2 && r2.code === '00000') {
              console.log(`✅ ${planType} OK size=${intSize} (inteiro) price=${triggerPrice}`);
              return r2;
            }
            console.log(`⚠️ ${planType} inteiro falhou: ${r2?.msg}`);
          } else {
            console.log(`⚠️ ${planType} falhou size=${finalSize}: ${r1?.msg}`);
          }

          // Tentativa 3: sem size (Bitget aplica ao total da posição)
          console.log(`⚠️ ${planType} retry sem size`);
          const r3 = await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
            symbol: sym, productType: pt, marginCoin: 'USDT',
            holdSide, triggerType: 'mark_price',
            executePrice: '0', planType, triggerPrice,
          }).catch(e => ({ code: 'ERR', msg: e.message }));

          if (r3 && r3.code === '00000') {
            console.log(`✅ ${planType} OK (sem size) price=${triggerPrice}`);
            return r3;
          }

          console.error(`❌ ${planType} FAIL total: ${r3?.msg}`);
          return r3;
        };

        const slRes = await placeTpslDirect('loss_plan', slPriceFmt);
        await new Promise(r => setTimeout(r, fast ? 80 : 300));
        const tpRes = await placeTpslDirect('profit_plan', tpPriceFmt);

        const slOk = slRes && slRes.code === '00000';
        const tpOk = tpRes && tpRes.code === '00000';

        if (slOk) console.log(`🛡️ SL confirmado: ${slPriceFmt}`);
        if (tpOk) console.log(`🎯 TP confirmado: ${tpPriceFmt}`);

        if (!slOk || !tpOk) {
          console.error(`⚠️ SL/TP parcial ${sym} (SL:${slOk} TP:${tpOk}) — posição mantida`);
          return res.json({ code: '00000', data: orderRes.data, warning: 'SL/TP parcial' });
        }
      } else {
        console.log('⚠️ price não enviado — SL/TP não definidos');
      }

      return res.json(orderRes);
    }

    // ===== PARTIAL CLOSE (fechar % de uma posição) =====
    if (action === 'partialClose') {
      const rawQty = Math.abs(parseFloat(p.quantity));
      const size = formatSize(p.symbol, rawQty);

      if (parseFloat(size) <= 0) {
        console.error(`⚠️ PARTIAL CLOSE ${p.symbol} size truncado a 0`);
        return res.json({ code: 'SIZE_ERR', msg: 'size truncado a 0' });
      }

      const d = await bg('POST', '/api/v2/mix/order/place-order', {
        symbol:      p.symbol,
        productType: 'USDT-FUTURES',
        marginCoin:  'USDT',
        side:        p.holdSide === 'long' ? 'sell' : 'buy',
        tradeSide:   'close',
        orderType:   'market',
        size,
      });
      console.log(`💰 PARTIAL CLOSE ${p.symbol} size:${size}`);
      return res.json(d);
    }

    // ===== GET PLAN ORDERS =====
    if (action === 'getPlanOrders') {
      const d = await bg('GET', `/api/v2/mix/order/orders-plan-pending?symbol=${p.symbol}&productType=USDT-FUTURES&planType=loss_plan`);
      return res.json(d);
    }

    // ===== CANCEL PLAN ORDER =====
    if (action === 'cancelPlan') {
      const d = await bg('POST', '/api/v2/mix/order/cancel-plan-order', {
        symbol: p.symbol, productType: 'USDT-FUTURES', orderId: p.orderId,
      });
      return res.json(d);
    }

    // ===== PLACE TPSL (direto, para breakeven) =====
    if (action === 'placeTpsl') {
      const sym = p.symbol;
      // Usar contract specs para precisão exacta
      const size  = formatSize(sym, parseFloat(p.size));
      const price = formatPrice(sym, parseFloat(p.triggerPrice));

      const d = await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
        symbol:       sym,
        productType:  p.productType || 'USDT-FUTURES',
        marginCoin:   'USDT',
        planType:     p.planType,
        holdSide:     p.holdSide,
        triggerPrice: price,
        triggerType:  'mark_price',
        executePrice: '0',
        size,
      });

      if (d.code !== '00000') {
        console.error(`⚠️ placeTpsl ${sym} ${p.planType} falhou: ${d.msg} (size=${size} price=${price})`);
      }

      return res.json(d);
    }

    // ===== CLOSE POSITION =====
    if (action === 'close') {
      const sym      = p.symbol;
      const holdSide = p.holdSide;

      if (!sym || !holdSide)
        return res.status(400).json({ error: 'symbol e holdSide obrigatorios' });

      const r = await bg('POST', '/api/v2/mix/order/close-positions', {
        symbol: sym, productType: 'USDT-FUTURES', holdSide,
      });

      console.log(`🔴 CLOSE ${sym} ${holdSide}`);
      return res.json(r);
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (e) {
    console.error('BITGET HANDLER:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
