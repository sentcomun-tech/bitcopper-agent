// ============================================================
// Bitcopper Strategic Agent v4.1 — MODO MAX SENSIBILIDAD
// Motor: F&G + Precio + Noticias → Claude decide
// Activos: BTC · ETH · SOL · TAO · XAU
// Swing target: 4–8% por operación (máxima frecuencia)
// Salida: WhatsApp vía Twilio
// Autor: Bitcopper Technologies LLC — Calama, Chile
// ============================================================

const https = require("https");
const fs    = require("fs");

// ─── INVERSOR ───────────────────────────────────────────────
const INVESTOR = {
  name:    "Pedro",
  goal:    "$4,000 USD adicionales por mes",
  capital: 15000,
  style:   "Swing spot MAX SENSIBILIDAD — captura oscilaciones 4–8%. Salidas manuales.",
  risk:    "Moderado-agresivo. Máxima frecuencia de señales. Sin stop automático.",
  company: "Bitcopper Technologies LLC — Calama, Chile",
};

// ─── PERFIL DE SWING — MÁXIMA SENSIBILIDAD ──────────────────
// swingPct reducido → detecta movimientos más pequeños y frecuentes
// activationPct: umbral para activar Claude (% del swingPct)
// cooldownH: mínimo entre alertas del mismo activo
// stopMult: stop = swingPct × stopMult desde entrada
//
// Lógica de ganancia por ciclo:
//   BTC  4% de $4,500 = ~$180 × varios ciclos/mes
//   ETH  5% de $3,500 = ~$175 × varios ciclos/mes
//   SOL  6% de $2,500 = ~$150 × varios ciclos/mes
//   TAO  7% de $2,000 = ~$140 × varios ciclos/mes
//   XAU  4% de $2,500 = ~$100 × varios ciclos/mes
//   TOTAL potencial ~$4,000+ si 3–5 ciclos/activo/mes

const ASSETS = {
  BTC: {
    cgId:          "bitcoin",
    apiType:       "coingecko",
    capital:       4500,
    swingPct:      0.04,   // 4% swing target
    activationPct: 0.025,  // activa Claude cuando mueve ≥2.5%
    timeframe:     "horas–1 día",
    cooldownH:     0.5,    // 30 min entre alertas
    stopMult:      1.8,    // stop en -7.2% desde entrada
  },
  ETH: {
    cgId:          "ethereum",
    apiType:       "coingecko",
    capital:       3500,
    swingPct:      0.05,
    activationPct: 0.03,
    timeframe:     "horas–1 día",
    cooldownH:     0.5,
    stopMult:      1.8,
  },
  SOL: {
    cgId:          "solana",
    apiType:       "coingecko",
    capital:       2500,
    swingPct:      0.06,
    activationPct: 0.035,
    timeframe:     "1–2 días",
    cooldownH:     0.75,
    stopMult:      1.7,
  },
  TAO: {
    cgId:          "bittensor",
    apiType:       "coingecko",
    capital:       2000,
    swingPct:      0.07,
    activationPct: 0.04,
    timeframe:     "1–2 días",
    cooldownH:     0.75,
    stopMult:      1.7,
  },
  XAU: {
    cgId:          null,
    apiType:       "metals",
    capital:       2500,
    swingPct:      0.04,
    activationPct: 0.02,
    timeframe:     "1–3 días",
    cooldownH:     1,
    stopMult:      1.6,
  },
};

// ─── KEYWORDS DE NOTICIAS ────────────────────────────────────
// Ampliados para máxima cobertura de eventos que mueven precio
const ASSET_KEYWORDS = {
  BTC: ["bitcoin","btc","trump","iran","fed","federal reserve","etf","blackrock",
        "macro","inflation","war","geopolit","oil","reserva federal","halving",
        "tariff","arancel","crypto","criptomoneda","sec","regulation","whale",
        "mining","hashrate","lightning","satoshi","microstrategy","coinbase"],
  ETH: ["ethereum","eth","vitalik","pectra","layer2","l2","rollup","staking",
        "defi","dencun","eth etf","gas fee","eip","polygon","arbitrum","optimism",
        "uniswap","lido","restaking"],
  SOL: ["solana","sol","anatoly","firedancer","alpenglow","solana etf","saga",
        "jito","drift","jupiter","mev","pump.fun","memecoin solana"],
  TAO: ["bittensor","tao","ai","artificial intelligence","inteligencia artificial",
        "opentensor","subnet","agi","openai","deepmind","grok","llm","gemini",
        "nvidia","gpu","machine learning","chatgpt","anthropic","depin"],
  XAU: ["gold","oro","xauusd","xau","powell","fed rate","interest rate",
        "tasa de interés","inflation","inflación","iran","guerra","war",
        "dollar","dólar","nfp","treasury","geopolit","refugio","safe haven",
        "central bank","banco central","brics","petrodollar","yield"],
};

// ─── FEEDS DE NOTICIAS ───────────────────────────────────────
const NEWS_FEEDS = [
  { name: "CoinDesk",      url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "CoinTelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt",       url: "https://decrypt.co/feed" },
  { name: "TheBlock",      url: "https://www.theblock.co/rss.xml" },
];

// ─── COOLDOWNS Y CONFIGURACIÓN ───────────────────────────────
const STATE_FILE   = "/tmp/bitcopper_v41_state.json";
const NEWS_CD_H    = 2;    // noticias: 2h entre alertas
const HEARTBEAT_CD = 20;   // heartbeat diario

// ─── HELPERS ─────────────────────────────────────────────────
function get(url, raw = false) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      https.get({
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { "User-Agent": "BitcopperAgent/4.1" }
      }, res => {
        if (res.statusCode === 301 || res.statusCode === 302)
          return get(res.headers.location, raw).then(resolve).catch(reject);
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          if (raw) return resolve(d);
          try { resolve(JSON.parse(d)); } catch { resolve(d); }
        });
      }).on("error", reject);
    } catch(e) { reject(e); }
  });
}

function post(url, payload, headers) {
  return new Promise((resolve, reject) => {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: { "Content-Length": Buffer.byteLength(body), ...headers }
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!s.tradeLog)      s.tradeLog      = [];
    if (!s.weeklyTrades)  s.weeklyTrades  = [];
    if (!s.learningNotes) s.learningNotes = [];
    return s;
  }
  catch {
    const s = {
      alerts:         {},
      positions:      {},
      newsHashes:     [],
      weeklyPnl:      0,
      monthlyPnl:     0,
      totalCycles:    0,
      tradeLog:       [],
      weeklyTrades:   [],
      learningNotes:  [],
      lastWeekReset:  Date.now(),
      lastMonthReset: Date.now(),
    };
    for (const sym of Object.keys(ASSETS)) {
      s.positions[sym] = {
        phase:       "WAITING_BUY",
        entryPrice:  0,
        lastPrice:   0,
        cycleCount:  0,
        profitAccum: 0,
      };
    }
    return s;
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function canAlert(state, key, hours) {
  const last = state.alerts[key];
  return !last || (Date.now() - last) / 3600000 >= hours;
}

function fmtP(p) {
  if (!p || p === 0) return "$0";
  return p >= 1000
    ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : `$${p.toFixed(2)}`;
}

function pctChange(from, to) {
  if (!from || from === 0) return 0;
  return ((to - from) / from) * 100;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return h.toString(36);
}

// ─── FETCH PRECIOS ───────────────────────────────────────────
async function fetchCryptoPrices() {
  const cgAssets = Object.entries(ASSETS).filter(([, a]) => a.apiType === "coingecko");
  const ids = cgAssets.map(([, a]) => a.cgId).join(",");
  const d = await get(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_7d_change=true`
  );
  const r = {};
  for (const [sym, info] of cgAssets) {
    r[sym] = {
      price:     d[info.cgId]?.usd ?? 0,
      change24h: d[info.cgId]?.usd_24h_change ?? 0,
      change7d:  d[info.cgId]?.usd_7d_change ?? 0,
    };
  }
  return r;
}

async function fetchGoldPrice() {
  try {
    const d = await get("https://api.metals.live/v1/spot/gold");
    const price = Array.isArray(d) ? d[0]?.price : d?.price;
    if (price) return { price, change24h: 0, change7d: 0 };
  } catch {}
  try {
    const d = await get("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD");
    const price = d?.[0]?.spreadProfilePrices?.[0]?.ask;
    if (price) return { price, change24h: 0, change7d: 0 };
  } catch {}
  return { price: 0, change24h: 0, change7d: 0 };
}

async function fetchAllPrices() {
  const [crypto, gold] = await Promise.all([fetchCryptoPrices(), fetchGoldPrice()]);
  return { ...crypto, XAU: gold };
}

async function fetchFG() {
  try {
    const d = await get("https://api.alternative.me/fng/?limit=1");
    return { value: +d.data[0].value, label: d.data[0].value_classification };
  } catch { return { value: 50, label: "Neutral" }; }
}

async function fetchBtcDom() {
  try {
    const d = await get("https://api.coingecko.com/api/v3/global");
    return +(d.data?.market_cap_percentage?.btc?.toFixed(1) ?? 50);
  } catch { return 50; }
}

// ─── NOTICIAS ────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const it = m[1];
    const title = (
      it.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
      it.match(/<title>(.*?)<\/title>/)
    )?.[1]?.trim() ?? "";
    const desc = (
      it.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
      it.match(/<description>(.*?)<\/description>/)
    )?.[1]?.replace(/<[^>]+>/g, "")?.trim()?.slice(0, 300) ?? "";
    if (title) items.push({ title, desc, source: "" });
  }
  return items;
}

async function fetchNews() {
  const all = [];
  for (const feed of NEWS_FEEDS) {
    try {
      const xml = await get(feed.url, true);
      const items = parseRSS(xml).slice(0, 15);
      items.forEach(i => i.source = feed.name);
      all.push(...items);
    } catch(e) {
      console.log(`  ⚠️ ${feed.name}: ${e.message?.slice(0, 40)}`);
    }
  }
  return all;
}

function getAffectedAssets(title, desc) {
  const t = (title + " " + desc).toLowerCase();
  return Object.entries(ASSET_KEYWORDS)
    .filter(([, kws]) => kws.some(k => t.includes(k)))
    .map(([sym]) => sym);
}

// ─── MOTOR DE DECISIÓN CLAUDE — MAX SENSIBILIDAD ─────────────
async function claudeDecide(sym, price, pos, fg, btcDom, news, asset) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const changePctFromLast  = pos.lastPrice  ? pctChange(pos.lastPrice, price)  : 0;
  const changePctFromEntry = pos.entryPrice ? pctChange(pos.entryPrice, price) : 0;

  const newsStr = news.length > 0
    ? news.slice(0, 5).map((n, i) => `[${i+1}] ${n.source}: "${n.title}"\n${n.desc}`).join("\n\n")
    : "Sin noticias relevantes recientes.";

  const fgSignal = fg.value < 20 ? "PÁNICO EXTREMO → señal COMPRA muy fuerte"
    : fg.value < 35 ? "MIEDO → sesgo compra"
    : fg.value > 80 ? "EUFORIA → señal VENTA muy fuerte"
    : fg.value > 65 ? "CODICIA → sesgo venta"
    : "NEUTRAL";

  // Calcular zonas dinámicas desde precio actual
  const buyTarget  = price * (1 - asset.swingPct);
  const sellTarget = price * (1 + asset.swingPct);
  const stopPrice  = pos.entryPrice ? pos.entryPrice * (1 - asset.swingPct * asset.stopMult) : 0;

  const prompt = `Eres el motor de decisión de Bitcopper v4.1 MAX SENSIBILIDAD para Pedro.
Objetivo: $4,000/mes capturando oscilaciones frecuentes de ${asset.swingPct * 100}%+.
Capital total: $15,000. Capital en ${sym}: $${asset.capital}.

ACTIVO: ${sym}
Precio actual: ${fmtP(price)}
Precio anterior (última ejecución 15 min atrás): ${fmtP(pos.lastPrice)}
Cambio en últimos 15 min: ${changePctFromLast.toFixed(3)}%
Fase: ${pos.phase}
${pos.phase === "HOLDING"
  ? `Entrada: ${fmtP(pos.entryPrice)} | Cambio desde entrada: ${changePctFromEntry.toFixed(2)}% | Stop mental: ${fmtP(stopPrice)}`
  : `Sin posición — zona de compra ideal: ${fmtP(buyTarget)}`}

MERCADO:
F&G: ${fg.value}/100 (${fg.label}) → ${fgSignal}
BTC Dominancia: ${btcDom}%

NOTICIAS RECIENTES (${sym}):
${newsStr}

REGLAS MAX SENSIBILIDAD:
- COMPRAR: fase=WAITING_BUY + precio bajó ≥${asset.swingPct * 100}% + F&G < 70 + noticias no son catastróficas
- VENDER: fase=HOLDING + precio subió ≥${asset.swingPct * 100}% desde entrada + F&G no < 20
- PREPARAR_COMPRA: precio cayendo fuerte hacia zona compra, aún no llegó pero viene en camino (alerta anticipada)
- PREPARAR_VENTA: precio acercándose al target de venta, aún no llegó (alerta anticipada)
- STOP_DEFENSIVO: fase=HOLDING + precio cayó ≥${(asset.swingPct * asset.stopMult * 100).toFixed(1)}% desde entrada
- ESPERAR: ninguna condición clara

IMPORTANTE: Sé sensible. Prefiere PREPARAR_COMPRA o PREPARAR_VENTA sobre ESPERAR cuando el movimiento es claro.
Si el precio ya bajó ${(asset.swingPct * 0.6 * 100).toFixed(1)}%+ y sigue bajando, activa PREPARAR_COMPRA.
Si el precio ya subió ${(asset.swingPct * 0.6 * 100).toFixed(1)}%+ desde entrada y sigue subiendo, activa PREPARAR_VENTA.

Responde ÚNICAMENTE con este JSON (sin texto adicional, sin markdown):
{
  "decision": "COMPRAR" | "VENDER" | "PREPARAR_COMPRA" | "PREPARAR_VENTA" | "STOP_DEFENSIVO" | "ESPERAR",
  "confianza": "ALTA" | "MEDIA" | "BAJA",
  "razon": "máximo 2 líneas",
  "precioObjetivo": 0,
  "gananciaEstimada": 0,
  "urgencia": "INMEDIATA" | "PROXIMA_HORA" | "HOY"
}`;

  try {
    const r = await post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 250,
        messages: [{ role: "user", content: prompt }]
      },
      {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      }
    );
    const raw = r.body?.content?.[0]?.text ?? "{}";
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch(e) {
    console.log(`  ⚠️ Claude error (${sym}): ${e.message?.slice(0, 50)}`);
    return null;
  }
}

// ─── CLAUDE NOTICIAS ─────────────────────────────────────────
async function claudeNewsAlert(news, prices, state) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const portfolio = Object.entries(ASSETS)
    .map(([sym, a]) => `${sym}: ${fmtP(prices[sym]?.price)} | $${a.capital} | ${state.positions[sym]?.phase}`)
    .join("\n");

  const newsStr = news.slice(0, 8)
    .map((n, i) => `[${i+1}] ${n.source}: "${n.title}"\n${n.desc}`)
    .join("\n\n");

  const prompt = `Asistente de Pedro (Bitcopper LLC). Modo MAX SENSIBILIDAD — señala todo lo que pueda mover precio ≥3%.
Portafolio:\n${portfolio}\n\nNOTICIAS:\n${newsStr}\n\nEvalúa impacto en BTC/ETH/SOL/TAO/XAU. Responde SOLO JSON:\n{"hasAlert":true,"urgency":"ALTA"|"MEDIA","headline":"1 línea","affectedAssets":["BTC"],"impact":"alcista"|"bajista"|"neutral","action":"qué hace Pedro ahora","reason":"por qué (máx 2 líneas)"}\nO si nada mueve ≥3%: {"hasAlert":false}`;

  try {
    const r = await post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 350,
        messages: [{ role: "user", content: prompt }]
      },
      {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      }
    );
    const raw = r.body?.content?.[0]?.text ?? "{}";
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch { return null; }
}

// ─── WHATSAPP ─────────────────────────────────────────────────
async function sendWA(lines) {
  const sid  = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const to   = process.env.TWILIO_WHATSAPP_TO;

  const time = new Date().toLocaleTimeString("es-CL", {
    timeZone: "America/Santiago",
    hour: "2-digit",
    minute: "2-digit"
  });

  const text = [...lines, "", `_${time} · Bitcopper v4.1 MAX_`].join("\n");

  if (!sid || !auth || !from || !to) {
    console.log("\n📱 [SIMULADO]\n" + text);
    return true;
  }

  const body = new URLSearchParams({ From: from, To: to, Body: text }).toString();
  const r = await post(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    body,
    {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${Buffer.from(`${sid}:${auth}`).toString("base64")}`
    }
  );
  return r.status === 201;
}

// ─── CONSTRUIR MENSAJE ────────────────────────────────────────
function buildMessage(sym, result, price, asset, pos) {
  const { decision, confianza, razon, precioObjetivo, gananciaEstimada, urgencia } = result;

  const icons = {
    COMPRAR:        "🟢",
    VENDER:         "🔴",
    PREPARAR_COMPRA:"⚡",
    PREPARAR_VENTA: "⚡",
    STOP_DEFENSIVO: "🛑",
  };

  const urgStr = urgencia === "INMEDIATA" ? "⏰ INMEDIATA"
    : urgencia === "PROXIMA_HORA" ? "🕐 Próxima hora"
    : "📅 Hoy";

  const lines = [
    `${icons[decision] ?? "🔵"} *${decision.replace("_", " ")} — ${sym}*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `💰 Precio: ${fmtP(price)} | Urgencia: ${urgStr}`,
    `🎯 Confianza: ${confianza}`,
  ];

  if (decision === "COMPRAR") {
    const qty = (asset.capital / price).toFixed(6);
    const target = price * (1 + asset.swingPct);
    const stop   = price * (1 - asset.swingPct * asset.stopMult);
    lines.push(`📦 Qty aprox: ${qty} ${sym}`);
    lines.push(`🎯 Target: ${fmtP(target)} (+${(asset.swingPct * 100).toFixed(0)}%)`);
    lines.push(`🛡️ Stop mental: ${fmtP(stop)}`);
    lines.push(`💵 Capital: $${asset.capital}`);
    lines.push(`💡 Ganancia est: ~$${(asset.capital * asset.swingPct).toFixed(0)}`);
  }

  if (decision === "VENDER" && pos.entryPrice) {
    const pnl = (price - pos.entryPrice) * (asset.capital / pos.entryPrice);
    const pct  = pctChange(pos.entryPrice, price);
    lines.push(`📈 Entrada: ${fmtP(pos.entryPrice)} → Ahora: ${fmtP(price)}`);
    lines.push(`💵 PnL: +$${pnl.toFixed(0)} (+${pct.toFixed(1)}%) 💰`);
    lines.push(`👉 Vender en Binance spot.`);
  }

  if (decision === "PREPARAR_COMPRA") {
    const target = price * (1 - asset.swingPct * 0.4);
    lines.push(`📉 Precio se acerca a zona compra`);
    lines.push(`🎯 Zona ideal: ${fmtP(target)}`);
    lines.push(`👉 Prepara la orden en Binance.`);
  }

  if (decision === "PREPARAR_VENTA") {
    const target = pos.entryPrice ? pos.entryPrice * (1 + asset.swingPct) : price * (1 + asset.swingPct * 0.4);
    lines.push(`📈 Precio se acerca a target de venta`);
    lines.push(`🎯 Target: ${fmtP(target)}`);
    lines.push(`👉 Prepara orden de venta en Binance.`);
  }

  if (decision === "STOP_DEFENSIVO" && pos.entryPrice) {
    const loss = (price - pos.entryPrice) * (asset.capital / pos.entryPrice);
    const pct  = pctChange(pos.entryPrice, price);
    lines.push(`⚠️ Entrada: ${fmtP(pos.entryPrice)}`);
    lines.push(`📉 Pérdida si salís: $${Math.abs(loss).toFixed(0)} (${pct.toFixed(1)}%)`);
    lines.push(`👉 Evalúa salir para proteger capital.`);
  }

  lines.push(``, `🧠 ${razon}`);
  return lines;
}

// ─── MAIN ─────────────────────────────────────────────────────
async function main() {
  console.log(`\n🤖 Bitcopper v4.1 MAX — ${new Date().toLocaleString("es-CL", { timeZone: "America/Santiago" })}`);
  console.log("━".repeat(50));

  const state = loadState();
  const now   = new Date();

  // Resets
  if (now.getDay() === 1 && (Date.now() - state.lastWeekReset) > 6 * 24 * 3600000) {
    state.weeklyPnl = 0; state.lastWeekReset = Date.now();
  }
  if (now.getDate() === 1 && (Date.now() - state.lastMonthReset) > 20 * 24 * 3600000) {
    state.monthlyPnl = 0; state.lastMonthReset = Date.now();
  }

  // Fetch todo en paralelo
  const [prices, fg, btcDom, rawNews] = await Promise.all([
    fetchAllPrices(), fetchFG(), fetchBtcDom(), fetchNews()
  ]);

  console.log(`\nF&G: ${fg.value} (${fg.label}) | BTC Dom: ${btcDom}%`);

  // Noticias nuevas relevantes
  const newNews = rawNews.filter(n => !state.newsHashes.includes(hashStr(n.title)));

  let sent = 0;

  // ── DECISIÓN POR ACTIVO ──────────────────────────────────
  for (const [sym, asset] of Object.entries(ASSETS)) {
    const priceData = prices[sym];
    if (!priceData?.price) continue;

    const price = priceData.price;
    const pos   = state.positions[sym];

    const changePctFromLast  = pos.lastPrice  ? Math.abs(pctChange(pos.lastPrice, price)) : 0;
    const changePctFromEntry = pos.entryPrice ? pctChange(pos.entryPrice, price) : 0;

    console.log(`  ${sym}: ${fmtP(price)} | ${pos.phase} | Δlast=${changePctFromLast.toFixed(2)}% | Δentry=${changePctFromEntry.toFixed(2)}%`);

    const relevantNews = newNews.filter(n => getAffectedAssets(n.title, n.desc).includes(sym));

    // Activar si:
    // 1. Movimiento ≥ activationPct desde último precio
    // 2. O noticias nuevas relevantes
    // 3. O en HOLDING y cayó peligrosamente desde entrada (stop check)
    const hasMovement = changePctFromLast >= asset.activationPct * 100;
    const hasNews     = relevantNews.length > 0;
    const isStopZone  = pos.phase === "HOLDING" && pos.entryPrice
      && changePctFromEntry <= -(asset.swingPct * asset.stopMult * 100);
    const cooldownOk  = canAlert(state, `${sym}_DECIDE`, asset.cooldownH);

    if ((hasMovement || hasNews || isStopZone) && cooldownOk) {
      const result = await claudeDecide(sym, price, pos, fg, btcDom, relevantNews, asset);

      if (result && result.decision !== "ESPERAR") {
        const lines = buildMessage(sym, result, price, asset, pos);
        const ok = await sendWA(lines);

        if (ok) {
          state.alerts[`${sym}_DECIDE`] = Date.now();
          sent++;

          // Actualizar estado
          if (result.decision === "COMPRAR") {
            state.positions[sym] = {
              ...pos,
              phase:        "HOLDING",
              entryPrice:   price,
              entryTs:      Date.now(),
              razonEntrada: result.razon,
              lastPrice:    price,
              cycleCount:   pos.cycleCount + 1,
            };
            state.totalCycles++;
          } else if (result.decision === "VENDER" && pos.entryPrice) {
            const pnl    = (price - pos.entryPrice) * (asset.capital / pos.entryPrice);
            const pnlPct = ((price - pos.entryPrice) / pos.entryPrice * 100);
            state.weeklyPnl  += pnl;
            state.monthlyPnl += pnl;
            const trade = {
              sym, tipo: "VENTA",
              entryPrice: pos.entryPrice, exitPrice: price,
              pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
              capital: asset.capital,
              fechaEntrada: pos.entryTs ? new Date(pos.entryTs).toISOString() : "?",
              fechaSalida:  new Date().toISOString(),
              duracionH: pos.entryTs ? +((Date.now()-pos.entryTs)/3600000).toFixed(1) : 0,
              resultado: pnl >= 0 ? "GANANCIA" : "PERDIDA",
              razonEntrada: pos.razonEntrada || "?",
              razonSalida: result.razon, fg: fg.value,
            };
            state.tradeLog.push(trade);
            state.weeklyTrades.push(trade);
            if (state.tradeLog.length > 300) state.tradeLog = state.tradeLog.slice(-300);
            state.positions[sym] = {
              ...pos,
              phase: "WAITING_BUY", entryPrice: 0, entryTs: 0,
              razonEntrada: "", lastPrice: price,
              profitAccum: pos.profitAccum + pnl,
            };
          } else if (result.decision === "STOP_DEFENSIVO" && pos.entryPrice) {
            const loss    = (price - pos.entryPrice) * (asset.capital / pos.entryPrice);
            const lossPct = ((price - pos.entryPrice) / pos.entryPrice * 100);
            state.weeklyPnl  += loss;
            state.monthlyPnl += loss;
            const stopTrade = {
              sym, tipo: "STOP_DEFENSIVO",
              entryPrice: pos.entryPrice, exitPrice: price,
              pnl: +loss.toFixed(2), pnlPct: +lossPct.toFixed(2),
              capital: asset.capital,
              fechaEntrada: pos.entryTs ? new Date(pos.entryTs).toISOString() : "?",
              fechaSalida:  new Date().toISOString(),
              duracionH: pos.entryTs ? +((Date.now()-pos.entryTs)/3600000).toFixed(1) : 0,
              resultado: "PERDIDA",
              razonEntrada: pos.razonEntrada || "?",
              razonSalida: result.razon, fg: fg.value,
            };
            state.tradeLog.push(stopTrade);
            state.weeklyTrades.push(stopTrade);
            if (state.tradeLog.length > 300) state.tradeLog = state.tradeLog.slice(-300);
            state.positions[sym] = {
              ...pos,
              phase: "WAITING_BUY", entryPrice: 0, entryTs: 0,
              razonEntrada: "", lastPrice: price,
              profitAccum: pos.profitAccum + loss,
            };
          } else {
            // PREPARAR_COMPRA / PREPARAR_VENTA → solo actualiza lastPrice
            state.positions[sym].lastPrice = price;
          }
        }
      } else {
        state.positions[sym].lastPrice = price;
      }
    } else {
      state.positions[sym].lastPrice = price;
    }
  }

  // ── ALERTAS DE NOTICIAS ───────────────────────────────────
  const relevantNew = newNews.filter(n => getAffectedAssets(n.title, n.desc).length > 0);

  if (relevantNew.length > 0 && canAlert(state, "NEWS_BATCH", NEWS_CD_H)) {
    const ev = await claudeNewsAlert(relevantNew, prices, state);
    if (ev?.hasAlert) {
      const imp = ev.impact === "alcista" ? "📈" : ev.impact === "bajista" ? "📉" : "➡️";
      const urg = ev.urgency === "ALTA" ? "🔴" : "🟡";
      const lines = [
        `${urg} *ALERTA MERCADO — ${ev.urgency}*`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `📰 ${ev.headline}`,
        ``,
        `${imp} *${ev.impact.toUpperCase()}* | Activos: *${ev.affectedAssets.join(", ")}*`,
        ``,
        `📊 Precios:`,
        ...ev.affectedAssets.filter(s => prices[s]?.price)
          .map(s => `  ${s}: ${fmtP(prices[s].price)} (${prices[s].change24h?.toFixed(1) ?? "?"}%)`),
        ``,
        `🎯 *Acción:* ${ev.action}`,
        `💡 ${ev.reason}`,
      ];
      const ok = await sendWA(lines);
      if (ok) { state.alerts["NEWS_BATCH"] = Date.now(); sent++; }
    }

    // Marcar como vistas
    relevantNew.forEach(n => {
      const h = hashStr(n.title);
      if (!state.newsHashes.includes(h)) state.newsHashes.push(h);
    });
    if (state.newsHashes.length > 400) state.newsHashes = state.newsHashes.slice(-400);
  }

  // ── HEARTBEAT 7AM ─────────────────────────────────────────
  const hour = parseInt(new Date().toLocaleString("es-CL", {
    timeZone: "America/Santiago", hour: "numeric", hour12: false
  }));

  if (hour === 7 && canAlert(state, "HEARTBEAT_DAILY", HEARTBEAT_CD)) {
    const progreso = Math.min(100, (state.monthlyPnl / 4000 * 100)).toFixed(0);
    const barLen   = Math.floor(progreso / 10);
    const bar      = "█".repeat(barLen) + "░".repeat(10 - barLen);

    const lines = [
      `🤖 *Bitcopper v4.1 MAX — Activo*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `😱 F&G: ${fg.value} (${fg.label}) | BTC Dom: ${btcDom}%`,
      ``,
      `📊 *Precios:*`,
      ...Object.entries(ASSETS).map(([sym]) =>
        prices[sym]?.price
          ? `  ${sym}: ${fmtP(prices[sym].price)} (${prices[sym].change24h?.toFixed(1) ?? "?"}%)`
          : `  ${sym}: sin precio`
      ),
      ``,
      `💼 *Posiciones:*`,
      ...Object.entries(state.positions).map(([sym, pos]) =>
        pos.phase === "HOLDING"
          ? `  🟢 ${sym}: HOLDING desde ${fmtP(pos.entryPrice)} | Ciclos: ${pos.cycleCount}`
          : `  ⚪ ${sym}: esperando entrada | Ciclos: ${pos.cycleCount}`
      ),
      ``,
      `🎯 Meta mes: ${bar} ${progreso}%`,
      `💵 PnL mes: $${state.monthlyPnl.toFixed(0)} / $4,000`,
      `🔄 Ciclos totales: ${state.totalCycles}`,
      ``,
      `✅ Monitoreando cada 15min. Buen día Pedro! 🚀`,
    ];

    const ok = await sendWA(lines);
    if (ok) { state.alerts["HEARTBEAT_DAILY"] = Date.now(); sent++; }
  }

  // ── INFORME SEMANAL CON P&L + APRENDIZAJE ────────────────
  if (now.getDay() === 1 && hour >= 10 && hour <= 12 && canAlert(state, "WEEKLY_REPORT", 120)) {
    const wt        = state.weeklyTrades || [];
    const ganancias = wt.filter(t => t.pnl > 0);
    const perdidas  = wt.filter(t => t.pnl <= 0);
    const totalPnl  = wt.reduce((s, t) => s + t.pnl, 0);
    const winRate   = wt.length > 0 ? (ganancias.length / wt.length * 100).toFixed(0) : 0;
    const avgGan    = ganancias.length > 0 ? ganancias.reduce((s,t)=>s+t.pnl,0)/ganancias.length : 0;
    const avgPer    = perdidas.length  > 0 ? perdidas.reduce((s,t)=>s+t.pnl,0)/perdidas.length   : 0;
    const wtSorted  = [...wt].sort((a,b) => b.pnl - a.pnl);
    const bestTrade = wtSorted[0];
    const worstTrade= wtSorted[wtSorted.length - 1];
    const metaSem   = Math.min(100, (state.weeklyPnl / 1000 * 100)).toFixed(0);
    const barLen    = Math.floor(Number(metaSem) / 10);
    const bar       = "█".repeat(barLen) + "░".repeat(10 - barLen);

    // Llamar a Claude para análisis de aprendizaje
    let aprendizaje = null;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && wt.length > 0) {
      try {
        const tradeResumen = wt.map(t =>
          `${t.sym}|${t.tipo}|E:${t.entryPrice}→S:${t.exitPrice}|PnL:${t.pnl>0?"+":""}$${t.pnl}(${t.pnlPct}%)|${t.duracionH}h|F&G:${t.fg}|${t.resultado}|EntradaPor:"${t.razonEntrada}"|SalidaPor:"${t.razonSalida}"`
        ).join("\n");

        const prompt = `Eres el analista de rendimiento de Bitcopper para Pedro (Calama, Chile).
Meta semanal: $1,000 USDT. Capital: $15,000. Activos: BTC/ETH/SOL/TAO/XAU.
Resultado semana: $${totalPnl.toFixed(0)} | ${wt.length} trades | Win rate: ${winRate}% | F&G actual: ${fg.value}

TRADES CERRADOS ESTA SEMANA:
${tradeResumen}

HISTORIAL ACUMULADO POR ACTIVO:
${Object.entries(state.positions).map(([s,p])=>`${s}: PnL total $${p.profitAccum.toFixed(0)} | ${p.cycleCount} ciclos`).join(" | ")}

NOTAS DE APRENDIZAJE ANTERIORES:
${state.learningNotes.slice(-4).join("\n") || "Primera semana de operación."}

Analiza el rendimiento y responde ÚNICAMENTE con este JSON (sin markdown):
{
  "resumen": "1 línea resultado semana",
  "loQueFunciono": "qué activos/momentos/condiciones generaron las ganancias",
  "loQueNoFunciono": "por qué se perdió en los trades negativos, qué falló",
  "patronesDetectados": "patrones en entradas ganadoras vs perdedoras (F&G, hora, activo, duración)",
  "ajustesRecomendados": "3 ajustes concretos y específicos para la próxima semana",
  "activosPrioridad": ["BTC","ETH"],
  "alertaRiesgo": "riesgo sistémico detectado o null",
  "proyeccionProxSemana": "expectativa de PnL y condiciones favorables próxima semana"
}`;

        const r = await post(
          "https://api.anthropic.com/v1/messages",
          { model: "claude-sonnet-4-20250514", max_tokens: 700,
            messages: [{ role: "user", content: prompt }] },
          { "Content-Type": "application/json", "x-api-key": apiKey,
            "anthropic-version": "2023-06-01" }
        );
        const raw = r.body?.content?.[0]?.text ?? "{}";
        aprendizaje = JSON.parse(raw.replace(/```json|```/g,"").trim());
        if (aprendizaje?.ajustesRecomendados) {
          state.learningNotes.push(
            `Semana ${new Date().toLocaleDateString("es-CL")}: ${aprendizaje.ajustesRecomendados}`
          );
          if (state.learningNotes.length > 16) state.learningNotes = state.learningNotes.slice(-16);
        }
      } catch(e) { console.log("  ⚠️ Aprendizaje error:", e.message?.slice(0,50)); }
    }

    // ── CONSTRUIR MENSAJE ──────────────────────────────────
    const lines = [
      `📊 *INFORME SEMANAL — BITCOPPER v4.1*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `🎯 Meta $1,000: ${bar} ${metaSem}%`,
      `💵 PnL semana: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(0)} / $1,000`,
      `📅 PnL mes:    $${state.monthlyPnl.toFixed(0)} / $4,000`,
      `😱 F&G: ${fg.value} (${fg.label}) | BTC Dom: ${btcDom}%`,
      ``,
      `📈 *Trades de la semana: ${wt.length}*`,
      `  ✅ Ganancias: ${ganancias.length} | Promedio: +$${avgGan.toFixed(0)}`,
      `  ❌ Pérdidas:  ${perdidas.length} | Promedio: -$${Math.abs(avgPer).toFixed(0)}`,
      `  🎯 Win rate:  ${winRate}%`,
    ];

    if (bestTrade)
      lines.push(`  🏆 Mejor trade:  ${bestTrade.sym} +$${bestTrade.pnl.toFixed(0)} (${bestTrade.pnlPct}%) en ${bestTrade.duracionH}h`);
    if (worstTrade && worstTrade.pnl < 0)
      lines.push(`  💔 Peor trade:   ${worstTrade.sym} $${worstTrade.pnl.toFixed(0)} (${worstTrade.pnlPct}%) en ${worstTrade.duracionH}h`);

    lines.push(``, `📋 *Detalle trades:*`);
    for (const t of wt.slice(0, 10)) {
      const icon = t.pnl > 0 ? "✅" : "❌";
      const pnlStr = `${t.pnl > 0 ? "+" : ""}$${t.pnl.toFixed(0)}`;
      lines.push(`  ${icon} ${t.sym} ${t.tipo}: ${pnlStr} (${t.pnlPct}%) | ${t.duracionH}h | F&G:${t.fg}`);
    }

    lines.push(``, `💼 *PnL acumulado por activo:*`);
    for (const [sym, pos] of Object.entries(state.positions)) {
      const emoji = pos.profitAccum >= 0 ? "📈" : "📉";
      const pnlStr = `${pos.profitAccum >= 0 ? "+" : ""}$${pos.profitAccum.toFixed(0)}`;
      lines.push(`  ${emoji} ${sym}: ${pnlStr} | ${pos.cycleCount} ciclos`);
    }

    if (aprendizaje) {
      lines.push(
        ``, `━━━━━━━━━━━━━━━━━━━━`,
        `🧠 *APRENDIZAJE SEMANAL:*`,
        ``,
        `📝 ${aprendizaje.resumen}`,
        ``,
        `✅ *Funcionó:*`,
        aprendizaje.loQueFunciono,
        ``,
        `❌ *No funcionó:*`,
        aprendizaje.loQueNoFunciono,
        ``,
        `🔍 *Patrones detectados:*`,
        aprendizaje.patronesDetectados,
        ``,
        `⚙️ *Ajustes próxima semana:*`,
        aprendizaje.ajustesRecomendados,
        ``,
        `🚀 *Prioridades:* ${(aprendizaje.activosPrioridad||[]).join(" · ")}`,
        ``,
        `📅 *Proyección:* ${aprendizaje.proyeccionProxSemana}`,
      );
      if (aprendizaje.alertaRiesgo)
        lines.push(``, `⚠️ *Alerta riesgo:* ${aprendizaje.alertaRiesgo}`);
    }

    const ok = await sendWA(lines);
    if (ok) {
      state.alerts["WEEKLY_REPORT"] = Date.now();
      state.weeklyTrades  = [];
      state.weeklyPnl     = 0;
      state.lastWeekReset = Date.now();
      sent++;
    }
  }

  console.log(sent === 0 ? "\n✅ Sin alertas." : `\n📱 ${sent} alerta(s) enviada(s).`);
  saveState(state);
}

main().catch(err => {
  console.error("❌ Error fatal:", err.message);
  process.exit(1);
});

// ─── INSTRUCCIONES ────────────────────────────────────────────
/*
CRON — CADA 5 MINUTOS (GitHub Actions máximo):
  * /5 * * * * /usr/bin/node /ruta/bitcopper_v4_max.js >> /var/log/bitcopper.log 2>&1

VARIABLES DE ENTORNO:
  ANTHROPIC_API_KEY
  TWILIO_ACCOUNT_SID
  TWILIO_AUTH_TOKEN
  TWILIO_WHATSAPP_FROM   → whatsapp:+14155238886
  TWILIO_WHATSAPP_TO     → whatsapp:+569XXXXXXXX

SWING TARGETS (ajustables en ASSETS):
  BTC  4%  → ~$180/ciclo con $4,500
  ETH  5%  → ~$175/ciclo con $3,500
  SOL  6%  → ~$150/ciclo con $2,500
  TAO  7%  → ~$140/ciclo con $2,000
  XAU  4%  → ~$100/ciclo con $2,500

PARA MÁS/MENOS SENSIBILIDAD:
  Bajar swingPct y activationPct → más señales, ciclos más cortos
  Subir swingPct y activationPct → menos señales, ganancias mayores por ciclo
*/
