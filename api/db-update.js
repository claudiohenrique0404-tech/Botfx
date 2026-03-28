const { updateTradeResult } = require('./db');
const BRAIN = require('./brain');

module.exports = async (req,res)=>{

  try{

    const { symbol, pnl, bots=[] } = req.body;

    updateTradeResult(symbol, pnl);

    for(const b of bots){
      BRAIN.updateBot(b, pnl);
    }

    res.json({ok:true});

  }catch(e){
    res.status(500).json({error:e.message});
  }
};
