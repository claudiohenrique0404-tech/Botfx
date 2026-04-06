// contracts.js — specs de contratos Bitget (checkScale exato por símbolo)
// Carregado uma vez no arranque — elimina brute-force de precisão no SL/TP
const fetch = global.fetch || require('node-fetch');

const BASE = 'https://api.bitget.com';

// Cache: { BTCUSDT: { pricePlace: 1, volumePlace: 3, minTradeNum: 0.001 }, ... }
const contracts = {};

async function loadContracts() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(`${BASE}/api/v2/mix/market/contracts?productType=USDT-FUTURES`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const d = await r.json();

    if (d.code === '00000' && Array.isArray(d.data)) {
      for (const c of d.data) {
        contracts[c.symbol] = {
          pricePlace:  parseInt(c.pricePlace)  || 2,
          volumePlace: parseInt(c.volumePlace) || 2,
          minTradeNum: parseFloat(c.minTradeNum) || 0.01,
          sizeMultiplier: parseFloat(c.sizeMultiplier) || 1,
        };
      }
      console.log(`📋 Contracts carregados: ${Object.keys(contracts).length} símbolos`);
    } else {
      console.error('❌ Contracts resposta inesperada:', d.msg || d.code);
    }
  } catch (e) {
    console.error('❌ Contracts load erro:', e.message);
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
