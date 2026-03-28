const fetch = global.fetch || require('node-fetch');

async function getPrediction(features){

  try{

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const r = await fetch('https://ml-api-production-d47c.up.railway.app/predict',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ data: features }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    const d = await r.json();

    if(!d || typeof d.confidence !== 'number'){
      return null;
    }

    return d;

  }catch(e){
    console.log('ML ERROR:', e.message);
    return null;
  }
}

module.exports = { getPrediction };
