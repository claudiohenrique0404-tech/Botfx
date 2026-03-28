let trades = [];
let equity = [];
let dataset = [];

function saveTrade(t){
  trades.push(t);

  dataset.push({
    features: t.features,
    result: null // ainda não sabemos resultado
  });

  if(trades.length > 500) trades.shift();
}

function updateTradeResult(symbol, pnl){

  const item = dataset.find(d => !d.result);

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
