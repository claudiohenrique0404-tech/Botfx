const STRAT = require('./strategies');
const MLAPI = require('./ml-client');
const { saveTrade, saveEquity } = require('./db');
const { buildFeatures } = require('./features');

let LOGS = [];
let LAST_TRADE = 0;

// ===== TRACKING POSIÇÕES =====
let TRACKING = {};

const BREAK_EVEN = 0.3;
const TRAIL_START = 0.5;
const TRAIL_DIST = 0.3;

function log(msg){
  const time = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const entry = `[${time}] ${msg}`;
  console.log(entry);

  LOGS.unshift(entry);
  if(LOGS.length > 150) LOGS.pop();
}

module.exports = async (req,res)=>{

  try{

    const base = 'https://botfx-blush.vercel.app';

    // ===== SETTINGS =====
    const settings = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'getSettings'})
    })).json();

    if(!settings.active){
      log('⏸ Bot desligado');
      return res.json({logs:LOGS});
    }

    // ===== BALANCE =====
    const balanceData = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    const balance = parseFloat(balanceData[0]?.available || 0);

    log(`💰 Balance: ${balance.toFixed(2)}`);

    // ===== POSITIONS =====
    const positions = await (await fetch(base+'/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    // ===== GESTÃO DE POSIÇÕES (TRAILING + BE)
    for(const p of positions){

      const sym = p.symbol;
      const entry = parseFloat(p.openPriceAvg || p.openPrice);
      const price = parseFloat(p.markPrice || p.last);
      const side = p.holdSide;

      if(!entry || !price) continue;

      let pnl = side === 'long'
        ? ((price - entry)/entry)*100
        : ((entry - price)/entry)*100;

      log(`📊 ${sym} ${pnl.toFixed(2)}%`);

      if(!TRACKING[sym]){
        TRACKING[sym] = {
          maxPnL: pnl,
          breakEven: false
        };
      }

      const t = TRACKING[sym];

      if(pnl > t.maxPnL){
        t.maxPnL = pnl;
      }

      // BREAK EVEN
      if(pnl >= BREAK_EVEN && !t.breakEven){
        t.breakEven = true;
        log(`🟡 BE ATIVO ${sym}`);
      }

      // STOP LOSS
      if(!t.breakEven && pnl <= -0.5){
        log(`🛑 STOP LOSS ${sym}`);
        await closeAll(sym, side, base, pnl);
        delete TRACKING[sym];
        continue;
      }

      // BREAK EVEN EXIT
      if(t.breakEven && pnl <= 0){
        log(`⚖️ BREAK EVEN EXIT ${sym}`);
        await closeAll(sym, side, base, pnl);
        delete TRACKING[sym];
        continue;
      }

      // TRAILING STOP
      if(t.maxPnL >= TRAIL_START){

        const trail = t.maxPnL - TRAIL_DIST;

        if(pnl <= trail){
          log(`📉 TRAILING EXIT ${sym}`);
          await closeAll(sym, side, base, pnl);
          delete TRACKING[sym];
          continue;
        }
      }
    }

    // ===== NOVAS ENTRADAS =====
    for(const sym of settings.symbols){

      if(positions.find(p=>p.symbol===sym)) continue;

      log(`🔍 Analisar ${sym}`);

      const candles = await (await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'candles',
          symbol:sym,
          tf:'1m'
        })
      })).json();

      if(!candles.length){
        log('⚠️ sem dados');
        continue;
      }

      const closes = candles.map(c=>+c[4]);
      const price = closes.at(-1);

      // ===== FEATURES PROFISSIONAIS 🔥
      const features = buildFeatures(closes);

      // ===== ML FILTER 🔥
      const prediction = await MLAPI.getPrediction(features);

      if(!prediction || prediction.confidence < 0.6){
        log('🧠 ML bloqueou');
        continue;
      }

      log(`🧠 ML ok (${prediction.confidence.toFixed(2)})`);

      // ===== STRATEGY BASE =====
      const signal = STRAT.trendBot(closes);

      if(!signal){
        log('❌ sem sinal');
        continue;
      }

      // ===== COOLDOWN =====
      const now = Date.now();
      if(now - LAST_TRADE < 8000){
        log('⏱ cooldown ativo');
        continue;
      }

      // ===== POSITION SIZE =====
      const qty = (Math.max(5, balance*0.01)/price).toFixed(4);

      log(`⚖️ qty:${qty}`);

      const r = await fetch(base+'/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol:sym,
          side:signal.side,
          quantity:qty
        })
      });

      const data = await r.json();

      if(data.code !== '00000'){
        log(`❌ erro ordem ${data.msg}`);
        continue;
      }

      LAST_TRADE = Date.now();

      log(`🚀 ${signal.side} ${sym}`);

      TRACKING[sym] = {
        maxPnL: 0,
        breakEven: false
      };

      await saveTrade({
        symbol:sym,
        side:signal.side,
        qty,
        time:Date.now(),
        features: features
      });

      await saveEquity(balance);

      break;
    }

    // ===== TREINO AUTOMÁTICO ML 🔥
    await fetch(base+'/api/ml-train',{
      method:'POST'
    });

    res.json({logs:LOGS});

  }catch(e){
    log(`🔥 ${e.message}`);
    res.json({logs:LOGS});
  }
};

// ===== FECHAR POSIÇÃO =====
async function closeAll(symbol, side, base, pnl){

  const closeSide = side === 'long' ? 'SELL' : 'BUY';

  await fetch(base+'/api/bitget',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      action:'order',
      symbol,
      side:closeSide,
      quantity:9999
    })
  });

  // 🔥 enviar resultado para treino
  await fetch(base+'/api/db-update',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      symbol,
      pnl
    })
  });
}
