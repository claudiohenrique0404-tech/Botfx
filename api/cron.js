module.exports = async (req, res) => {
  try {

    const base = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : '';

    // SETTINGS
    const sRes = await fetch(base + '/api/bitget', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'getSettings'})
    });

    const settings = await sRes.json();

    // PREÇOS
    const pRes = await fetch(base + '/api/bitget', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'allPrices'})
    });

    const prices = await pRes.json();
    const btc = prices.find(x => x.symbol === 'BTCUSDT');

    if (!btc) throw new Error('No BTC');

    // TAMANHO baseado em risco
    const balance = 100; // simplificado
    const riskAmount = balance * (settings.risk / 100);

    const qty = (riskAmount / btc.price).toFixed(4);

    // lógica simples (placeholder)
    if (Math.random() > 0.7) {

      await fetch(base + '/api/bitget', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:'BTCUSDT',
          side:'BUY',
          quantity:qty
        })
      });

    }

    return res.json({ ok:true, settings });

  } catch (e) {
    return res.status(500).json({ error:e.message });
  }
};
