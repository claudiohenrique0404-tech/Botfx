const { createHmac } = require('crypto');
const fetch = global.fetch || require('node-fetch');

const BASE = 'https://api.bitget.com';

// ===== SETTINGS =====
if (!global.BOT_SETTINGS) {
  global.BOT_SETTINGS = {
    active: true,
    risk: 1,
    lev: 3,
    symbols: [
      'BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT',
      'BNBUSDT','ADAUSDT','AVAXUSDT','LINKUSDT'
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
      const bs = body ? JSON.stringify(body) : undefined;
      const r  = await fetch(BASE + path, {
        method,
        headers: hdrs(method, path, bs || ''),
        body: bs,
      });
      return r.json();
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
      // Normalizar para expor usdtEquity como available
      // usdtEquity = equity real (inclui margem usada + PnL aberto)
      const data = (d.data || []).map(acc => ({
        ...acc,
        available: acc.usdtEquity || acc.crossedUnrealizedPL || acc.available,
      }));
      return res.json(data);
    }

    // ===== CANDLES =====
    if (action === 'candles') {
      const gran = p.tf === '1m' ? '1m' : (p.tf || '1m');
      const url  = `${BASE}/api/v2/mix/market/history-candles?symbol=${p.symbol}&productType=usdt-futures&granularity=${gran}&limit=100`;
      const r    = await fetch(url);
      const d    = await r.json();
      if (d.code && d.code !== '00000') {
        console.error('CANDLES ERROR:', p.symbol, d.msg);
        return res.json([]);
      }
      return res.json(d.data || []);
    }

    // ===== POSITIONS =====
    if (action === 'positions') {
      const d = await bg('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
      const open = (d.data || []).filter(pos => parseFloat(pos.total) > 0);
      return res.json(open);
    }

    // ===== ORDER (abrir posição) =====
    if (action === 'order') {
      const sym      = p.symbol;
      const side     = p.side === 'BUY' ? 'buy' : 'sell';
      const holdSide = p.side === 'BUY' ? 'long' : 'short';
      const lev      = String(getSettings().lev || 3);
      const pt       = 'USDT-FUTURES';

      // 1. Margin mode isolated
      await bg('POST', '/api/v2/mix/account/set-margin-mode', {
        symbol: sym, productType: pt, marginCoin: 'USDT', marginMode: 'isolated',
      }).catch(() => {});

      await new Promise(r => setTimeout(r, 200));

      // 2. Set leverage — aborta se falhar
      let levOk = false;
      const lev1 = await bg('POST', '/api/v2/mix/account/set-leverage', {
        symbol: sym, productType: pt, marginCoin: 'USDT', leverage: lev, holdSide,
      });
      if (!lev1.code || lev1.code === '00000') {
        levOk = true;
      } else {
        // retry sem holdSide
        const lev2 = await bg('POST', '/api/v2/mix/account/set-leverage', {
          symbol: sym, productType: pt, marginCoin: 'USDT', leverage: lev,
        });
        if (!lev2.code || lev2.code === '00000') levOk = true;
        else console.error('LEVERAGE FAIL:', lev2.msg);
      }

      if (!levOk) {
        return res.status(500).json({ error: `Nao foi possivel definir leverage ${lev}x` });
      }

      await new Promise(r => setTimeout(r, 300));

      // 3. Abrir ordem market
      const orderRes = await bg('POST', '/api/v2/mix/order/place-order', {
        symbol: sym, productType: pt, marginCoin: 'USDT',
        marginMode: 'isolated', side, tradeSide: 'open',
        orderType: 'market', size: String(Math.abs(p.quantity)),
      });

      if (!orderRes?.data?.orderId) {
        console.error('ORDER FAIL:', orderRes);
        return res.json(orderRes);
      }

      console.log(`✅ ORDER ${side} ${sym} qty:${p.quantity} ${lev}x`);

      await new Promise(r => setTimeout(r, 400));

      // 4. SL + TP na Bitget
      const price = parseFloat(p.price || 0);
      if (price > 0) {
        const dp = price > 10000 ? 1 : price > 100 ? 2 : price > 1 ? 4 : 6;

        const slPct = 0.006; // 0.6% — melhor R/R
        // TP dinâmico baseado na confiança do sinal
        const conf = parseFloat(p.confidence || 0.6);
        const tpPct = conf > 0.75 ? 0.022   // alta confiança → 2.2%
                    : conf > 0.65 ? 0.016   // média → 1.6%
                    :               0.012;  // baixa → 1.2%
        console.log(`📐 TP dinâmico: ${(tpPct*100).toFixed(1)}% (conf:${conf.toFixed(2)})`);

        const slPrice = p.side === 'BUY'
          ? parseFloat((price * (1 - slPct)).toFixed(dp))
          : parseFloat((price * (1 + slPct)).toFixed(dp));

        const tpPrice = p.side === 'BUY'
          ? parseFloat((price * (1 + tpPct)).toFixed(dp))
          : parseFloat((price * (1 - tpPct)).toFixed(dp));

        const tpslBase = {
          symbol: sym, productType: pt, marginCoin: 'USDT',
          holdSide, triggerType: 'mark_price',
          executePrice: '0', size: String(Math.abs(p.quantity)),
        };

        const slRes = await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
          ...tpslBase, planType: 'loss_plan', triggerPrice: String(slPrice),
        }).catch(e => ({ code: 'ERR', msg: e.message }));

        await new Promise(r => setTimeout(r, 200));

        const tpRes = await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
          ...tpslBase, planType: 'profit_plan', triggerPrice: String(tpPrice),
        }).catch(e => ({ code: 'ERR', msg: e.message }));

        const slOk = slRes && slRes.code === '00000';
        const tpOk = tpRes && tpRes.code === '00000';

        if (!slOk || !tpOk) {
          // SL ou TP falharam — fechar posição por segurança
          console.error(`❌ SL/TP falharam ${sym} (SL:${slOk} TP:${tpOk}) — a fechar`);
          await bg('POST', '/api/v2/mix/order/close-positions', {
            symbol: sym, productType: pt, holdSide,
          }).catch(e => console.error('close fail:', e.message));
          return res.json({ error: 'SL/TP failed — position closed for safety' });
        }

        console.log(`🛡️ SL confirmado: ${slPrice}`);
        console.log(`🎯 TP confirmado: ${tpPrice}`);
      } else {
        console.log('⚠️ price não enviado — SL/TP não definidos');
      }

      return res.json(orderRes);
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
      const d = await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
        symbol:       p.symbol,
        productType:  p.productType || 'USDT-FUTURES',
        marginCoin:   'USDT',
        planType:     p.planType,
        holdSide:     p.holdSide,
        triggerPrice: String(p.triggerPrice),
        triggerType:  'mark_price',
        executePrice: '0',
        size:         String(p.size),
      });
      return res.json(d);
    }

    // ===== CLOSE POSITION =====
    if (action === 'close') {
      const sym      = p.symbol;
      const holdSide = p.holdSide; // 'long' ou 'short' — obrigatório

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
