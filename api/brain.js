let BOT_STATS = {
  trend: {wins:1, losses:1},
  rsi: {wins:1, losses:1},
  momentum: {wins:1, losses:1}
};

function updateBot(bot, pnl){

  if(!BOT_STATS[bot]) return;

  if(pnl > 0) BOT_STATS[bot].wins++;
  else BOT_STATS[bot].losses++;
}

function getWeight(bot){

  const s = BOT_STATS[bot];
  const total = s.wins + s.losses;

  if(total === 0) return 0.5;

  // 🔥 suavização (evita extremos)
  return Math.max(0.2, Math.min(0.8, s.wins / total));
}

function getWeights(){

  let w = {};

  for(const k in BOT_STATS){
    w[k] = getWeight(k);
  }

  return w;
}

module.exports = {
  updateBot,
  getWeights
};
