const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function saveTrade(trade){
  await redis.lpush("trades", JSON.stringify(trade));
}

async function saveEquity(value){
  await redis.lpush("equity", JSON.stringify({
    value,
    time: Date.now()
  }));
}

async function getTrades(){
  const data = await redis.lrange("trades", 0, 50);
  return data.map(JSON.parse);
}

async function getEquity(){
  const data = await redis.lrange("equity", 0, 100);
  return data.map(JSON.parse);
}

module.exports = {
  saveTrade,
  saveEquity,
  getTrades,
  getEquity
};
