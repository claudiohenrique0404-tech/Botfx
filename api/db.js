const { Redis } = require("@upstash/redis");

// 🔥 fallback memória
let memory = {
  trades: [],
  equity: []
};

let redis = null;

if(process.env.UPSTASH_REDIS_REST_URL){
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

// ===== SAVE =====

async function saveTrade(trade){

  if(redis){
    await redis.lpush("trades", JSON.stringify(trade));
  }else{
    memory.trades.unshift(trade);
  }
}

async function saveEquity(value){

  const data = {
    value,
    time: Date.now()
  };

  if(redis){
    await redis.lpush("equity", JSON.stringify(data));
  }else{
    memory.equity.unshift(data);
  }
}

// ===== GET =====

async function getTrades(){

  if(redis){
    const data = await redis.lrange("trades", 0, 50);
    return data.map(JSON.parse);
  }

  return memory.trades;
}

async function getEquity(){

  if(redis){
    const data = await redis.lrange("equity", 0, 100);
    return data.map(JSON.parse);
  }

  return memory.equity;
}

module.exports = {
  saveTrade,
  saveEquity,
  getTrades,
  getEquity
};
