const { updateTradeResult } = require('./db');

module.exports = async (req,res)=>{

  try{
    const { symbol, pnl } = req.body;

    updateTradeResult(symbol, pnl);

    res.json({ok:true});

  }catch(e){
    res.status(500).json({error:e.message});
  }
};
