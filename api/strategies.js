function ema(data,p){
 let k=2/(p+1), e=data[0];
 for(let i=1;i<data.length;i++) e=data[i]*k+e*(1-k);
 return e;
}

function rsi(data,p=14){
 let g=0,l=0;
 for(let i=data.length-p;i<data.length;i++){
  let d=data[i]-data[i-1];
  if(d>0) g+=d; else l-=d;
 }
 if(l===0) return 100;
 let rs=g/l;
 return 100-(100/(1+rs));
}

function trendBot(closes){
 const e20 = ema(closes.slice(-20),20);
 const e50 = ema(closes.slice(-50),50);

 if(e20>e50) return {side:'BUY', confidence:0.6};
 if(e20<e50) return {side:'SELL', confidence:0.6};

 return null;
}

function rsiBot(closes){
 const r = rsi(closes);

 if(r<30) return {side:'BUY', confidence:0.7};
 if(r>70) return {side:'SELL', confidence:0.7};

 return null;
}

function momentumBot(closes){
 const change = (closes.at(-1)-closes.at(-5))/closes.at(-5);

 if(change>0.01) return {side:'BUY', confidence:0.5};
 if(change<-0.01) return {side:'SELL', confidence:0.5};

 return null;
}

module.exports = { trendBot, rsiBot, momentumBot };
