import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function saveTrade(trade){
  await redis.lpush("trades", JSON.stringify(trade));
}

export async function saveEquity(value){
  await redis.lpush("equity", JSON.stringify({
    value,
    time: Date.now()
  }));
}

export async function getTrades(){
  const data = await redis.lrange("trades", 0, 50);
  return data.map(JSON.parse);
}

export async function getEquity(){
  const data = await redis.lrange("equity", 0, 100);
  return data.map(JSON.parse);
}
