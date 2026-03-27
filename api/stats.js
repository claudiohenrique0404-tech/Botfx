const { getTrades, getEquity } = require('./db');

module.exports = async (req,res)=>{

  try{

    const trades = await getTrades();
    const equity = await getEquity();

    let pnl = 0;

    if(equity.length > 1){
      pnl = equity[0].value - equity[equity.length-1].value;
    }

    res.json({
      trades,
      equity,
      pnl
    });

  }catch(e){
    res.json({ error: e.message });
  }
};
