async function getPrediction(data){

  try{
    const r = await fetch('https://teu-ml-api.com/predict',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ data })
    });

    return await r.json();

  }catch{
    return null;
  }
}

module.exports = { getPrediction };
