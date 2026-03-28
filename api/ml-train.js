const { getDataset } = require('./db');
const fetch = global.fetch || require('node-fetch');

module.exports = async (req,res)=>{

  try{

    const data = getDataset();

    if(!data || data.length < 20){
      return res.status(400).json({ error:'not enough data' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const r = await fetch('https://ml-api-production-d47c.up.railway.app/train',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ data }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    const d = await r.json();

    res.json(d);

  }catch(e){
    res.status(500).json({ error: e.message });
  }
};
