module.exports = async (req, res) => {
  try {
    const base = process.env.VERCEL_URL
      ? 'https://' + process.env.VERCEL_URL
      : '';

    // 🔧 GET SETTINGS
    const sRes = await fetch(base + '/api/bitget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getSettings' })
    });

    const settings = await sRes.json();

    // 📊 GET PRICES
    const pRes = await fetch(base + '/api/bitget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allPrices' })
    });

    const prices = await pRes.json();

    if (!Array.isArray(prices)) {
      throw new Error('Erro a obter preços');
    }

    const btc = prices.find(p => p.symbol === 'BTCUSDT');

    if (!btc || !btc.price) {
      throw new Error('BTC inválido');
    }

    // 💰 RISK BASED SIZE
    const balance = 100; // simplificado
    const riskAmount = balance * (settings.risk / 100);

    const qty = (riskAmount / btc.price).toFixed(4);

    // ⚠️ LÓGICA SIMPLES (placeholder)
    if (Math.random() > 0.7) {
      await fetch(base + '/api/bitget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'order',
          symbol: 'BTCUSDT',
          side: 'BUY',
          quantity: qty
        })
      });

      console.log('✅ Trade executado');
    }

    return res.json({
      ok: true,
      price: btc.price,
      settings
    });

  } catch (e) {
    console.error('❌ CRON ERROR:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
