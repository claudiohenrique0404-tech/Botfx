const { getDataset } = require('./db');

module.exports = async (req,res)=>{

  const data = getDataset();

  const r = await fetch('https://ml-api-production-d47c.up.railway.app/train',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ data })
  });

  const d = await r.json();

  res.json(d);
};
