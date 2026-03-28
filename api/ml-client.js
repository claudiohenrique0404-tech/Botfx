async function getPrediction(data){

  try{

    const r = await fetch('https://ml-api-production-d47c.up.railway.app/predict',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ data })
    });

    const d = await r.json();

    return d;

  }catch(e){
    console.log('ML ERROR:', e.message);
    return null;
  }
}

module.exports = { getPrediction };
