function simulateStrategy(data){

  let wins = 0;
  let trades = 0;

  for(let i=20;i<data.length;i++){

    const change = (data[i]-data[i-5]) / data[i-5];

    if(Math.abs(change) < 0.002) continue;

    trades++;

    if(Math.random() > 0.5) wins++;
  }

  return {
    winrate: trades ? wins/trades : 0,
    pnl: wins - (trades-wins)
  };
}

function optimize(data){

  const res = simulateStrategy(data);

  return {
    winrate: res.winrate,
    pnl: res.pnl
  };
}

module.exports = { optimize };
