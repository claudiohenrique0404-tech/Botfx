// redis.js — cliente Redis partilhado (instância única)
const { Redis } = require('@upstash/redis');

let redis = null;
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('✅ Redis conectado (shared)');
  } else {
    console.log('⚠️ Redis não configurado — usando memória');
  }
} catch (e) {
  console.log('⚠️ Redis init erro:', e.message);
}

module.exports = redis;
