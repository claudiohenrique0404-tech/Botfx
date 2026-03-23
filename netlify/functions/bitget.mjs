import { createHmac } from 'node:crypto';
function sign(ts, method, path, body, secret) {
return createHmac('sha256', secret)
.update(ts + method.toUpperCase() + path + (body || ""))
.digest('base64');
}
const STOCKS = ["NVDA","TSLA","AAPL","META","GOOGL","MSFT","AMZN","NFLX","AMD","INTC","COIN",
const isStock = s => STOCKS.some(x => (s||"").toUpperCase().startsWith(x));
const getPT = (s, o) => o ? o.toUpperCase() : isStock(s) ? 'SUSDT-FUTURES' : 'USDT-FUTURES';
const BASE = "https://api.bitget.com";
function makeHdrs(method, path, body, KEY, SEC, PASS) {
const ts = Date.now().toString();
return {
"ACCESS-KEY": KEY,
"ACCESS-SIGN": sign(ts, method, path, body || "", SEC),
"ACCESS-TIMESTAMP": ts,
"ACCESS-PASSPHRASE": PASS,
"Content-Type": 'application/json',
"locale": 'en-US'
};
}
const CORS = {
"Access-Control-Allow-Origin": '*',
"Access-Control-Allow-Methods": "POST, OPTIONS",
"Access-Control-Allow-Headers": "Content-Type",
"Content-Type": 'application/json'
};
export default async (req) => {
if (req.method === 'OPTIONS') return new Response("", { status: 200, headers: CORS });
const KEY = process.env.BITGET_API_KEY;
const SEC = process.env.BITGET_API_SECRET;
const PASS = process.env.BITGET_PASSPHRASE;
if (!KEY || !SEC || !PASS) return new Response(JSON.stringify({ error: "API keys missing" }
const bg = async (method, path, body) => {
const bs = body ? JSON.stringify(body) : undefined;
const r = await fetch(BASE + path, { method, headers: makeHdrs(method, path, bs || "", KE
const d = await r.json();
if (d?.code && d.code !== "00000") throw new Error(d.code + ": " + d.msg);
return d;
};
try {
const { action, ...p } = await req.json();
let result;
if (action === 'ping') {
result = { ok: true };
} else if (action === 'account') {
result = await bg('GET', "/api/v2/mix/account/accounts?productType=usdt-futures");
} else if (action === 'prices') {
const syms = p.symbols || ["BTCUSDT"];
const pt = getPT(syms[0], p.productType);
const out = await Promise.all(syms.map(async sym => {
try {
const r = await fetch(`${BASE}/api/v2/mix/market/symbol-price?productType=${pt}&sym
const d = await r.json();
if (d?.code !== "00000") return { symbol: sym, price: '0' };
const item = Array.isArray(d.data) ? d.data[0] : d.data;
return { symbol: sym, price: item?.price || item?.indexPrice || '0' };
} catch { return { symbol: sym, price: '0' }; }
}));
result = out.filter(x => parseFloat(x.price) > 0);
} else if (action === 'positions') {
const [u, s] = await Promise.all([
bg('GET', "/api/v2/mix/position/all-position?productType=usdt-futures&marginCoin=USDT
bg('GET', "/api/v2/mix/position/all-position?productType=susdt-futures&marginCoin=USD
]);
result = [...(u?.data||[]), ...(s?.data||[])].filter(x => parseFloat(x.total) > 0);
} else if (action === 'order') {
const { symbol, side, quantity, stopLoss, takeProfit, leverage } = p;
const pt = getPT(symbol, p.productType);
const pos = side === 'BUY' ? 'long' : 'short';
const lev = isStock(symbol) ? Math.min(parseInt(leverage)||5, 10) : parseInt(leverage)|
await bg('POST', "/api/v2/mix/account/set-leverage", { symbol, productType: pt, marginC
await new Promise(r => setTimeout(r, 300));
const order = await bg('POST', "/api/v2/mix/order/place-order", { symbol, productType:
if (order?.data?.orderId) {
await new Promise(r => setTimeout(r, 300));
if (stopLoss) await bg('POST', "/api/v2/mix/order/place-tpsl-order", { symbol, produc
if (takeProfit) await bg('POST', "/api/v2/mix/order/place-tpsl-order", { symbol, prod
}
result = order;
} else if (action === 'closePosition') {
const { symbol, side, quantity } = p;
result = await bg('POST', "/api/v2/mix/order/place-order", { symbol, productType: getPT
} else if (action === 'cancelAll') {
await Promise.all([bg('POST', "/api/v2/mix/order/cancel-all-orders", { productType: 'US
result = { ok: true };
} else {
return new Response(JSON.stringify({ error: "Unknown: " + action }), { status: 400, hea
}
return new Response(JSON.stringify(result), { status: 200, headers: CORS });
} catch (err) {
return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS
}
};
export const config = { path: "/api/bitget" };
