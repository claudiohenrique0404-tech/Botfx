const { Redis } = require("@upstash/redis");

let redis = null;

if(process.env.UPSTASH_REDIS_REST_URL){
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

async function saveTrade(trade){
  if(!redis) return;
  await redis.lpush("trades", JSON.stringify(trade));
}

async function saveEquity(value){
  if(!redis) return;
  await redis.lpush("equity", JSON.stringify({
    value,
    time: Date.now()
  }));
}

async function getTrades(){
  if(!redis) return [];
  const data = await redis.lrange("trades", 0, 50);
  return data.map(JSON.parse);
}

async function getEquity(){
  if(!redis) return [];
  const data = await redis.lrange("equity", 0, 100);
  return data.map(JSON.parse);
}

module.exports = {
  saveTrade,
  saveEquity,
  getTrades,
  getEquity
};
