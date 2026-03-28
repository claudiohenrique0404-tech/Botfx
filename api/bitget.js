if(!global.settings){
  global.settings = { active:false };
}

if(!global.positions){
  global.positions = [];
}

const settings = global.settings;
const positions = global.positions;

module.exports = async (req,res)=>{

  try{

    const { action, symbol, side, quantity } = req.body || {};

    // ===== SETTINGS
    if(action === 'getSettings'){
      return res.json(settings);
    }

    if(action === 'toggleBot'){
      settings.active = !settings.active;
      return res.json(settings);
    }

    // ===== BALANCE
    if(action === 'balance'){
      return res.json([{available:114.89}]);
    }

    // ===== POSITIONS
    if(action === 'positions'){
      return res.json(positions);
    }

    // ===== ORDER
    if(action === 'order'){

      const newPos = {
        symbol,
        holdSide: side === 'BUY' ? 'long' : 'short',
        total: quantity,
        unrealizedPL: 0
      };

      positions.push(newPos);

      return res.json({ok:true, position:newPos});
    }

    // ===== CANDLES (FAKE PARA TESTE)
    if(action === 'candles'){

      let arr = [];

      for(let i=0;i<100;i++){
        arr.push([0,0,0,0,50000 + Math.random()*1000]);
      }

      return res.json(arr);
    }

    return res.json({error:'invalid action'});

  }catch(e){
    return res.json({error:e.message});
  }
};