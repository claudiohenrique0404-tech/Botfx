// contracts.js — specs de contratos Bitget (checkScale exato por símbolo)
// Carregado uma vez no arranque — elimina brute-force de precisão no SL/TP
const fetch = global.fetch || require('node-fetch');

const BASE = 'https://api.bitget.com';

// Cache: { BTCUSDT: { pricePlace: 1, volumePlace: 3, minTradeNum: 0.001 }, ... }
const contracts = {};

async function loadContracts(attempt = 1) {
  const MAX_RETRIES = 3;
  console.log(`📋 loadContracts tentativa ${attempt}/${MAX_RETRIES}...`);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const url = `${BASE}/api/v2/mix/market/contracts?productType=USDT-FUTURES`;
    console.log(`📋 Fetch: ${url}`);

    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    console.log(`📋 Response status: ${r.status}`);

    const text = await r.text();
    let d;
    try {
      d = JSON.parse(text);
    } catch (parseErr) {
      console.error('❌ Contracts JSON parse erro:', text.slice(0, 200));
      throw parseErr;
    }

    if (d.code === '00000' && Array.isArray(d.data)) {
      for (const c of d.data) {
        contracts[c.symbol] = {
          pricePlace:  parseInt(c.pricePlace)  || 2,
          volumePlace: parseInt(c.volumePlace) || 2,
          minTradeNum: parseFloat(c.minTradeNum) || 0.01,
          sizeMultiplier: parseFloat(c.sizeMultiplier) || 1,
        };
      }
      console.log(`✅ Contracts carregados: ${Object.keys(contracts).length} símbolos`);
      // Log amostra para confirmar
      const sample = contracts['BTCUSDT'];
      if (sample) console.log(`   BTCUSDT: pricePlace=${sample.pricePlace} volumePlace=${sample.volumePlace} minQty=${sample.minTradeNum}`);
      const sample2 = contracts['ETHUSDT'];
      if (sample2) console.log(`   ETHUSDT: pricePlace=${sample2.pricePlace} volumePlace=${sample2.volumePlace} minQty=${sample2.minTradeNum}`);
    } else {
      console.error('❌ Contracts resposta inesperada:', d.code, d.msg);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        return loadContracts(attempt + 1);
      }
    }
  } catch (e) {
    console.error(`❌ Contracts load erro (tentativa ${attempt}):`, e.message);
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      return loadContracts(attempt + 1);
    }
    console.error('❌ Contracts: todas as tentativas falharam — a usar fallback heurístico');
  }
}

function getContract(symbol) {
  return contracts[symbol] || null;
}

// Truncar size para volumePlace do contrato (nunca arredondar para cima)
function formatSize(symbol, size) {
  const c = contracts[symbol];
  if (!c) {
    // Fallback conservador sem specs
    return size > 1 ? String(Math.floor(size)) : String(parseFloat(size.toFixed(3)));
  }
  const dp = c.volumePlace;
  const factor = Math.pow(10, dp);
  const truncated = Math.floor(size * factor) / factor;
  return truncated.toFixed(dp);
}

// Formatar preço para pricePlace do contrato
function formatPrice(symbol, price) {
  const c = contracts[symbol];
  if (!c) {
    // Fallback heurístico
    const dp = price > 10000 ? 1 : price > 100 ? 2 : price > 1 ? 4 : 6;
    return price.toFixed(dp);
  }
  return price.toFixed(c.pricePlace);
}

// Mínimo de qty do contrato
function getMinQty(symbol) {
  const c = contracts[symbol];
  return c ? c.minTradeNum : 0.01;
}

module.exports = { loadContracts, getContract, formatSize, formatPrice, getMinQty };
