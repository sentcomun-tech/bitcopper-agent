// Bitcopper Strategic Investment Assistant v3.0
// Precios en vivo + ciclos + noticias + análisis Claude + WhatsApp

const https = require("https");
const fs    = require("fs");

const INVESTOR = {
  name:    "Pedro",
  goal:    "$4,000 USD adicionales por mes",
  capital: 10000,
  style:   "Swing trading spot — comprar en soporte, vender en resistencia",
  risk:    "Moderado-agresivo. Stop loss siempre activo.",
  company: "Bitcopper Technologies LLC — Calama, Chile",
};

const ASSETS = {
  ETH: { cgId: "ethereum",  qty: 1.2544,   avgCost: 2067.16,  buyZone: { min: 1900,  max: 2050  }, sellZone: { min: 2200,  max: 2350  }, stop: 1750  },
  TAO: { cgId: "bittensor", qty: 7.21819,  avgCost: 315.10,   buyZone: { min: 265,   max: 310   }, sellZone: { min: 360,   max: 420   }, stop: 240   },
  SOL: { cgId: "solana",    qty: 15.87655, avgCost: 96.52,    buyZone: { min: 70,    max: 88    }, sellZone: { min: 105,   max: 125   }, stop: 65    },
  BTC: { cgId: "bitcoin",   qty: 0.00751,  avgCost: 67926.34, buyZone: { min: 60000, max: 68000 }, sellZone: { min: 78000, max: 85000 }, stop: 57000 },
};

const NEWS_FEEDS = [
  { name: "CoinDesk",      url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "CoinTelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt",       url: "https://decrypt.co/feed" },
  { name: "TheBlock",      url: "https://www.theblock.co/rss.xml" },
];

const ASSET_KEYWORDS = {
  BTC: ["bitcoin","btc","trump","iran","fed","federal reserve","etf","blackrock","macro","inflation","war","geopolit","oil","petróleo","guerra","reserva federal","halving","tariff","arancel"],
  ETH: ["ethereum","eth","vitalik","dencun","layer2","l2","rollup","staking","defi","pectra"],
  SOL: ["solana","sol","anatoly","firedancer","solana etf","saga"],
  TAO: ["bittensor","tao","ai","artificial intelligence","inteligencia artificial","opentensor","subnet","agi","openai","deepmind"],
};

const PHASE           = { HOLDING: "HOLDING", WAITING_BUY: "WAITING_BUY" };
const STATE_FILE      = "/tmp/bitcopper_strategic_state.json";
const NEWS_COOLDOWN_H = 6;
const PRC_COOLDOWN_H  = 3;

// ─── HELPERS ───────────────────────────────────────────────
function get(url, raw = false) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { "User-Agent": "BitcopperAgent/3.0" } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) return get(res.headers.location, raw).then(resolve).catch(reject);
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => { if (raw) return resolve(d); try { resolve(JSON.parse(d)); } catch { resolve(d); } });
      }).on("error", reject);
    } catch(e) { reject(e); }
  });
}

function post(url, payload, headers) {
  return new Promise((resolve, reject) => {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: { "Content-Length": Buffer.byteLength(body), ...headers } }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch {
    const s = { alerts: {}, cycles: {}, newsHashes: [], weeklyPnl: 0, monthlyPnl: 0, lastWeekReset: Date.now(), lastMonthReset: Date.now() };
    for (const sym of Object.keys(ASSETS)) s.cycles[sym] = { phase: PHASE.HOLDING, entryPrice: ASSETS[sym].avgCost, cycleCount: 1, profitAccum: 0 };
    return s;
  }
}

function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function canAlert(s, k, h = PRC_COOLDOWN_H) { const l = s.alerts[k]; return !l || (Date.now() - l) / 3600000 >= h; }
function fmtP(p) { return p >= 1000 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : `$${p.toFixed(2)}`; }
function fmtPnl(e, c, q) { const u = (c-e)*q, p = ((c-e)/e*100).toFixed(1); return `${u>=0?"+":""}$${Math.abs(u).toFixed(0)} (${p>=0?"+":""}${p}%)`; }
function hashStr(s) { let h=0; for(let i=0;i<s.length;i++) h=Math.imul(31,h)+s.charCodeAt(i)|0; return h.toString(36); }

// ─── FETCH ─────────────────────────────────────────────────
async function fetchPrices() {
  const ids = Object.values(ASSETS).map(a => a.cgId).join(",");
  const d = await get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_7d_change=true`);
  const r = {};
  for (const [sym, info] of Object.entries(ASSETS)) r[sym] = { price: d[info.cgId]?.usd??0, change24h: d[info.cgId]?.usd_24h_change??0, change7d: d[info.cgId]?.usd_7d_change??0 };
  return r;
}

async function fetchFG() {
  try { const d = await get("https://api.alternative.me/fng/?limit=1"); return { value: d.data[0].value, label: d.data[0].value_classification }; }
  catch { return { value: "?", label: "Unknown" }; }
}

async function fetchDom() {
  try { const d = await get("https://api.coingecko.com/api/v3/global"); return d.data?.market_cap_percentage?.btc?.toFixed(1)??"?"; }
  catch { return "?"; }
}

function parseRSS(xml) {
  const items = []; const re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const it = m[1];
    const title = (it.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)||it.match(/<title>(.*?)<\/title>/))?.[1]?.trim()??"";
    const desc  = (it.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)||it.match(/<description>(.*?)<\/description>/))?.[1]?.replace(/<[^>]+>/g,"")?.trim()?.slice(0,250)??"";
    if (title) items.push({ title, desc, source: "" });
  }
  return items;
}

async function fetchNews() {
  const all = [];
  for (const feed of NEWS_FEEDS) {
    try { const xml = await get(feed.url, true); const items = parseRSS(xml).slice(0,10); items.forEach(i=>i.source=feed.name); all.push(...items); console.log(`  📰 ${feed.name}: ${items.length}`); }
    catch(e) { console.log(`  ⚠️ ${feed.name}: ${e.message?.slice(0,30)}`); }
  }
  return all;
}

function getAffected(title, desc) {
  const t = (title+" "+desc).toLowerCase();
  return Object.entries(ASSET_KEYWORDS).filter(([,kws])=>kws.some(k=>t.includes(k))).map(([sym])=>sym);
}

// ─── CLAUDE ────────────────────────────────────────────────
async function claudeNews(news, prices, state) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const port = Object.entries(ASSETS).map(([sym,info])=>`${sym}: ${fmtP(prices[sym].price)} | ${state.cycles[sym].phase}`).join("\n");
  const newsStr = news.map((n,i)=>`[${i+1}] ${n.source}: "${n.title}"\n${n.desc}`).join("\n\n");
  const prompt = `Asistente estratégico de Pedro (Bitcopper LLC, Calama). Portafolio:\n${port}\n\nNOTICIAS:\n${newsStr}\n\nEvalúa si alguna noticia impacta realmente ETH/TAO/SOL/BTC del portafolio. Responde SOLO JSON:\n{"hasAlert":true,"urgency":"ALTA"|"MEDIA","headline":"1 línea","affectedAssets":["BTC"],"impact":"alcista"|"bajista"|"neutral","action":"qué hacer Pedro","reason":"por qué (máx 2 líneas)"}\nO si nada es relevante: {"hasAlert":false}`;
  try {
    const r = await post("https://api.anthropic.com/v1/messages",{ model:"claude-sonnet-4-20250514",max_tokens:400,messages:[{role:"user",content:prompt}]},{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"});
    return JSON.parse((r.body?.content?.[0]?.text??"{}").replace(/```json|```/g,"").trim());
  } catch { return null; }
}

async function claudeAnalysis(prices, fg, btcDom, state, ctx) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) return null;
  const tv = Object.entries(ASSETS).reduce((s,[sym,info])=>s+prices[sym].price*info.qty,0);
  const port = Object.entries(ASSETS).map(([sym,info])=>`${sym}:${fmtP(prices[sym].price)} 24h:${prices[sym].change24h?.toFixed(1)}% Fase:${state.cycles[sym].phase} PnL:${((prices[sym].price-info.avgCost)/info.avgCost*100).toFixed(1)}%`).join(" | ");
  const sys = `Asistente estratégico de ${INVESTOR.name} (${INVESTOR.company}). Objetivo:${INVESTOR.goal}. Capital:$${tv.toFixed(0)}. F&G:${fg.value}(${fg.label}) BTCDom:${btcDom}% PnLMes:$${state.monthlyPnl.toFixed(0)}/4000. ${port}. Directo, máx 3 líneas, español.`;
  try {
    const r = await post("https://api.anthropic.com/v1/messages",{model:"claude-sonnet-4-20250514",max_tokens:250,system:sys,messages:[{role:"user",content:ctx}]},{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"});
    return r.body?.content?.[0]?.text??null;
  } catch { return null; }
}

// ─── WHATSAPP ──────────────────────────────────────────────
async function sendWA(lines) {
  const [sid,auth,from,to] = [process.env.TWILIO_ACCOUNT_SID,process.env.TWILIO_AUTH_TOKEN,process.env.TWILIO_WHATSAPP_FROM,process.env.TWILIO_WHATSAPP_TO];
  const time = new Date().toLocaleTimeString("es-CL",{timeZone:"America/Santiago",hour:"2-digit",minute:"2-digit"});
  const text = [...lines,"",`_${time} · Bitcopper Agent v3_`].join("\n");
  if (!sid||!auth||!from||!to) { console.log("\n📱 [SIM]\n"+text); return true; }
  const body = new URLSearchParams({From:from,To:to,Body:text}).toString();
  const r = await post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,body,{"Content-Type":"application/x-www-form-urlencoded","Authorization":`Basic ${Buffer.from(`${sid}:${auth}`).toString("base64")}`});
  return r.status===201;
}

// ─── MAIN ──────────────────────────────────────────────────
async function main() {
  console.log(`🤖 Bitcopper Agent v3 — ${new Date().toLocaleTimeString("es-CL",{timeZone:"America/Santiago"})}`);
  const state = loadState();
  if (!state.newsHashes) state.newsHashes = [];

  const now = new Date();
  if (now.getDay()===1 && (Date.now()-state.lastWeekReset)>6*24*3600000) { state.weeklyPnl=0; state.lastWeekReset=Date.now(); }
  if (now.getDate()===1 && (Date.now()-state.lastMonthReset)>20*24*3600000) { state.monthlyPnl=0; state.lastMonthReset=Date.now(); }

  const [prices,fg,btcDom,rawNews] = await Promise.all([fetchPrices(),fetchFG(),fetchDom(),fetchNews()]);
  let sent = 0;

  // ── PRECIOS ─────────────────────────────────────────────
  console.log("\n📊 Precios:");
  for (const [sym,asset] of Object.entries(ASSETS)) {
    const {price} = prices[sym]; if (!price) continue;
    const cy = state.cycles[sym];
    console.log(`  ${sym}: ${fmtP(price)} | ${cy.phase} | #${cy.cycleCount}`);
    let type = null;
    if (cy.phase===PHASE.HOLDING) {
      if (price<=asset.stop && canAlert(state,`${sym}_STOP`)) type="STOP";
      else if (price>=asset.sellZone.min && canAlert(state,`${sym}_SELL`)) type="SELL";
      else if (((asset.sellZone.min-price)/price*100)<=1.5 && canAlert(state,`${sym}_NEAR_SELL`)) type="NEAR_SELL";
    } else {
      if (price<=asset.buyZone.max&&price>=asset.buyZone.min&&canAlert(state,`${sym}_BUY`)) type="BUY";
      else if (((asset.buyZone.max-price)/price*100)<=1.5&&price>asset.buyZone.max&&canAlert(state,`${sym}_NEAR_BUY`)) type="NEAR_BUY";
    }
    if (type) {
      const an = await claudeAnalysis(prices,fg,btcDom,state,`${sym} activó ${type} a ${fmtP(price)}. ¿Qué hace Pedro?`);
      const tpls = {
        NEAR_SELL:[`⚡ *${sym} — PREPARA VENTA*`,`Precio: ${fmtP(price)} → target ${fmtP(asset.sellZone.min)}`,`Faltan: ${((asset.sellZone.min-price)/price*100).toFixed(1)}%`,`PnL: ${fmtPnl(cy.entryPrice,price,asset.qty)}`,``,`👉 Prepara orden en Binance.`],
        SELL:[`🔴 *VENDER ${sym} AHORA*`,`Precio: ${fmtP(price)} ✓ zona ${fmtP(asset.sellZone.min)}–${fmtP(asset.sellZone.max)}`,`Profit: ${fmtPnl(cy.entryPrice,price,asset.qty)} 💰`,``,`👉 Vender en Binance spot.`,`Próximo ciclo: recomprar ${fmtP(asset.buyZone.min)}–${fmtP(asset.buyZone.max)}`],
        NEAR_BUY:[`⚡ *${sym} — PREPARA COMPRA*`,`Precio: ${fmtP(price)} → zona ${fmtP(asset.buyZone.min)}–${fmtP(asset.buyZone.max)}`,``,`👉 Prepara orden en Binance.`],
        BUY:[`🟢 *COMPRAR ${sym} AHORA*`,`Precio: ${fmtP(price)} ✓ zona ${fmtP(asset.buyZone.min)}–${fmtP(asset.buyZone.max)}`,`Target: ${fmtP(asset.sellZone.min)} | Stop: ${fmtP(asset.stop)}`,``,`👉 Comprar en Binance spot.`],
        STOP:[`🛑 *STOP LOSS — ${sym}*`,`Precio: ${fmtP(price)} ≤ stop ${fmtP(asset.stop)}`,`PnL: ${fmtPnl(cy.entryPrice,price,asset.qty)}`,``,`👉 Salir en Binance.`],
      };
      const lines = [...(tpls[type]||[]),...(an?[``,`🧠 *Análisis:*`,an]:[])];
      const ok = await sendWA(lines);
      if (ok) {
        state.alerts[`${sym}_${type}`]=Date.now(); sent++;
        if (type==="SELL") { const p=(price-cy.entryPrice)*asset.qty; state.weeklyPnl+=p; state.monthlyPnl+=p; state.cycles[sym]={phase:PHASE.WAITING_BUY,cycleCount:cy.cycleCount,profitAccum:cy.profitAccum+p}; }
        else if (type==="BUY") state.cycles[sym]={phase:PHASE.HOLDING,entryPrice:price,cycleCount:cy.cycleCount+1,profitAccum:cy.profitAccum};
        else if (type==="STOP") { const l=(price-cy.entryPrice)*asset.qty; state.weeklyPnl+=l; state.monthlyPnl+=l; state.cycles[sym]={phase:PHASE.WAITING_BUY,cycleCount:cy.cycleCount,profitAccum:cy.profitAccum+l}; }
      }
    }
  }

  // ── NOTICIAS ─────────────────────────────────────────────
  console.log("\n📰 Noticias:");
  const newNews = rawNews.filter(n=>{
    const h=hashStr(n.title);
    if (state.newsHashes.includes(h)) return false;
    return getAffected(n.title,n.desc).length>0;
  });
  console.log(`  Nuevas relevantes: ${newNews.length}`);

  if (newNews.length>0 && canAlert(state,"NEWS_BATCH",NEWS_COOLDOWN_H)) {
    const ev = await claudeNews(newNews.slice(0,8),prices,state);
    if (ev?.hasAlert) {
      const imp = ev.impact==="alcista"?"📈":ev.impact==="bajista"?"📉":"➡️";
      const urg = ev.urgency==="ALTA"?"🔴":"🟡";
      const lines = [
        `${urg} *ALERTA DE MERCADO — ${ev.urgency}*`,`━━━━━━━━━━━━━━━━━━━━`,
        `📰 ${ev.headline}`,``,
        `${imp} Impacto: *${ev.impact.toUpperCase()}* | Activos: *${ev.affectedAssets.join(", ")}*`,``,
        `📊 Precios:`,
        ...ev.affectedAssets.filter(s=>prices[s]).map(s=>`  ${s}: ${fmtP(prices[s].price)} (${prices[s].change24h?.toFixed(1)}%)`),
        ``,`🎯 *Acción:* ${ev.action}`,``,`💡 ${ev.reason}`,
      ];
      const ok = await sendWA(lines);
      if (ok) { state.alerts["NEWS_BATCH"]=Date.now(); sent++; }
    } else { console.log("  ✅ Sin impacto relevante."); }
    // Marcar vistas
    newNews.forEach(n=>{ const h=hashStr(n.title); if(!state.newsHashes.includes(h)) state.newsHashes.push(h); });
    if (state.newsHashes.length>200) state.newsHashes=state.newsHashes.slice(-200);
  }

  // ── INFORME SEMANAL ──────────────────────────────────────
  const isMonday8 = now.getDay()===1&&now.getHours()>=10&&now.getHours()<=12;
  if (isMonday8&&canAlert(state,"WEEKLY_REPORT",120)) {
    const tv=Object.entries(ASSETS).reduce((s,[sym,info])=>s+prices[sym].price*info.qty,0);
    const tc=Object.entries(ASSETS).reduce((s,[,info])=>s+info.avgCost*info.qty,0);
    const lines=[
      `📊 *INFORME SEMANAL — BITCOPPER*`,`━━━━━━━━━━━━━━━━━━━━`,
      `F&G: ${fg.value} (${fg.label}) | BTC Dom: ${btcDom}%`,``,
      `💼 Total: $${tv.toFixed(0)} | PnL: ${(tv-tc)>=0?"+":""}$${(tv-tc).toFixed(0)}`,
      `Avance mes: $${state.monthlyPnl.toFixed(0)} / $4,000 (${Math.min(100,(state.monthlyPnl/4000*100)).toFixed(0)}%)`,``,`📌 *ACTIVOS*`,
      ...Object.entries(ASSETS).map(([sym,info])=>{
        const p=prices[sym]; const cy=state.cycles[sym]; const pu=(p.price-info.avgCost)*info.qty;
        const sig=p.price>=info.sellZone.min?"🔴 VENDER":p.price<=info.buyZone.max?"🟢 COMPRAR":"🟡 HOLD";
        return `${sym}: ${fmtP(p.price)} | ${sig} | #${cy.cycleCount} | ${pu>=0?"+":""}$${pu.toFixed(0)}`;
      }),
    ];
    const an=await claudeAnalysis(prices,fg,btcDom,state,"Informe semanal. 3 acciones prioritarias para Pedro esta semana.");
    if (an) lines.push(``,`━━━━━━━━━━━━━━━━━━━━`,`🧠 *Análisis semanal:*`,``,an);
    const ok=await sendWA(lines);
    if (ok) { state.alerts["WEEKLY_REPORT"]=Date.now(); sent++; }
  }

  console.log(sent===0?"\n✅ Sin alertas — todo en zona neutral.":`\n📱 ${sent} alerta(s) enviada(s).`);
  saveState(state);
}

main().catch(err=>{ console.error("❌",err.message); process.exit(1); });
