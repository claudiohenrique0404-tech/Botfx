const runBot = require('./cron');
const http = require('http');

function sleep(ms){
  return new Promise(r => setTimeout(r, ms));
}

// servidor HTTP (anti-sleep)
http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('BOT RUNNING');
}).listen(process.env.PORT || 3000, () => {
  console.log("🌐 HTTP server running");
});

let running = false;

async function start(){
  console.log("🚀 BOT STARTED");

  while(true){
    if(running){
      console.log("⏳ skipping (still running)");
      await sleep(1000);
      continue;
    }

    running = true;

    try{
      await runBot();
    }catch(e){
      console.log("ERROR:", e.message);
    }

    running = false;

    await sleep(5000);
  }
}

start();