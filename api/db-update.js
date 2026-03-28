const { updateTradeResult } = require('./db');
const BRAIN = require('./brain');

module.exports = async (req,res)=>{

  const { symbol, pnl, bots=[] } = req.body;

  updateTradeResult(symbol, pnl);

  // 🔥 RL UPDATE
  for(const b of bots){
    BRAIN.updateBot(b, pnl);
  }

  res.json({ok:true});
};
