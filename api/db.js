// db.js — persistência com Upstash Redis (shared client)
const redis = require('./redis');

// ── Cache em memória (fallback + performance) ─────────────
let trades  = [];
let equity  = [];
let dataset = [];
let loaded  = false;

// ── Carregar estado do Redis no arranque ──────────────────
async function loadFromRedis() {
  if (!redis || loaded) return;
  try {
    const [t, e, d] = await Promise.all([
      redis.get('botfx:trades'),
      redis.get('botfx:equity'),
      redis.get('botfx:dataset'),
    ]);
    if (t) trades  = t;
    if (e) equity  = e;
    if (d) dataset = d;
    loaded = true;
    console.log(`📦 Redis carregado: ${trades.length} trades, ${equity.length} equity pts`);
  } catch (e) {
    console.log('⚠️ Redis load erro:', e.message);
  }
}

loadFromRedis();

// ── Persistir no Redis (async, não bloqueia) ──────────────
async function persist() {
  if (!redis) return;
  try {
    await Promise.all([
      redis.set('botfx:trades',  trades.slice(-500)),
      redis.set('botfx:equity',  equity.slice(-500)),
      redis.set('botfx:dataset', dataset.slice(-500)),
    ]);
  } catch (e) {
    console.log('⚠️ Redis persist erro:', e.message);
  }
}

// ── API pública ───────────────────────────────────────────
async function saveTrade(t) {
  const trade = {
    ...t,
    id:  Date.now() + Math.random(),
    pnl: undefined,
  };
  trades.push(trade);
  dataset.push({
    id:       trade.id,
    features: t.features?.slice(0, 20) || [],
    result:   null,
  });
  if (trades.length  > 500) trades.shift();
  if (dataset.length > 500) dataset.shift();
  await persist();
}

function updateTradeResult(id, pnl) {
  const item = dataset.find(d => d.id === id);
  if (item) item.result = pnl > 0 ? 1 : 0;
}

function setTradePnL(symbol, pnl) {
  const t = [...trades]
    .reverse()
    .find(tr => tr.symbol === symbol && typeof tr.pnl !== 'number');
  if (t) {
    t.pnl = pnl;
    updateTradeResult(t.id, pnl);
    persist(); // async, não await
    return t;
  }
  return null;
}

function getDataset() {
  return dataset.filter(d => d.result !== null);
}

async function saveEquity(e) {
  equity.push({ value: e, time: Date.now() });
  if (equity.length > 500) equity.shift();
  await persist();
}

function getStats() {
  return { trades, equity };
}

module.exports = {
  saveTrade,
  saveEquity,
  getStats,
  getDataset,
  updateTradeResult,
  setTradePnL,
};
