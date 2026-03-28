let trades = [];
let equity = [];
let dataset = [];

function saveTrade(t){

  trades.push({
    ...t,
    pnl: 0
  });

  dataset.push({
    features: t.features,
    result: null
  });

  if(trades.length > 500) trades.shift();
}

function updateTradeResult(symbol, pnl){

  // atualiza último trade aberto
  const trade = [...trades].reverse().find(t=>t.symbol===symbol && t.pnl===0);

  if(trade){
    trade.pnl = pnl;
  }

  const item = dataset.find(d => d.result === null);

  if(item){
    item.result = pnl > 0 ? 1 : 0;
  }
}

function getDataset(){
  return dataset.filter(d => d.result !== null);
}

function saveEquity(e){
  equity.push({value:e,time:Date.now()});
  if(equity.length > 500) equity.shift();
}

function getStats(){
  return {
    trades,
    equity
  };
}

module.exports = {
  saveTrade,
  saveEquity,
  getStats,
  getDataset,
  updateTradeResult
};
