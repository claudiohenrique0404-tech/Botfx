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
      // Todos os indicadores esperam [oldest ... newest] com .at(-1) = current
      // Normalizar para objetos {ts,o,h,l,c,v} para compatibilidade total
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
        return res.status(500).json({ code: 'LEV_FAIL', msg: `Nao foi possivel definir leverage ${lev}x` });
      }

      await new Promise(r => setTimeout(r, 300));

      // 3. Abrir ordem market
      const orderRes = await bg('POST', '/api/v2/mix/order/place-order', {
        symbol: sym, productType: pt, marginCoin: 'USDT',
        marginMode: 'isolated', side, tradeSide: 'open',
        orderType: 'market', size: (() => {
          const raw = Math.abs(p.quantity);
          const finalSize = raw > 1 ? Math.floor(raw) : parseFloat(raw.toFixed(3));
          p._finalSize = finalSize; // guardar para usar no SL/TP
          return String(finalSize);
        })(),
      });

      if (!orderRes?.data?.orderId) {
        console.error('ORDER FAIL:', orderRes);
        return res.json(orderRes);
      }

      console.log(`✅ ORDER ${side} ${sym} qty:${p.quantity} ${lev}x`);

      await new Promise(r => setTimeout(r, 600));

      // 4. Buscar preço real de execução — evita SL/TP calculados sobre preço de candle desactualizado
      // O preço dos candles pode diferir significativamente do preço real de execução
      let execPrice = 0;
      try {
        const orderDetail = await bg('GET', `/api/v2/mix/order/detail?symbol=${sym}&productType=${pt}&orderId=${orderRes.data.orderId}`);
        const fillPrice = parseFloat(orderDetail?.data?.fillPrice || orderDetail?.data?.priceAvg || 0);
        if (fillPrice > 0) {
          execPrice = fillPrice;
          console.log(`💱 Preço execução real: ${execPrice} (candle era: ${p.price})`);
        }
      } catch(e) {
        console.log('⚠️ Não foi possível obter preço de execução:', e.message);
      }

      // Fallback para preço do candle se não conseguiu o preço real
      const price = execPrice > 0 ? execPrice : parseFloat(p.price || 0);
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

        // Delay extra — Bitget precisa de reconhecer a posição antes de aceitar SL/TP
        await new Promise(r => setTimeout(r, 800));

        // Retry adaptativo: testa múltiplas precisões de size E de preço
        // Bitget exige checkScale específico por símbolo — desconhecido a priori
        const tryTpsl = async (planType, triggerPrice) => {
          const baseQty = p._finalSize || Math.abs(p.quantity);

          // TRUNCAR (não arredondar) — evita size > posição real
          // Ex: 0.025.toFixed(2) = "0.03" (arredonda para cima → rejeita)
          //     truncate(0.025, 2) = "0.02" (trunca → seguro)
          const truncate = (n, dp) => {
            const factor = Math.pow(10, dp);
            return (Math.floor(n * factor) / factor).toFixed(dp);
          };

          const sizesRaw = [0, 1, 2, 3, 4]
            .map(dp => truncate(baseQty, dp))
            .filter(s => parseFloat(s) > 0)
            .filter((s, i, arr) => arr.indexOf(s) === i); // deduplicar

          // Usar .toFixed(dp) directamente para preço — preserva zeros finais
          // Ex: (82.1104).toFixed(3) = "82.110" ✓  (Bitget aceita checkScale=3)
          //     String(parseFloat(...)) = "82.11" ✗  (remove zero final)
          const priceDps = [1, 2, 3, 4, 5, 6];

          for (const sz of sizesRaw) {
            for (const dp of priceDps) {
              const pr = triggerPrice.toFixed(dp);
              const res = await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
                symbol: sym, productType: pt, marginCoin: 'USDT',
                holdSide, triggerType: 'mark_price',
                executePrice: '0', size: sz,
                planType, triggerPrice: pr,
              }).catch(e => ({ code: 'ERR', msg: e.message }));
              if (res && res.code === '00000') {
                console.log(`✅ ${planType} OK size=${sz} price=${pr}`);
                return res;
              }
              await new Promise(r => setTimeout(r, 60));
            }
            console.error(`❌ ${planType} FAIL size=${sz} (todas as precisões de preço falharam)`);
          }
          return { code: 'ERR', msg: 'all size+price combinations failed' };
        };

        const slRes = await tryTpsl('loss_plan', slPrice);
        await new Promise(r => setTimeout(r, 300));
        const tpRes = await tryTpsl('profit_plan', tpPrice);

        const slOk = slRes && slRes.code === '00000';
        const tpOk = tpRes && tpRes.code === '00000';

        if (!slOk || !tpOk) {
          // SL/TP falharam — logar mas NÃO fechar
          // O loop do cron gere SL/TP manualmente como fallback
          console.error(`⚠️ SL/TP parcial ${sym} (SL:${slOk} TP:${tpOk}) — posição mantida`);
          // Retornar sucesso com aviso — a posição está aberta
          return res.json({ code: '00000', data: orderRes.data, warning: 'SL/TP parcial' });
        }

        console.log(`🛡️ SL confirmado: ${slPrice}`);
        console.log(`🎯 TP confirmado: ${tpPrice}`);
      } else {
        console.log('⚠️ price não enviado — SL/TP não definidos');
      }

      return res.json(orderRes);
    }

    // ===== PARTIAL CLOSE (fechar % de uma posição) =====
    if (action === 'partialClose') {
      const d = await bg('POST', '/api/v2/mix/order/place-order', {
        symbol:      p.symbol,
        productType: 'USDT-FUTURES',
        marginCoin:  'USDT',
        side:        p.holdSide === 'long' ? 'sell' : 'buy',
        tradeSide:   'close',
        orderType:   'market',
        size:        (() => {
          const raw = Math.abs(parseFloat(p.quantity));
          return raw > 1 ? String(Math.floor(raw)) : String(parseFloat(raw.toFixed(3)));
        })(),
      });
      console.log(`💰 PARTIAL CLOSE ${p.symbol} qty:${p.quantity}`);
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
