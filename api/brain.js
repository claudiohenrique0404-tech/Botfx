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

  return s.wins / total; // winrate
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
