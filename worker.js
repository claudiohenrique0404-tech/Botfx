const runBot = require('./cron');

function sleep(ms){
  return new Promise(r => setTimeout(r, ms));
}

async function start(){
  console.log("🚀 BOT STARTED");

  while(true){
    try{
      await runBot();
    }catch(e){
      console.log("ERROR:", e.message);
    }

    await sleep(5000);
  }
}

start();
