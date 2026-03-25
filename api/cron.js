// api/cron.js — Bot autónomo server-side com motor de sinal completo
const { createHmac } = require('crypto');

// ═══ CONFIGURAÇÃO (ajusta aqui) ═══
const CONFIG = {
  leverage: 2,
  riskPct: 0.05,
  minScore: 7,
  minConf: 0.55,
  maxPositions: 3,
  takeProfitR: 3,
  stopLossAtr: 1.5,
};

const SYMBOLS = [
  { sym:'BTCUSDT',  cat:'crypto', vol:0.012 },
  { sym:'ETHUSDT',  cat:'crypto', vol:0.015 },
  { sym:'SOLUSDT',  cat:'crypto', vol:0.025 },
  { sym:'XRPUSDT',  cat:'crypto', vol:0.020 },
  { sym:'DOGEUSDT', cat:'crypto', vol:0.030 },
  { sym:'BNBUSDT',  cat:'crypto', vol:0.015 },
  { sym:'ADAUSDT',  cat:'crypto', vol:0.020 },
  { sym:'LINKUSDT', cat:'crypto', vol:0.025 },
  { sym:'AVAXUSDT', cat:'crypto', vol:0.025 },
  { sym:'DOTUSDT',  cat:'crypto', vol:0.025 },
];

const BASE = 'https://api.bitget.com';

// ═══ API ═══
function sign(ts, method, path, body, secret) {
  return createHmac('sha256', secret)
    .update(ts + method.toUpperCase() + path + (body||''))
    .digest('base64');
}

function hdrs(method, path, body, K, S, P) {
  const ts = Date.now().toString();
  return {
    'ACCESS-KEY': K, 'ACCESS-SIGN': sign(ts, method, path, body||'', S),
    'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': P,
    'Content-Type': 'application/json', 'locale': 'en-US'
  };
}

async function bg(method, path, body, K, S, P) {
  const bs = body ? JSON.stringify(body) : undefined;
  const r = await fetch(BASE + path, { method, headers: hdrs(method, path, bs||'', K, S, P), body: bs });
  const d = await r.json();
  if (d && d.code && d.code !== '00000') throw new Error(d.code + ': ' + d.msg);
  return d;
}

// ═══ INDICADORES ═══
function ema(c, n) {
  if (!c || c.length < n) return c?.at(-1)?.c ?? 0;
  const k = 2/(n+1);
  let e = c.slice(0,n).reduce((s,x) => s+x.c, 0)/n;
  for (let i = n; i < c.length; i++) e = c[i].c*k + e*(1-k);
  return e;
}

function rsi(c, n=14) {
  if (!c || c.length < n+1) return 50;
  let g=0, l=0;
  for (let i = c.length-n; i < c.length; i++) {
    const d = c[i].c - c[i-1].c;
    if (d > 0) g += d; else l += Math.abs(d);
  }
  return 100 - 100/(1 + g/(l||0.001));
}

function atr(c, n=14) {
  const s = c.slice(-n);
  let sum = 0;
  for (let i = 1; i < s.length; i++)
    sum += Math.max(s[i].h-s[i].l, Math.abs(s[i].h-s[i-1].c), Math.abs(s[i].l-s[i-1].c));
  return sum/(s.length-1||1);
}

function bb(c, n=20) {
  const s = c.slice(-n).map(x => x.c);
  const m = s.reduce((a,b) => a+b, 0)/n;
  const std = Math.sqrt(s.reduce((a,b) => a+(b-m)**2, 0)/n);
  return { u: m+2*std, l: m-2*std, m };
}

function macd(c) { return ema(c,12) - ema(c,26); }

function stoch(c, n=14) {
  const s = c.slice(-n);
  const lo = Math.min(...s.map(x => x.l));
  const hi = Math.max(...s.map(x => x.h));
  return hi === lo ? 50 : ((c.at(-1).c - lo)/(hi-lo))*100;
}

// ═══ MOTOR DE SINAL COMPLETO ═══
function computeSig(c, asset, btcTrend=0, fearGreed=50) {
  if (!c || c.length < 60) return null;

  const lastC = c.at(-1);
  const body = Math.abs(lastC.c - lastC.o);
  const totalRange = lastC.h - lastC.l || 0.001;
  if (1-(body/totalRange) > 0.85) return null; // wick filter

  const price = lastC.c;
  const r = rsi(c);
  const e9 = ema(c,9), e21 = ema(c,21), e50 = ema(c,50);
  const bv = bb(c);
  const atrV = atr(c);
  const mom = (price - c.at(-5).c) / c.at(-5).c * 100;
  const mc = macd(c);
  const st = stoch(c);

  // Volume strength
  const avgVol = c.slice(-20).reduce((s,x) => s+x.v, 0)/20;
  const volStr = lastC.v / (avgVol||1);
  if (volStr < 0.25) return null; // low liquidity

  // Trend/sideways detection
  const atrPct = atrV/price*100;
  const isSideways = atrPct < 0.3;
  const isTrending = e9 > e21 && e21 > e50 || e9 < e21 && e21 < e50;

  let bull=0, bear=0;

  // RSI
  if (r < 25) bull+=5; else if (r < 35) bull+=3; else if (r < 45) bull+=1;
  if (r > 75) bear+=5; else if (r > 65) bear+=3; else if (r > 55) bear+=1;

  // EMA alignment
  if (e9 > e21 && e21 > e50) bull+=3;
  if (e9 < e21 && e21 < e50) bear+=3;
  if (price > e9) bull+=1; else bear+=1;

  // EMA cross (fresh)
  const prev9 = ema(c.slice(0,-1),9), prev21 = ema(c.slice(0,-1),21);
  if (prev9 <= prev21 && e9 > e21) bull+=6; // fresh cross
  if (prev9 >= prev21 && e9 < e21) bear+=6;

  // Bollinger Bands
  if (price < bv.l) bull+=3; else if (price < bv.m) bull+=1;
  if (price > bv.u) bear+=3; else if (price > bv.m) bear+=1;

  // Momentum
  if (mom > 1.5) bull+=3; else if (mom > 0.5) bull+=1;
  if (mom < -1.5) bear+=3; else if (mom < -0.5) bear+=1;

  // MACD
  if (mc > 0) bull+=2; else bear+=2;

  // Stochastic
  if (st < 20) bull+=2; else if (st > 80) bear+=2;

  // Volume
  if (volStr > 2) { bull+=2; bear+=2; }
  else if (volStr > 1.5) { bull+=1; bear+=1; }

  // Fear & Greed
  if (fearGreed < 25) bull+=2;
  else if (fearGreed > 75) bear+=2;

  // BTC macro filter
  if (asset.cat === 'crypto') {
    if (btcTrend > 3) bull+=3; else if (btcTrend > 1) bull+=1;
    if (btcTrend < -3) bear+=4; else if (btcTrend < -1) bear+=1;
    if (btcTrend < -5) return null; // block longs in BTC crash
  }

  const rawScore = bull - bear;
  const action = rawScore >= CONFIG.minScore ? 'LONG' : rawScore <= -CONFIG.minScore ? 'SHORT' : 'WAIT';
  if (action === 'WAIT') return null;

  // Confidence
  const maxScore = 30;
  let conf = Math.min(1, Math.abs(rawScore)/maxScore);
  if (isSideways) conf *= 0.7;
  if (isTrending) conf *= 1.2;
  conf = Math.min(1, conf);

  if (conf < CONFIG.minConf) return null;

  // Entry, SL, TP
  const entry = price;
  const sl = action === 'LONG'
    ? entry - atrV * CONFIG.stopLossAtr
    : entry + atrV * CONFIG.stopLossAtr;
  const slDist = Math.abs(entry - sl);
  const tp = action === 'LONG'
    ? entry + slDist * CONFIG.takeProfitR
    : entry - slDist * CONFIG.takeProfitR;

  return { action, score: rawScore, conf, entry, sl, tp, atrV, regime: isSideways?'SIDEWAYS':isTrending?'TRENDING':'NORMAL' };
}

// ═══ FETCH CANDLES ═══
async function fetchCandles(sym, granularity='60', limit=200) {
  const v1sym = sym + '_UMCBL';
  const url = BASE + '/api/mix/v1/market/candles?symbol=' + v1sym + '&granularity=' + granularity + '&limit=' + limit;
  const r = await fetch(url);
  const d = await r.json();
  if (!Array.isArray(d) || d.length === 0) return null;
  return d.map(c => ({
    o: parseFloat(c[1]), h: parseFloat(c[2]),
    l: parseFloat(c[3]), c: parseFloat(c[4]),
    v: parseFloat(c[5])
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

// ═══ HANDLER ═══
module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const KEY = process.env.BITGET_API_KEY;
  const SEC = process.env.BITGET_API_SECRET;
  const PASS = process.env.BITGET_PASSPHRASE;
  if (!KEY || !SEC || !PASS) return res.status(500).json({ error: 'API keys missing' });

  const log = [];
  const addLog = msg => { log.push(new Date().toISOString().slice(11,19) + ' ' + msg); console.log(msg); };

  try {
    addLog('🤖 Cron iniciado');

    // Saldo
    const account = await bg('GET', '/api/v2/mix/account/accounts?productType=usdt-futures', null, KEY, SEC, PASS);
    const acc = Array.isArray(account.data) ? account.data[0] : account.data;
    const capital = parseFloat(acc?.usdtEquity || acc?.available || 0);
    addLog('💰 Capital: $' + capital.toFixed(2));
    if (capital < 5) return res.json({ log });

    // Posições abertas
    const posData = await bg('GET', '/api/v2/mix/position/all-position?productType=usdt-futures&marginCoin=USDT', null, KEY, SEC, PASS);
    const openPositions = (posData.data || []).filter(p => parseFloat(p.total) > 0);
    addLog('📊 Posições: ' + openPositions.length + '/' + CONFIG.maxPositions);
    if (openPositions.length >= CONFIG.maxPositions) return res.json({ log });

    // Fear & Greed + BTC trend
    const [fearGreed, btcCandles] = await Promise.all([
      fetchFearGreed(),
      fetchCandles('BTCUSDT', '60', 50)
    ]);
    addLog('😱 Fear&Greed: ' + fearGreed);
    const btcTrend = btcCandles
      ? ((btcCandles.at(-1).c - btcCandles[0].c) / btcCandles[0].c) * 100
      : 0;
    addLog('₿ BTC trend: ' + btcTrend.toFixed(2) + '%');

    const openSyms = openPositions.map(p => p.symbol);
    let opened = 0;

    for (const asset of SYMBOLS) {
      if (openPositions.length + opened >= CONFIG.maxPositions) break;
      if (openSyms.includes(asset.sym)) continue;

      try {
        // Buscar candles 1m e 5m para multi-timeframe
        const [c1m, c5m] = await Promise.all([
          fetchCandles(asset.sym, '60', 200),
          fetchCandles(asset.sym, '300', 100)
        ]);

        if (!c1m || c1m.length < 60) {
          addLog('⚠️ ' + asset.sym + ' sem candles');
          continue;
        }

        // Analisar em 2 timeframes
        const sig1m = computeSig(c1m, asset, btcTrend, fearGreed);
        const sig5m = c5m ? computeSig(c5m, asset, btcTrend, fearGreed) : null;

        // Só entra se ambos os timeframes concordam (ou 1m muito forte)
        if (!sig1m) {
          addLog('⏳ ' + asset.sym + ' sem sinal');
          continue;
        }

        if (sig5m && sig5m.action !== sig1m.action) {
          addLog('⚠️ ' + asset.sym + ' conflito timeframes — skip');
          continue;
        }

        const conf = sig5m ? (sig1m.conf + sig5m.conf) / 2 : sig1m.conf;
        addLog('🎯 ' + asset.sym + ' ' + sig1m.action + ' score:' + sig1m.score + ' conf:' + (conf*100).toFixed(0) + '% regime:' + sig1m.regime);

        // Quantidade
        const riskAmt = capital * CONFIG.riskPct * CONFIG.leverage;
        const dp = sig1m.entry < 1 ? 5 : sig1m.entry < 100 ? 3 : 1;
        const qty = (riskAmt / sig1m.entry).toFixed(3);
        if (parseFloat(qty) * sig1m.entry < 5) {
          addLog('⚠️ ' + asset.sym + ' valor mínimo não atingido');
          continue;
        }

        // Definir margin mode e leverage — se falhar, não abre
        try {
          await bg('POST', '/api/v2/mix/account/set-margin-mode',
            { symbol: asset.sym, productType: 'usdt-futures', marginCoin: 'USDT', marginMode: 'isolated' },
            KEY, SEC, PASS);
          await bg('POST', '/api/v2/mix/account/set-leverage',
            { symbol: asset.sym, productType: 'usdt-futures', marginCoin: 'USDT', leverage: String(CONFIG.leverage), holdSide: sig1m.action === 'LONG' ? 'long' : 'short' },
            KEY, SEC, PASS);
        } catch(e) {
          addLog('❌ ' + asset.sym + ' leverage falhou — a cancelar: ' + e.message);
          continue;
        }

        await new Promise(r => setTimeout(r, 300));

        // Abrir ordem
        const order = await bg('POST', '/api/v2/mix/order/place-order', {
          symbol: asset.sym, productType: 'usdt-futures', marginCoin: 'USDT',
          marginMode: 'isolated',
          side: sig1m.action === 'LONG' ? 'buy' : 'sell',
          tradeSide: 'open', orderType: 'market',
          size: qty, leverage: String(CONFIG.leverage)
        }, KEY, SEC, PASS);

        if (order?.data?.orderId) {
          addLog('✅ ' + asset.sym + ' aberto #' + order.data.orderId + ' ' + CONFIG.leverage + 'x');
          opened++;

          await new Promise(r => setTimeout(r, 400));

          // SL
          try {
            await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
              symbol: asset.sym, productType: 'usdt-futures', marginCoin: 'USDT',
              planType: 'loss_plan',
              holdSide: sig1m.action === 'LONG' ? 'long' : 'short',
              triggerPrice: sig1m.sl.toFixed(dp), triggerType: 'mark_price',
              executePrice: '0', size: qty
            }, KEY, SEC, PASS);
            addLog('🛡 SL: $' + sig1m.sl.toFixed(dp));
          } catch(e) { addLog('⚠️ SL falhou: ' + e.message); }

          // TP
          try {
            await bg('POST', '/api/v2/mix/order/place-tpsl-order', {
              symbol: asset.sym, productType: 'usdt-futures', marginCoin: 'USDT',
              planType: 'profit_plan',
              holdSide: sig1m.action === 'LONG' ? 'long' : 'short',
              triggerPrice: sig1m.tp.toFixed(dp), triggerType: 'mark_price',
              executePrice: '0', size: qty
            }, KEY, SEC, PASS);
            addLog('🎯 TP: $' + sig1m.tp.toFixed(dp));
          } catch(e) { addLog('⚠️ TP falhou: ' + e.message); }
        }

        await new Promise(r => setTimeout(r, 500));

      } catch(e) {
        addLog('❌ ' + asset.sym + ': ' + e.message);
      }
    }

    addLog('✅ Cron completo — ' + opened + ' trades abertos');
    return res.json({ log, opened, positions: openPositions.length + opened });

  } catch(e) {
    addLog('❌ Erro fatal: ' + e.message);
    return res.status(500).json({ error: e.message, log });
  }
};
