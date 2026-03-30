// brain.js — pesos adaptativos com persistência Redis
const { Redis } = require('@upstash/redis');

// ── Redis client ─────────────────────────────────────────
let redis = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
} catch (e) {
  console.log('⚠️ Brain Redis erro:', e.message);
}

// ── Estado inicial (defaults) ─────────────────────────────
const DEFAULT_STATS = {
  trend:    { wins: 1, losses: 1 },
  rsi:      { wins: 1, losses: 1 },
  momentum: { wins: 1, losses: 1 },
};

let BOT_STATS = { ...DEFAULT_STATS };
let statsLoaded = false;

// ── Carregar do Redis no arranque ─────────────────────────
async function loadStats() {
  if (!redis || statsLoaded) return;
  try {
    const saved = await redis.get('botfx:brain');
    if (saved) {
      BOT_STATS = saved;
      console.log('🧠 Brain carregado:', JSON.stringify(BOT_STATS));
    }
    statsLoaded = true;
  } catch (e) {
    console.log('⚠️ Brain load erro:', e.message);
  }
}

loadStats();

// ── Persistir ─────────────────────────────────────────────
async function persistStats() {
  if (!redis) return;
  try {
    await redis.set('botfx:brain', BOT_STATS);
  } catch (e) {
    console.log('⚠️ Brain persist erro:', e.message);
  }
}

// ── API pública (idêntica ao original) ───────────────────
function updateBot(bot, pnl) {
  if (!BOT_STATS[bot]) return;
  if (pnl > 0) BOT_STATS[bot].wins++;
  else          BOT_STATS[bot].losses++;
  persistStats(); // async, não bloqueia
}

function getWeight(bot) {
  const s = BOT_STATS[bot];
  if (!s) return 0.5;
  const total = s.wins + s.losses;
  if (total === 0) return 0.5;
  return Math.max(0.2, Math.min(0.8, s.wins / total));
}

function getWeights() {
  const w = {};
  for (const k in BOT_STATS) w[k] = getWeight(k);
  return w;
}

module.exports = { updateBot, getWeights };
