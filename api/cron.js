const MLAPI = require('./ml-client');
const { saveEquity } = require('./db');
const { buildFeatures } = require('./features');

if(!global.LOGS) global.LOGS = [];

let LOGS = global.LOGS;

function log(msg){
  const t = new Date().toLocaleTimeString('pt-PT',{hour12:false});
  const e = `[${t}] ${msg}`;
  console.log(e);
  LOGS.unshift(e);
  if(LOGS.length > 200) LOGS.pop();
}

module.exports = async (req,res)=>{

  try{

    if(req.query.mode === 'logs'){
      return res.json({logs:LOGS});
    }

    const base = `https://${req.headers.host}`;

    // ===== BALANCE
    const balanceData = await (await fetch(base + '/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'balance'})
    })).json();

    const balance = parseFloat(balanceData?.[0]?.available || 0);

    // ===== POSITIONS
    const positions = await (await fetch(base + '/api/bitget',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'positions'})
    })).json();

    log(`💰 Balance ${balance}`);
    log(`📊 Positions ${positions.length}`);

    // =========================
    // 🔥 SE NÃO HÁ POSIÇÕES → ANALISAR
    // =========================

    if(positions.length === 0){

      const symbol = 'BTCUSDT';

      const candles = await (await fetch(base + '/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'candles',
          symbol,
          tf:'1m'
        })
      })).json();

      if(!candles || !candles.length){
        log(`❌ Sem dados de mercado`);
        return res.json({logs:LOGS});
      }

      const closes = candles.map(c=>+c[4]);

      // =========================
      // 🤖 BOT TREND
      // =========================

      const trendUp = closes.at(-1) > closes.at(-20);
      log(`📈 TrendBot: ${trendUp ? 'UPTREND' : 'DOWNTREND'}`);

      // =========================
      // 🤖 BOT MEAN REVERSION
      // =========================

      const avg = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
      const deviation = closes.at(-1) - avg;

      let meanSignal = null;

      if(deviation > 50){
        meanSignal = 'SELL';
      }else if(deviation < -50){
        meanSignal = 'BUY';
      }

      log(`📊 MeanBot: deviation ${deviation.toFixed(2)} → ${meanSignal || 'NEUTRAL'}`);

      // =========================
      // 🤖 BOT ML
      // =========================

      const features = buildFeatures(closes);
      const pred = await MLAPI.getPrediction(features);

      let mlSignal = null;

      if(pred && pred.confidence > 0.6){
        mlSignal = pred.direction;
      }

      log(`🧠 MLBot: ${mlSignal || 'NO SIGNAL'} (${(pred?.confidence||0).toFixed(2)})`);

      // =========================
      // 🤖 VOTAÇÃO
      // =========================

      let votes = {BUY:0, SELL:0};

      if(trendUp) votes.BUY++; else votes.SELL++;
      if(meanSignal) votes[meanSignal]++;
      if(mlSignal) votes[mlSignal]++;

      log(`🗳️ Votes → BUY:${votes.BUY} SELL:${votes.SELL}`);

      let final = null;

      if(votes.BUY > votes.SELL) final = 'BUY';
      if(votes.SELL > votes.BUY) final = 'SELL';

      if(!final){
        log(`⏸️ Sem consenso`);
        return res.json({logs:LOGS});
      }

      // =========================
      // 💰 RISK MANAGER
      // =========================

      const price = closes.at(-1);
      const qty = ((balance * 0.005)/price).toFixed(4);

      log(`⚖️ Risk: size ${qty}`);

      // =========================
      // 🚀 EXECUÇÃO
      // =========================

      log(`🚀 EXECUTAR ${final} ${symbol}`);

      await fetch(base + '/api/bitget',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          action:'order',
          symbol,
          side:final,
          quantity:qty
        })
      });

    }else{
      log(`⏸️ Já existe posição`);
    }

    await saveEquity(balance);

    return res.json({logs:LOGS});

  }catch(e){
    log(`🔥 ${e.message}`);
    return res.json({logs:LOGS});
  }
};