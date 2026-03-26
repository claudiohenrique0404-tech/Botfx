// api/cron.js — BotFX v3 — Motor autónomo server-side
const { createHmac } = require('crypto');

// ═══ CONFIGURAÇÃO ═══
const CONFIG = {
  leverage:     2,
  riskPct:      0.05,
  minScore:     7,
  minConf:      0.55,
  maxPositions: 3,
  takeProfitR:  3,
  stopLossAtr:  1.5,
};

// ═══ ATIVOS — 31 confirmados na Bitget ═══
const SYMBOLS = [
  // ── Crypto  (USDT-FUTURES) ──────────────────────────
  { sym:'BTCUSDT',  cat:'crypto' },
  { sym:'ETHUSDT',  cat:'crypto' },
  { sym:'SOLUSDT',  cat:'crypto' },
  { sym:'XRPUSDT',  cat:'crypto' },
  { sym:'DOGEUSDT', cat:'crypto' },
  { sym:'BNBUSDT',  cat:'crypto' },
  { sym:'ADAUSDT',  cat:'crypto' },
  { sym:'LINKUSDT', cat:'crypto' },
  { sym:'AVAXUSDT', cat:'crypto' },
  { sym:'DOTUSDT',  cat:'crypto' },
  { sym:'SHIBUSDT', cat:'crypto' },
  { sym:'PEPEUSDT', cat:'crypto' },
  // ── Stocks (SUSDT-FUTURES) ──────────────────────────
  { sym:'TSLAUSDT', cat:'stock' },
  { sym:'NVDAUSDT', cat:'stock' },
  { sym:'AMZNUSDT', cat:'stock' },
  { sym:'AAPLUSDT', cat:'stock' },
  { sym:'METAUSDT', cat:'stock' },
  { sym:'GOOGLUSDT',cat:'stock' },
  { sym:'MSFTUSDT', cat:'stock' },
  { sym:'MSTRUSDT', cat:'stock' },
  { sym:'MCDUSDT',  cat:'stock' },
  { sym:'ORCLUSDT', cat:'stock' },
  { sym:'CRCLUSDT', cat:'stock' },
  { sym:'GMEUSDT',  cat:'stock' },
  { sym:'MRVLUSDT', cat:'stock' },
  { sym:'COINUSDT', cat:'stock' },
  { sym:'INTCUSDT', cat:'stock' },
  { sym:'PLTRUSDT', cat:'stock' },
  { sym:'LLYUSDT',  cat:'stock' },
  // ── ETF / Commodities (SUSDT-FUTURES) ───────────────
  { sym:'QQQUSD',   cat:'etf'       },
  { sym:'GOLDUSD',  cat:'commodity' },
  { sym:'SILVUSD',  cat:'commodity' },
];

// ═══ HELPERS ═══
// Determina productType pelo cat do ativo
function getPT(cat) {
  return cat === 'crypto' ? 'usdt-futures' : 'susdt-futures';
}

// Casas decimais corretas por preço (SHIB/PEPE precisam de 8+)
function getDP(price) {
  if (price < 0.0001) return 8;
  if (price < 0.01)   return 6;
  if (price < 1)      return 5;
  if (price < 100)    return 4;
  if (price < 10000)  return 2;
  return 1;
}

// Horário de mercado US (NYSE) — 9:30–16:00 ET em dias úteis
// EST = UTC-5, EDT = UTC-4  →  cobrimos 13:30–21:00 UTC
function isStockMarketOpen() {
  const now  = new Date();
  const day  = now.getUTCDay();         // 0=Dom, 6=Sáb
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 810 && mins <= 1260;   // 13:30–21:00 UTC
}

// ═══ API BITGET ═══
const BASE = 'https://api.bitget.com';

function sign(ts, method, path, body, secret) {
  return createHmac('sha256', secret)
    .update(ts + method.toUpperCase() + path + (body || ''))
    .digest('base64');
}

function hdrs(method, path, body, K, S, P) {
  const ts = Date.now().toString();
  return {
    'ACCESS-KEY':        K,
    'ACCESS-SIGN':       sign(ts, method, path, body || '', S),
    'ACCESS-TIMESTAMP':  ts,
    'ACCESS-PASSPHRASE': P,
    'Content-Type':      'application/json',
    'locale':            'en-US',
  };
}

async function bg(method, path, body, K, S, P) {
  const bs = body ? JSON.stringify(body) : undefined;
  const r  = await fetch(BASE + path, { method, headers: hdrs(method, path, bs || '', K, S, P), body: bs });
  const d  = await r.json();
  if (d && d.code && d.code !== '00000') throw new Error(d.code + ': ' + d.msg);
  return d;
}

// ═══ CANDLES ═══
async function fetchCandles(sym, cat, granularity = '1m', limit = 200) {
  const pt  = getPT(cat);
  const url = `${BASE}/api/v2/mix/market/candles?symbol=${sym}&productType=${pt}&granularity=${granularity}&limit=${limit}`;
  const r   = await fetch(url);
  const d   = await r.json();
  if (!d || d.code !== '00000' || !Array.isArray(d.data) || d.data.length === 0) return null;
  return d.data.map(c => ({
    o: parseFloat(c[1]), h: parseFloat(c[2]),
    l: parseFloat(c[3]), c: parseFloat(c[4]),
    v: parseFloat(c[5]),
  })).reverse();
}

// ═══ FEAR & GREED ═══
async function fetchFearGreed() {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1');
    const d = await r.json();
    return parseInt(d?.data?.[0]?.value || 50);
  } catch { return 50; }
}

// ═══ INDICADORES ═══
function ema(c, n) {
  if (!c || c.length < n) return c?.at(-1)?.c ?? 0;
  const k = 2 / (n + 1);
  let e = c.slice(0, n).reduce((s, x) => s + x.c, 0) / n;
  for (let i = n; i < c.length; i++) e = c[i].c * k + e * (1 - k);
  return e;
}

function rsi(c, n = 14) {
  if (!c || c.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = c.length - n; i < c.length; i++) {
    const d = c[i].c - c[i - 1].c;
    if (d > 0) g += d; else l += Math.abs(d);
  }
  return 100 - 100 / (1 + g / (l || 0.001));
}

function atr(c, n = 14) {
  const s = c.slice(-n);
  let sum = 0;
  for (let i = 1; i < s.length; i++)
    sum += Math.max(s[i].h - s[i].l, Math.abs(s[i].h - s[i-1].c), Math.abs(s[i].l - s[i-1].c));
  return sum / (s.length - 1 || 1);
}

function bb(c, n = 20) {
  const s   = c.slice(-n).map(x => x.c);
  const m   = s.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return { u: m + 2 * std, l: m - 2 * std, m };
}

function macd(c) { return ema(c, 12) - ema(c, 26); }

function stoch(c, n = 14) {
  const s  = c.slice(-n);
  const lo = Math.min(...s.map(x => x.l));
  const hi = Math.max(...s.map(x => x.h));
  return hi === lo ? 50 : ((c.at(-1).c - lo) / (hi - lo)) * 100;
}

// ═══ MOTOR DE SINAL ═══
// Retorna sempre um objeto — nunca null.
// Se não há sinal: { action:'SKIP', score, reason }
// Se há sinal:     { action:'LONG'|'SHORT', score, conf, entry, sl, tp, atrV, dp, regime }
function computeSig(c, asset, btcTrend = 0, fearGreed = 50) {
  if (!c || c.length < 60)
    return { action:'SKIP', score:0, reason:`candles insuf (${c?.length||0})` };

  const lastC      = c.at(-1);
  const body       = Math.abs(lastC.c - lastC.o);
  const totalRange = lastC.h - lastC.l || 0.001;
  if (1 - (body / totalRange) > 0.85)
    return { action:'SKIP', score:0, reason:'wick (mecha dominante)' };

  const price  = lastC.c;
  const r      = rsi(c);
  const e9     = ema(c, 9), e21 = ema(c, 21), e50 = ema(c, 50);
  const bv     = bb(c);
  const atrV   = atr(c);
  const mom    = (price - c.at(-5).c) / (c.at(-5).c || 1) * 100;
  const mc     = macd(c);
  const st     = stoch(c);

  const avgVol = c.slice(-20).reduce((s, x) => s + x.v, 0) / 20;
  const volStr = lastC.v / (avgVol || 1);
  if (volStr < 0.25)
    return { action:'SKIP', score:0, reason:`vol baixo (${volStr.toFixed(2)}x)` };

  const atrPct    = atrV / price * 100;
  const isSideways = atrPct < 0.3;
  const isTrending = (e9 > e21 && e21 > e50) || (e9 < e21 && e21 < e50);

  let bull = 0, bear = 0;

  // RSI
  if (r < 25) bull += 5; else if (r < 35) bull += 3; else if (r < 45) bull += 1;
  if (r > 75) bear += 5; else if (r > 65) bear += 3; else if (r > 55) bear += 1;

  // EMA alignment
  if (e9 > e21 && e21 > e50) bull += 3;
  if (e9 < e21 && e21 < e50) bear += 3;
  if (price > e9) bull += 1; else bear += 1;

  // EMA cross fresco
  const prev9  = ema(c.slice(0, -1), 9);
  const prev21 = ema(c.slice(0, -1), 21);
  if (prev9 <= prev21 && e9 > e21) bull += 6;
  if (prev9 >= prev21 && e9 < e21) bear += 6;

  // Bollinger Bands
  if (price < bv.l) bull += 3; else if (price < bv.m) bull += 1;
  if (price > bv.u) bear += 3; else if (price > bv.m) bear += 1;

  // Momentum
  if (mom > 1.5) bull += 3; else if (mom > 0.5) bull += 1;
  if (mom < -1.5) bear += 3; else if (mom < -0.5) bear += 1;

  // MACD
  if (mc > 0) bull += 2; else bear += 2;

  // Stochastic
  if (st < 20) bull += 2; else if (st > 80) bear += 2;

  // Volume boost
  if (volStr > 2)   { bull += 2; bear += 2; }
  else if (volStr > 1.5) { bull += 1; bear += 1; }

  // Fear & Greed
  if (fearGreed < 25) bull += 2;
  else if (fearGreed > 75) bear += 2;

  // BTC macro filter (apenas crypto)
  if (asset.cat === 'crypto') {
    if (btcTrend > 3)  bull += 3; else if (btcTrend > 1)  bull += 1;
    if (btcTrend < -3) bear += 4; else if (btcTrend < -1) bear += 1;
    if (btcTrend < -5)
      return { action:'SKIP', score: bull - bear, reason:'BTC crash bloqueou' };
  }

  const rawScore = bull - bear;
  const absScore = Math.abs(rawScore);

  if (absScore < CONFIG.minScore)
    return { action:'SKIP', score: rawScore, reason:`score ${rawScore} < mín ${CONFIG.minScore}` };

  const action = rawScore > 0 ? 'LONG' : 'SHORT';

  let conf = Math.min(1, absScore / 30);
  if (isSideways) conf *= 0.7;
  if (isTrending) conf *= 1.2;
  conf = Math.min(1, conf);

  if (conf < CONFIG.minConf)
    return { action:'SKIP', score: rawScore, reason:`conf ${conf.toFixed(2)} < mín ${CONFIG.minConf}` };

  // Entry / SL / TP com precisão correta
  const dp    = getDP(price);
  const entry = price;
  const sl    = action === 'LONG'
    ? parseFloat((entry - atrV * CONFIG.stopLossAtr).toFixed(dp))
    : parseFloat((entry + atrV * CONFIG.stopLossAtr).toFixed(dp));
  const slDist = Math.abs(entry - sl);
  const tp    = action === 'LONG'
    ? parseFloat((entry + slDist * CONFIG.takeProfitR).toFixed(dp))
    : parseFloat((entry - slDist * CONFIG.takeProfitR).toFixed(dp));

  return {
    action, score: rawScore, conf, entry, sl, tp, atrV, dp,
    regime: isSideways ? 'SIDEWAYS' : isTrending ? 'TRENDING' : 'NORMAL',
  };
}

// ═══ ESTADO EM MEMÓRIA ═══
let lastLog = [];
let lastRun = null;

// ═══ HANDLER ═══
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const authHeader = req.headers['authorization'] || '';
  const secret     = process.env.CRON_SECRET || '';

  // Endpoint público — dashboard lê o log sem auth
  if (req.method === 'GET' && !authHeader) {
    return res.json({ lastRun, log: lastLog });
  }

  const valid = authHeader === 'Bearer ' + secret || authHeader === secret;
  if (!valid) return res.status(401).json({ error: 'Unauthorized' });

  const KEY  = process.env.BITGET_API_KEY;
  const SEC  = process.env.BITGET_API_SECRET;
  const PASS = process.env.BITGET_PASSPHRASE;
  if (!KEY || !SEC || !PASS) return res.status(500).json({ error: 'API keys missing' });

  const log    = [];
  const addLog = msg => { log.push(new Date().toISOString().slice(11, 19) + ' ' + msg); console.log(msg); };

  try {
    addLog('🤖 BotFX v3 iniciado');

    // ── Saldo ────────────────────────────────────────────
    const account = await bg('GET', '/api/v2/mix/account/accounts?productType=usdt-futures', null, KEY, SEC, PASS);
    const acc     = Array.isArray(account.data) ? account.data[0] : account.data;
    const capital = parseFloat(acc?.usdtEquity || acc?.available || 0);
    addLog(`💰 Capital: $${capital.toFixed(2)}`);
    if (capital < 5) return res.json({ ok: false, reason: 'capital insuficiente' });

    // ── Posições abertas (crypto + stocks) ───────────────
    const [posU, posS] = await Promise.all([
      bg('GET', '/api/v2/mix/position/all-position?productType=usdt-futures&marginCoin=USDT',  null, KEY, SEC, PASS),
      bg('GET', '/api/v2/mix/position/all-position?productType=susdt-futures&marginCoin=USDT', null, KEY, SEC, PASS)
        .catch(() => ({ data: [] })),
    ]);
    const openPositions = [...(posU.data || []), ...(posS.data || [])]
      .filter(p => parseFloat(p.total) > 0);

    addLog(`📊 Posições: ${openPositions.length}/${CONFIG.maxPositions}`);
    if (openPositions.length >= CONFIG.maxPositions)
      return res.json({ ok: true, reason: 'max posicoes', positions: openPositions.length });

    // ── Context global ────────────────────────────────────
    const [fearGreed, btcCandles] = await Promise.all([
      fetchFearGreed(),
      fetchCandles('BTCUSDT', 'crypto', '1m', 50),
    ]);
    const btcTrend = btcCandles
      ? ((btcCandles.at(-1).c - btcCandles[0].c) / (btcCandles[0].c || 1)) * 100
      : 0;
    addLog(`📈 BTC trend: ${btcTrend.toFixed(2)}% | F&G: ${fearGreed}`);

    // ── Gerir posições existentes ─────────────────────────
    let closed = 0;
    for (const pos of openPositions) {
      try {
        const sym   = pos.symbol;
        const side  = pos.holdSide; // 'long' | 'short'
        const asset = SYMBOLS.find(a => a.sym === sym) || { sym, cat: 'crypto' };
        const c1m   = await fetchCandles(sym, asset.cat, '1m', 100);
        if (!c1m || c1m.length < 30) continue;

        const unrealPnl  = parseFloat(pos.unrealizedPL || 0);
        const sig        = computeSig(c1m, asset, btcTrend, fearGreed);
        const sigReversed = sig.action !== 'SKIP' && (
          (side === 'long'  && sig.action === 'SHORT') ||
          (side === 'short' && sig.action === 'LONG')
        );

        let shouldClose = false, reason = '';
        if (sigReversed && unrealPnl > 0)    { shouldClose = true; reason = 'SINAL REVERTEU com lucro'; }
        else if (sigReversed && sig.conf > 0.7) { shouldClose = true; reason = 'SINAL FORTE CONTRÁRIO'; }

        if (shouldClose) {
          addLog(`🔴 A fechar ${sym} — ${reason}`);
          try {
            // productType correto para crypto vs stock
            await bg('POST', '/api/v2/mix/order/close-positions', {
              symbol:      sym,
              productType: getPT(asset.cat).toUpperCase(),
              holdSide:    side,
            }, KEY, SEC, PASS);
            addLog(`✅ ${sym} fechado — PnL: $${unrealPnl.toFixed(2)}`);
            closed++;
          } catch (e) {
            addLog(`❌ Erro fechar ${sym}: ${e.message}`);
          }
          await new Promise(r => setTimeout(r, 300));
        }
      } catch (e) {
        addLog(`❌ Erro gerir ${pos.symbol}: ${e.message}`);
      }
    }

    // ── Procurar novos sinais ─────────────────────────────
    const openSyms  = openPositions.map(p => p.symbol);
    const stockOpen = isStockMarketOpen();
    addLog(`🕐 NYSE: ${stockOpen ? 'ABERTO' : 'FECHADO'}`);

    let opened = 0;
    const skips = [];

    for (const asset of SYMBOLS) {
      if (openPositions.length + opened >= CONFIG.maxPositions) break;
      if (openSyms.includes(asset.sym)) continue;
      // Stocks/ETF/commodities só durante horário de mercado
      if (asset.cat !== 'crypto' && !stockOpen) continue;

      try {
        const [c1m, c5m] = await Promise.all([
          fetchCandles(asset.sym, asset.cat, '1m', 200),
          fetchCandles(asset.sym, asset.cat, '5m', 100),
        ]);

        if (!c1m || c1m.length < 60) {
          skips.push(`${asset.sym}:sem_candles`);
          continue;
        }

        const sig1m = computeSig(c1m, asset, btcTrend, fearGreed);

        if (sig1m.action === 'SKIP') {
          skips.push(`${asset.sym}:${sig1m.reason}`);
          continue;
        }

        // Multi-timeframe — 5m tem de concordar (ou ser neutro)
        const sig5m = c5m ? computeSig(c5m, asset, btcTrend, fearGreed) : null;
        if (sig5m && sig5m.action !== 'SKIP' && sig5m.action !== sig1m.action) {
          addLog(`⚠️ ${asset.sym} conflito TF (1m:${sig1m.action} vs 5m:${sig5m.action})`);
          continue;
        }

        const conf = (sig5m && sig5m.action !== 'SKIP')
          ? (sig1m.conf + sig5m.conf) / 2
          : sig1m.conf;

        const pt  = getPT(asset.cat);
        const dp  = sig1m.dp;

        // Quantidade
        const riskAmt = capital * CONFIG.riskPct * CONFIG.leverage;
        const qty     = (riskAmt / sig1m.entry).toFixed(3);
        if (parseFloat(qty) * sig1m.entry < 5) {
          skips.push(`${asset.sym}:qty_pequena`);
          continue;
        }

        addLog(`⚡ ${asset.sym} ${sig1m.action} score:${sig1m.score} conf:${conf.toFixed(2)} entry:${sig1m.entry} ${sig1m.regime}`);

        // Definir margin mode + leverage
        try {
          await bg('POST', '/api/v2/mix/account/set-margin-mode',
            { symbol: asset.sym, productType: pt, marginCoin: 'USDT', marginMode: 'isolated' },
            KEY, SEC, PASS);
          await bg('POST', '/api/v2/mix/account/set-leverage',
            { symbol: asset.sym, productType: pt, marginCoin: 'USDT', leverage: String(CONFIG.leverage), holdSide: sig1m.action === 'LONG' ? 'long' : 'short' },
            KEY, SEC, PASS);
        } catch {
          // Retry sem holdSide
          try {
            await bg('POST', '/api/v2/mix/account/set-leverage',
              { symbol: asset.sym, productType: pt, marginCoin: 'USDT', leverage: String(CONFIG.leverage) },
              KEY, SEC, PASS);
          } catch (e2) {
            addLog(`❌ ${asset.sym} leverage falhou: ${e2.message}`);
            continue;
          }
        }

        await new Promise(r => setTimeout(r, 300));

        // Abrir ordem market
        const order = await bg('POST', '/api/v2/mix/order/place-order', {
          symbol:      asset.sym,
          productType: pt,
          marginCoin:  'USDT',
          marginMode:  'isolated',
          side:        sig1m.action === 'LONG' ? 'buy' : 'sell',
          tradeSide:   'open',
          orderType:   'market',
          size:        qty,
          leverage:    String(CONFIG.leverage),
        }, KEY, SEC, PASS);

        if (order?.data?.orderId) {
          addLog(`✅ ABERTO ${asset.sym} #${order.data.orderId} ${CONFIG.leverage}x ${sig1m.action} qty:${qty}`);
          opened++;

          await new Promise(r => setTimeout(r, 400));

          // Stop Loss
          try {
            await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
              symbol:       asset.sym,
              productType:  pt,
              marginCoin:   'USDT',
              planType:     'loss_plan',
              holdSide:     sig1m.action === 'LONG' ? 'long' : 'short',
              triggerPrice: String(sig1m.sl),
              triggerType:  'mark_price',
              executePrice: '0',
              size:         qty,
            }, KEY, SEC, PASS);
            addLog(`🛡️ SL: ${sig1m.sl}`);
          } catch (e) { addLog(`⚠️ SL falhou: ${e.message}`); }

          // Take Profit
          try {
            await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
              symbol:       asset.sym,
              productType:  pt,
              marginCoin:   'USDT',
              planType:     'profit_plan',
              holdSide:     sig1m.action === 'LONG' ? 'long' : 'short',
              triggerPrice: String(sig1m.tp),
              triggerType:  'mark_price',
              executePrice: '0',
              size:         qty,
            }, KEY, SEC, PASS);
            addLog(`🎯 TP: ${sig1m.tp}`);
          } catch (e) { addLog(`⚠️ TP falhou: ${e.message}`); }
        }

        await new Promise(r => setTimeout(r, 500));

      } catch (e) {
        addLog(`❌ ${asset.sym}: ${e.message}`);
      }
    }

    // Resumo de skips (máx 6 visíveis)
    if (skips.length > 0) {
      const shown = skips.slice(0, 6).join(' | ');
      const extra = skips.length > 6 ? ` …+${skips.length - 6}` : '';
      addLog(`⏭️ ${skips.length} skips: ${shown}${extra}`);
    }

    addLog(`✅ Cron completo — ${opened} abertos, ${closed} fechados`);
    lastLog = log;
    lastRun = new Date().toISOString();
    return res.json({
      ok: true,
      capital:   capital.toFixed(2),
      opened,
      closed,
      positions: openPositions.length + opened - closed,
      btcTrend:  btcTrend.toFixed(2),
      fearGreed,
      stockOpen,
    });

  } catch (e) {
    addLog(`❌ FATAL: ${e.message}`);
    lastLog = log;
    lastRun = new Date().toISOString();
    return res.status(500).json({ ok: false, error: e.message });
  }
};
