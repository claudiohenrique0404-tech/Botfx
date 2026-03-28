let trades = [];
let equity = [];
let dataset = [];

function saveTrade(t){

  const trade = {
    ...t,
    id: Date.now() + Math.random()
  };

  trades.push(trade);

  dataset.push({
    id: trade.id,
    features: t.features?.slice(0, 20) || [],
    result: null
  });

  if(trades.length > 500) trades.shift();
}

function updateTradeResult(id, pnl){

  const item = dataset.find(d => d.id === id);

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
