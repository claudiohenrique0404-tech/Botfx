const { updateTradeResult } = require('./db');
const BRAIN = require('./brain');

module.exports = async (req,res)=>{

  try{

    const { id, pnl, bots=[] } = req.body;

    if(!id || typeof pnl !== 'number'){
      return res.status(400).json({ error: 'invalid data' });
    }

    updateTradeResult(id, pnl);

    // 🔥 RL UPDATE (seguro)
    for(const b of bots){
      if(b) BRAIN.updateBot(b, pnl);
    }

    res.json({ok:true});

  }catch(e){
    res.status(500).json({ error: e.message });
  }
};
