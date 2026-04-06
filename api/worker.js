const runBot = require('./api/cron');
const http   = require('http');
const { loadContracts } = require('./api/contracts');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Capturar erros não tratados — evita mortes silenciosas ──
process.on('uncaughtException', err => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message, err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION:', reason);
});

// ── Servidor HTTP com routing para /api/bitget ─────────────
const bitgetHandler = require('./api/bitget');

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/bitget') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        req.body = JSON.parse(body);
      } catch {
        req.body = {};
      }
      await bitgetHandler(req, res);
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('BOT RUNNING');
}).listen(process.env.PORT || 3000, () => {
  console.log('🌐 HTTP server running');
});

// ── Heartbeat ────────────────────────────────────────────────
setInterval(() => {
  console.log(`❤️ alive ${new Date().toLocaleTimeString('pt-PT', { timeZone: 'Europe/Lisbon' })}`);
}, 15000);

// ── Watchdog — mata o processo se o bot ficar frozen ────────
global.lastBotRun = Date.now();

setInterval(() => {
  const elapsed = Date.now() - global.lastBotRun;
  if (elapsed > 120000) {
    console.error(`💀 WATCHDOG: bot frozen ${Math.round(elapsed/1000)}s — restarting`);
    process.exit(1);
  }
}, 30000);

let running = false;

async function start() {
  // Carregar specs de contratos (pricePlace, volumePlace, minTradeNum)
  // Isto elimina o brute-force de precisão no SL/TP
  console.log('📋 A carregar contract specs...');
  await loadContracts();

  console.log('🚀 BOT STARTED');

  while (true) {
    if (running) {
      await sleep(1000);
      continue;
    }

    running = true;

    try {
      // Timeout global 120s — cron.js já tem timeout de 30s para 'order'
      await Promise.race([
        runBot(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('runBot timeout 120s')), 120000)),
      ]);
    } catch (e) {
      console.error('🔥 LOOP ERROR:', e.message);
    } finally {
      running = false;
    }
    await sleep(15000);
  }
}

start();
