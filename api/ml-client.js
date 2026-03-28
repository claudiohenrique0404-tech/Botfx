async function getPrediction(data){

  const r = await fetch('https://ml-api-production.up.railway.app/predict',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ data })
  });

  return await r.json();
}

module.exports = { getPrediction };
