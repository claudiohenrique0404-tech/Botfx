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
  // Anti-sleep: responde a qualquer outro pedido
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('BOT RUNNING');
}).listen(process.env.PORT || 3000, () => {
  console.log('🌐 HTTP server running');
});

// ── Heartbeat — confirma que o processo está vivo ───────────
setInterval(() => {
  console.log(`❤️ alive ${new Date().toLocaleTimeString('pt-PT', { timeZone: 'Europe/Lisbon' })}`);
}, 15000);

// ── Watchdog — mata o processo se o bot ficar frozen ────────
// O Render reinicia automaticamente após process.exit()
// lastBotRun é actualizado no início de cada ciclo em cron.js
global.lastBotRun = Date.now();

setInterval(() => {
  const elapsed = Date.now() - global.lastBotRun;
  if (elapsed > 90000) { // 90s sem actividade — freeze confirmado
    console.error(`💀 WATCHDOG: bot frozen ${Math.round(elapsed/1000)}s — restarting`);
    process.exit(1);
  }
}, 30000); // verifica a cada 30s

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
