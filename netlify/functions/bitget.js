“use strict”;
var crypto = require(“crypto”);

function sign(ts, method, path, body, secret) {
return crypto.createHmac(“sha256”, secret)
.update(ts + method.toUpperCase() + path + (body || “”))
.digest(“base64”);
}

var STOCKS = [“NVDA”,“TSLA”,“AAPL”,“META”,“GOOGL”,“MSFT”,“AMZN”,“NFLX”,“AMD”,“INTC”,“COIN”,“MSTR”,“MA”,“LLY”,“PLTR”,“MCD”,“QQQ”,“GME”,“MRVL”,“RIOT”,“ORCL”,“CRCL”];

function isStock(s) {
for (var i = 0; i < STOCKS.length; i++) {
if ((s || “”).toUpperCase().indexOf(STOCKS[i]) === 0) return true;
}
return false;
}

function getPT(s, o) {
if (o) return o.toLowerCase();
return isStock(s) ? “susdt-futures” : “usdt-futures”;
}

function makeHeaders(method, path, body, KEY, SEC, PASS) {
var ts = Date.now().toString();
return {
“ACCESS-KEY”: KEY,
“ACCESS-SIGN”: sign(ts, method, path, body || “”, SEC),
“ACCESS-TIMESTAMP”: ts,
“ACCESS-PASSPHRASE”: PASS,
“Content-Type”: “application/json”,
“locale”: “en-US”
};
}

var BASE = “https://api.bitget.com”;

exports.handler = async function(event) {
var headers = {
“Access-Control-Allow-Origin”: “*”,
“Access-Control-Allow-Methods”: “POST, OPTIONS”,
“Access-Control-Allow-Headers”: “Content-Type”,
“Content-Type”: “application/json”
};

if (event.httpMethod === “OPTIONS”) {
return { statusCode: 200, headers: headers, body: “” };
}

var KEY = process.env.BITGET_API_KEY;
var SEC = process.env.BITGET_API_SECRET;
var PASS = process.env.BITGET_PASSPHRASE;

if (!KEY || !SEC || !PASS) {
return { statusCode: 500, headers: headers, body: JSON.stringify({ error: “API keys missing” }) };
}

async function bg(method, path, body) {
var bs = body ? JSON.stringify(body) : undefined;
var r = await fetch(BASE + path, {
method: method,
headers: makeHeaders(method, path, bs || “”, KEY, SEC, PASS),
body: bs
});
var d = await r.json();
if (d && d.code && d.code !== “00000”) {
throw new Error(d.code + “: “ + d.msg);
}
return d;
}

try {
var data = JSON.parse(event.body || “{}”);
var action = data.action;
var p = Object.assign({}, data);
delete p.action;
var result;

```
if (action === "ping") {
  result = { ok: true };

} else if (action === "account") {
  result = await bg("GET", "/api/v2/mix/account/accounts?productType=usdt-futures");

} else if (action === "prices") {
  var syms = p.symbols || ["BTCUSDT"];
  var pt = getPT(syms[0], p.productType);
  var priceResults = await Promise.all(syms.map(async function(sym) {
    try {
      var r = await fetch(BASE + "/api/v2/mix/market/symbol-price?productType=" + pt + "&symbol=" + sym);
      var d = await r.json();
      if (!d || d.code !== "00000") return { symbol: sym, price: "0" };
      var item = Array.isArray(d.data) ? d.data[0] : d.data;
      return { symbol: sym, price: (item && (item.price || item.indexPrice)) || "0" };
    } catch(e) {
      return { symbol: sym, price: "0" };
    }
  }));
  result = priceResults.filter(function(x) { return parseFloat(x.price) > 0; });

} else if (action === "positions") {
  var u = await bg("GET", "/api/v2/mix/position/all-position?productType=usdt-futures&marginCoin=USDT");
  var s;
  try {
    s = await bg("GET", "/api/v2/mix/position/all-position?productType=susdt-futures&marginCoin=USDT");
  } catch(e) {
    s = { data: [] };
  }
  var allPos = (u.data || []).concat(s.data || []);
  result = allPos.filter(function(x) { return parseFloat(x.total) > 0; });

} else if (action === "order") {
  var symbol = p.symbol;
  var side = p.side;
  var quantity = p.quantity;
  var stopLoss = p.stopLoss;
  var takeProfit = p.takeProfit;
  var leverage = p.leverage;
  var pt2 = getPT(symbol, p.productType);
  var pos = side === "BUY" ? "long" : "short";
  var lev = isStock(symbol) ? Math.min(parseInt(leverage) || 5, 10) : parseInt(leverage) || 5;

  try {
    await bg("POST", "/api/v2/mix/account/set-leverage", {
      symbol: symbol, productType: pt2, marginCoin: "USDT",
      leverage: String(lev), holdSide: pos
    });
  } catch(e) { console.log("lev:", e.message); }

  await new Promise(function(resolve) { setTimeout(resolve, 300); });

  var order = await bg("POST", "/api/v2/mix/order/place-order", {
    symbol: symbol, productType: pt2, marginCoin: "USDT",
    side: side === "BUY" ? "buy" : "sell",
    tradeSide: "open", orderType: "market",
    size: String(quantity), leverage: String(lev)
  });

  if (order && order.data && order.data.orderId) {
    await new Promise(function(resolve) { setTimeout(resolve, 300); });
    if (stopLoss) {
      try {
        await bg("POST", "/api/v2/mix/order/place-tpsl-order", {
          symbol: symbol, productType: pt2, marginCoin: "USDT",
          planType: "loss_plan", holdSide: pos,
          triggerPrice: String(stopLoss), triggerType: "mark_price",
          executePrice: "0", size: String(quantity)
        });
      } catch(e) { console.log("SL:", e.message); }
    }
    if (takeProfit) {
      try {
        await bg("POST", "/api/v2/mix/order/place-tpsl-order", {
          symbol: symbol, productType: pt2, marginCoin: "USDT",
          planType: "profit_plan", holdSide: pos,
          triggerPrice: String(takeProfit), triggerType: "mark_price",
          executePrice: "0", size: String(quantity)
        });
      } catch(e) { console.log("TP:", e.message); }
    }
  }
  result = order;

} else if (action === "closePosition") {
  var cSym = p.symbol;
  var cSide = p.side;
  var cQty = p.quantity;
  result = await bg("POST", "/api/v2/mix/order/place-order", {
    symbol: cSym, productType: getPT(cSym, p.productType), marginCoin: "USDT",
    side: cSide === "LONG" ? "sell" : "buy",
    tradeSide: "close", orderType: "market",
    size: String(Math.abs(parseFloat(cQty)))
  });

} else if (action === "cancelAll") {
  try { await bg("POST", "/api/v2/mix/order/cancel-all-orders", { productType: "usdt-futures", marginCoin: "USDT" }); } catch(e) {}
  try { await bg("POST", "/api/v2/mix/order/cancel-all-orders", { productType: "susdt-futures", marginCoin: "USDT" }); } catch(e) {}
  result = { ok: true };

} else {
  return { statusCode: 400, headers: headers, body: JSON.stringify({ error: "Unknown: " + action }) };
}

return { statusCode: 200, headers: headers, body: JSON.stringify(result) };
```

} catch(err) {
console.error(“BotFX:”, err.message);
return { statusCode: 500, headers: headers, body: JSON.stringify({ error: err.message }) };
}
};