let STATE = {
 trades: [],
 equity: 120,
 peak: 120
};

function addTrade(pnl){

 STATE.trades.push({ pnl });

 STATE.equity += pnl;

 if(STATE.equity > STATE.peak){
  STATE.peak = STATE.equity;
 }

}

function getMetrics(){

 const wins = STATE.trades.filter(t=>t.pnl>0).length;
 const total = STATE.trades.length;

 const pnl = STATE.trades.reduce((a,b)=>a+b.pnl,0);

 const drawdown = ((STATE.equity - STATE.peak)/STATE.peak)*100;

 return {
  trades: total,
  winrate: total ? (wins/total*100).toFixed(1) : 0,
  pnl: pnl.toFixed(2),
  equity: STATE.equity.toFixed(2),
  drawdown: drawdown.toFixed(2)
 };
}

module.exports = { STATE, addTrade, getMetrics };
