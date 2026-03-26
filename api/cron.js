let lastTrades = [];

module.exports = async (req, res) => {
  try {
    const pricesRes = await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : ''}/api/bitget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'allPrices' })
    });

    const prices = await pricesRes.json();

    if (!Array.isArray(prices)) {
      throw new Error('Erro a obter preços');
    }

    // 🔥 exemplo simples (BTC)
    const btc = prices.find(p => p.symbol === 'BTCUSDT');

    if (!btc || !btc.price) {
      throw new Error('BTC price inválido');
    }

    // lógica simples só para teste estável
    const shouldBuy = Math.random() > 0.7;

    if (shouldBuy) {
      const orderRes = await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : ''}/api/bitget`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'order',
          symbol: 'BTCUSDT',
          side: 'BUY',
          quantity: 0.001
        })
      });

      const order = await orderRes.json();

      lastTrades.push({
        symbol: 'BTCUSDT',
        entry: btc.price,
        time: new Date().toISOString()
      });

      console.log('✅ TRADE EXECUTADO', order);
    }

    return res.json({
      ok: true,
      price: btc.price,
      trades: lastTrades.slice(-10)
    });

  } catch (e) {
    console.error('❌ CRON ERROR:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
