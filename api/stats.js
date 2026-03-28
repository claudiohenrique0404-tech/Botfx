const { getStats } = require('./db');
const BRAIN = require('./brain');

module.exports = (req,res)=>{

  const { trades, equity } = getStats();

  let wins = 0;
  let returns = [];

  trades.forEach(t=>{
    if(t.pnl > 0) wins++;
    returns.push(t.pnl || 0);
  });

  const winrate = trades.length ? wins / trades.length : 0;

  // ===== DRAWDOWN =====
  let peak = -Infinity;
  let maxDD = 0;

  equity.forEach(e=>{
    if(e.value > peak) peak = e.value;

    const dd = (peak - e.value) / peak;

    if(dd > maxDD) maxDD = dd;
  });

  // ===== SHARPE =====
  const avg = returns.reduce((a,b)=>a+b,0)/(returns.length||1);

  const std = Math.sqrt(
    returns.reduce((a,b)=>a+Math.pow(b-avg,2),0)/(returns.length||1)
  );

  const sharpe = std ? avg/std : 0;

  // ===== BOT RANKING =====
  const weights = BRAIN.getWeights();

  return res.json({
    trades,
    equity,
    winrate,
    drawdown: maxDD,
    sharpe,
    botRanking: weights
  });
};
