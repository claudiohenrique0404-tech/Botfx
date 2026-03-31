const runBot = require('./api/cron');
const http   = require('http');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Capturar erros não tratados — evita mortes silenciosas ──
process.on('uncaughtException', err => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message, err.stack);
  // Não sair — o loop continua
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION:', reason);
  // Não sair — o loop continua
});

// ── Servidor HTTP anti-sleep ────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('BOT RUNNING');
}).listen(process.env.PORT || 3000, () => {
  console.log('🌐 HTTP server running');
});

// ── Heartbeat — confirma que o processo está vivo ───────────
setInterval(() => {
  console.log(`❤️ alive ${new Date().toLocaleTimeString('pt-PT', { timeZone: 'Europe/Lisbon' })}`);
}, 15000); // a cada 15s — detetar freezes mais rápido

let running = false;

async function start() {
  console.log('🚀 BOT STARTED');

  while (true) {
    if (running) {
      await sleep(1000);
      continue;
    }

    running = true;

    try {
      // Timeout global: se runBot() não terminar em 45s, aborta o ciclo
      await Promise.race([
        runBot(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('runBot timeout 45s')), 45000)),
      ]);
    } catch (e) {
      console.error('🔥 LOOP ERROR:', e.message);
    } finally {
      running = false; // garantido mesmo em casos extremos
    }
    await sleep(5000);
  }
}

start();
