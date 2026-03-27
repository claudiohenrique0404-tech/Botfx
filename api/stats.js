const { getTrades, getEquity } = require('./db');

module.exports = async (req,res)=>{

  const trades = await getTrades();
  const equity = await getEquity();

  const pnl = equity.length
    ? equity[0].value - equity.at(-1).value
    : 0;

  res.json({
    trades,
    equity,
    pnl
  });
};
