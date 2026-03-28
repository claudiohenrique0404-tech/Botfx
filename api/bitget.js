if(!global.settings){
  global.settings = {
    active:false
  };
}

const settings = global.settings;

module.exports = async (req,res)=>{

  try{

    const { action } = req.body || {};

    // ===== SETTINGS
    if(action === 'getSettings'){
      return res.json(settings);
    }

    if(action === 'toggleBot'){
      settings.active = !settings.active;
      global.settings = settings;
      return res.json(settings);
    }

    // ===== MOCK SAFE (USA O TEU REAL SE JÁ TENS)
    if(action === 'balance'){
      return res.json([{available:114.89}]);
    }

    if(action === 'positions'){
      return res.json([]);
    }

    if(action === 'candles'){
      return res.json([]);
    }

    if(action === 'order'){
      return res.json({ok:true});
    }

    return res.json({error:'invalid'});

  }catch(e){
    return res.json({error:e.message});
  }
};