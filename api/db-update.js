const { updateTradeResult } = require('./db');

module.exports = async (req,res)=>{

  const { symbol, pnl } = req.body;

  updateTradeResult(symbol, pnl);

  res.json({ok:true});
};
