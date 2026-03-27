function simulateStrategy(data){

  let balance = 100;
  let trades = 0;
  let wins = 0;

  for(let i=20;i<data.length;i++){

    const slice = data.slice(i-20,i);
    const price = data[i];

    const change = (slice.at(-1)-slice[0])/slice[0];

    let side = null;

    if(change > 0.002) side = 'BUY';
    if(change < -0.002) side = 'SELL';

    if(!side) continue;

    trades++;

    const result = Math.random(); // simulação simples

    if(result > 0.5){
      balance += 1;
      wins++;
    }else{
      balance -= 1;
    }
  }

  return {
    pnl: balance-100,
    winrate: trades ? wins/trades : 0
  };
}

// 🔥 OPTIMIZER
function optimize(data){

  let best = null;

  const configs = [
    {threshold:0.001},
    {threshold:0.002},
    {threshold:0.003}
  ];

  for(const c of configs){

    const res = simulateStrategy(data);

    if(!best || res.pnl > best.pnl){
      best = { config:c, ...res };
    }
  }

  return best;
}

module.exports = { simulateStrategy, optimize };
