let BOT_LOGS = [];

function log(msg){
  console.log(msg);
  BOT_LOGS.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if(BOT_LOGS.length > 60) BOT_LOGS.pop();
}

module.exports = async (req, res) => {
  try {

    const base = process.env.VERCEL_URL
      ? 'https://' + process.env.VERCEL_URL
      : '';

    // SETTINGS
    const sRes = await fetch(base + '/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'getSettings'})
    });

    const settings = await sRes.json();

    log(`⚙️ Lev ${settings.lev}x | Risk ${settings.risk}%`);

    // PRICES
    const pRes = await fetch(base + '/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'allPrices'})
    });

    const prices = await pRes.json();

    // POSITIONS
    const posRes = await fetch(base + '/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    });

    const positions = await posRes.json();

    log(`📊 Posições: ${positions.length}/${settings.maxPositions}`);

    if (positions.length >= settings.maxPositions) {
      log('⏸ Máx posições atingido');
      return res.json({ok:true, logs: BOT_LOGS});
    }

    for (const sym of settings.symbols) {

      const asset = prices.find(p => p.symbol === sym);
      if (!asset) continue;

      // MOMENTUM SIMPLES
      const move = (Math.random() - 0.5) * 2;

      log(`📈 ${sym} move: ${move.toFixed(3)}`);

      if (Math.abs(move) < 0.4) {
        log(`❌ ${sym} sem força`);
        continue;
      }

      // TAMANHO (mínimo 5€)
      const balance = 120;
      const tradeSize = Math.max(5, balance * (settings.risk / 100));

      const qty = (tradeSize / asset.price).toFixed(4);

      const side = move > 0 ? 'BUY' : 'SELL';

      log(`🚀 Entrada ${sym} (${side}) size €${tradeSize}`);

      await fetch(base + '/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:sym,
          side,
          quantity:qty
        })
      });

      break; // só 1 trade por ciclo (consistência)

    }

    return res.json({ok:true, logs: BOT_LOGS});

  } catch (e) {
    console.error(e);
    return res.status(500).json({error:e.message});
  }
};
