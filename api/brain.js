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
  trend:      { wins: 1, losses: 1, totalPnl: 0 },
  rsi:        { wins: 1, losses: 1, totalPnl: 0 },
  momentum:   { wins: 1, losses: 1, totalPnl: 0 },
  breakout:   { wins: 1, losses: 1, totalPnl: 0 },
  volume:     { wins: 1, losses: 1, totalPnl: 0 },
  volatility: { wins: 1, losses: 1, totalPnl: 0 },
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
  BOT_STATS[bot].totalPnl = (BOT_STATS[bot].totalPnl || 0) + pnl;
  persistStats();
}

function getWeight(bot) {
  const s = BOT_STATS[bot];
  if (!s) return 0.5;
  const total = s.wins + s.losses;
  if (total < 20) return 0.5; // sem dados suficientes — neutro

  const winRate = s.wins / total;
  const avgPnl  = (s.totalPnl || 0) / total;

  // Score combinado: 70% winrate + 30% qualidade do lucro
  // avgPnl normalizado entre -1 e +1
  const pnlScore = Math.max(-1, Math.min(1, avgPnl / 2));
  const score    = winRate * 0.7 + pnlScore * 0.3;

  return Math.max(0.15, Math.min(0.9, 0.3 + score * 0.7));
}

// Retorna estatísticas detalhadas por bot
function getBotStats() {
  const stats = {};
  for (const k in BOT_STATS) {
    const s = BOT_STATS[k];
    const total = s.wins + s.losses;
    const avgPnl = total > 0 ? ((s.totalPnl || 0) / total).toFixed(2) : '0';
    stats[k] = {
      wins: s.wins,
      losses: s.losses,
      total,
      winRate: total > 0 ? ((s.wins / total) * 100).toFixed(1) + '%' : '—',
      avgPnl: avgPnl + '%',
      weight: getWeight(k).toFixed(2),
    };
  }
  return stats;
}

function getWeights() {
  const w = {};
  for (const k in BOT_STATS) w[k] = getWeight(k);
  return w;
}

module.exports = { updateBot, getWeights, getBotStats };
