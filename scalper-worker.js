// scalper-worker.js — entry point do sistema de scalping
// Deploy: Render Web Service, start command: node scalper-worker.js
const http = require('http');
const { loadContracts } = require('./api/contracts');
const runScalper = require('./api/scalper');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

process.on('uncaughtException', err => {
  console.error('💥 UNCAUGHT:', err.message, err.stack);
});
process.on('unhandledRejection', reason => {
  console.error('💥 REJECTION:', reason);
});

// ── HTTP server (keep-alive para Render/UptimeRobot) ──
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SCALPER RUNNING');
}).listen(process.env.PORT || 3000, () => {
  console.log('🌐 Scalper HTTP server running');
});

// ── Heartbeat ──
setInterval(() => {
  console.log(`❤️ scalper alive ${new Date().toLocaleTimeString('pt-PT', { timeZone: 'Europe/Lisbon' })}`);
}, 15000);

// ── Watchdog ──
global.lastScalperRun = Date.now();
setInterval(() => {
  const elapsed = Date.now() - global.lastScalperRun;
  if (elapsed > 60000) {
    console.error(`💀 WATCHDOG: scalper frozen ${Math.round(elapsed/1000)}s — restart`);
    process.exit(1);
  }
}, 15000);

let running = false;

async function start() {
  console.log('📋 A carregar contract specs...');
  await loadContracts();

  console.log('⚡ SCALPER STARTED');

  while (true) {
    if (running) { await sleep(500); continue; }
    running = true;

    try {
      await Promise.race([
        runScalper(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('scalper timeout 45s')), 45000)),
      ]);
    } catch (e) {
      console.error('🔥 LOOP:', e.message);
    } finally {
      running = false;
    }

    await sleep(1000); // 1s — captura picos micro melhor que 3s
  }
}

start();
