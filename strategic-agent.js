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
    rrMin:         3,            // R:R mínimo 3:1
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
    rrMin:         3,            // R:R mínimo 3:1
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
    rrMin:         3,            // R:R mínimo 3:1
  },
  XAU: {
    cgId:          "pax-gold",   // PAXG — token oro en CoinGecko
    apiType:       "coingecko",  // usa CoinGecko, no metals API
    capital:       2500,
    swingPct:      0.04,
    activationPct: 0.02,
    timeframe:     "1–3 días",
    cooldownH:     1,
    stopMult:      1.6,
    rrMin:         4,            // R:R mínimo 4:1 para oro (más selectivo)
  },
};


// ─── SHORTS EXNESS ──────────────────────────────────────────
// Capital total Exness: $812 | Señales informativas — Pedro abre en Exness
const EXNESS = {
  BTC: { capital: 300, lote: 0.01, swingPct: 0.04, stopMult: 1.8, rrMin: 3, simbolo: "BTCUSD" },
  ETH: { capital: 300, lote: 0.10, swingPct: 0.05, stopMult: 1.8, rrMin: 3, simbolo: "ETHUSD" },
  XAU: { capital: 212, lote: 0.10, swingPct: 0.04, stopMult: 1.6, rrMin: 4, simbolo: "XAUUSD" },
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
  XAU: ["gold","oro","xauusd","xau","paxg","pax gold","powell","fed rate",
        "interest rate","tasa de interés","inflation","inflación","iran",
        "guerra","war","dollar","dólar","nfp","treasury","geopolit",
        "refugio","safe haven","central bank","banco central","brics",
        "petrodollar","yield"],
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
const GIST_ID      = "fcb66e3c3aa96220b17040fd72295fab";
const GIST_FILE    = "state.json";
const NEWS_CD_H    = 2;    // noticias: 2h entre alertas
const HEARTBEAT_CD = 12;   // heartbeat 2x por día (7AM y 7PM)

// ─── HELPERS ─────────────────────────────────────────────────
function get(url, raw = false, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      https.get({
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { "User-Agent": "BitcopperAgent/4.1", ...extraHeaders }
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
    if (!s.learningRules) s.learningRules = null;
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
      learningRules:  null,   // reglas activas generadas por aprendizaje
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

async function loadStateFromGist() {
  const token = process.env.GIST_TOKEN;
  if (!token) return null;
  try {
    const d = await get(`https://api.github.com/gists/${GIST_ID}`,
      false, { "Authorization": `token ${token}`, "User-Agent": "BitcopperAgent/4.1", "Accept": "application/vnd.github.v3+json" });
    const content = d?.files?.[GIST_FILE]?.content;
    if (!content || content === "{}") return null;
    return JSON.parse(content);
  } catch(e) {
    console.log("  ⚠️ Gist load error:", e.message?.slice(0,50));
    return null;
  }
}

async function saveStateToGist(s) {
  const token = process.env.GIST_TOKEN;
  if (!token) return;
  try {
    await post(
      `https://api.github.com/gists/${GIST_ID}`,
      { files: { [GIST_FILE]: { content: JSON.stringify(s, null, 2) } } },
      { "Authorization": `token ${token}`, "Content-Type": "application/json",
        "User-Agent": "BitcopperAgent/4.1", "Accept": "application/vnd.github.v3+json" }
    );
    console.log("  ✅ Estado guardado en Gist");
  } catch(e) {
    console.log("  ⚠️ Gist save error:", e.message?.slice(0,50));
  }
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

// ─── GENERADOR DE REGLAS DE APRENDIZAJE ─────────────────────
async function generateLearningRules(state, fg, btcDom) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const trades = state.tradeLog || [];
  if (trades.length < 3) return null; // necesita al menos 3 trades

  const ganancias  = trades.filter(t => t.pnl > 0);
  const perdidas   = trades.filter(t => t.pnl <= 0);
  const winRate    = trades.length > 0 ? (ganancias.length / trades.length * 100).toFixed(0) : 0;

  // Calcular win rate por activo
  const porActivo = {};
  for (const sym of ["BTC","ETH","SOL","TAO","XAU"]) {
    const t = trades.filter(x => x.sym === sym);
    const g = t.filter(x => x.pnl > 0);
    porActivo[sym] = t.length > 0
      ? { trades: t.length, winRate: (g.length/t.length*100).toFixed(0), pnlTotal: t.reduce((s,x)=>s+x.pnl,0).toFixed(0) }
      : { trades: 0, winRate: "0", pnlTotal: "0" };
  }

  // Análisis de condiciones ganadoras
  const condGanadoras = ganancias.map(t =>
    `${t.sym}|+$${t.pnl}|${t.duracionH}h|F&G:${t.fg}|${t.razonEntrada}`
  ).join("\n");

  const condPerdedoras = perdidas.map(t =>
    `${t.sym}|$${t.pnl}|${t.duracionH}h|F&G:${t.fg}|${t.razonEntrada}`
  ).join("\n");

  const prompt = `Eres el motor de aprendizaje de Bitcopper para Pedro.
Estrategia: R:R 3:1 minimo. Meta: $1,000/semana, $4,000/mes. Capital: $15,000.

HISTORIAL COMPLETO (${trades.length} trades):
Win rate global: ${winRate}%
PnL total: $${trades.reduce((s,t)=>s+t.pnl,0).toFixed(0)}

WIN RATE POR ACTIVO:
${Object.entries(porActivo).map(([s,d])=>`${s}: ${d.winRate}% (${d.trades} trades, $${d.pnlTotal})`).join("\n")}

CONDICIONES DE TRADES GANADORES:
${condGanadoras || "Sin trades ganadores aun"}

CONDICIONES DE TRADES PERDEDORES:
${condPerdedoras || "Sin trades perdedores aun"}

CONTEXTO ACTUAL:
F&G: ${fg.value} (${fg.label}) | BTC Dom: ${btcDom}%

APRENDIZAJES PREVIOS:
${(state.learningNotes||[]).slice(-6).join("\n") || "Primera generacion de reglas"}

Genera reglas de decision optimizadas basadas en el historial real.
Responde SOLO JSON sin markdown:
{
  "version": "${new Date().toLocaleDateString('es-CL')}",
  "mejoresActivos": ["BTC","ETH"],
  "reglasEntrada": {
    "BTC": "condicion optima de entrada para BTC basada en historial",
    "ETH": "condicion optima para ETH",
    "SOL": "condicion optima para SOL",
    "TAO": "condicion optima para TAO",
    "XAU": "condicion optima para XAU"
  },
  "fgOptimo": { "compra": "rango F&G ideal para comprar", "venta": "rango para vender" },
  "duracionOptima": "duracion promedio de trades ganadores en horas",
  "evitar": "condiciones donde historicamente se pierde",
  "prioridadSemanal": "que hacer esta semana para llegar a $1,000",
  "confianzaPorActivo": { "BTC": "ALTA|MEDIA|BAJA", "ETH": "ALTA|MEDIA|BAJA", "SOL": "ALTA|MEDIA|BAJA", "TAO": "ALTA|MEDIA|BAJA", "XAU": "ALTA|MEDIA|BAJA" }
}`;

  try {
    const r = await post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-sonnet-4-20250514", max_tokens: 800,
        messages: [{ role: "user", content: prompt }] },
      { "Content-Type": "application/json", "x-api-key": key,
        "anthropic-version": "2023-06-01" }
    );
    const raw = r.body?.content?.[0]?.text ?? "{}";
    return JSON.parse(raw.replace(/```json|```/g,"").trim());
  } catch(e) {
    console.log("  ⚠️ Learning rules error:", e.message?.slice(0,50));
    return null;
  }
}

// ─── MOTOR DE DECISIÓN CLAUDE — MAX SENSIBILIDAD ─────────────
async function claudeDecide(sym, price, pos, fg, btcDom, news, asset, state) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const changePctFromLast  = pos.lastPrice  ? pctChange(pos.lastPrice, price)  : 0;
  const changePctFromEntry = pos.entryPrice ? pctChange(pos.entryPrice, price) : 0;

  const newsStr = news.length > 0
    ? news.slice(0, 5).map((n, i) => `[${i+1}] ${n.source}: "${n.title}"\n${n.desc}`).join("\n\n")
    : "Sin noticias relevantes recientes.";

  const fgSignal = fg.value < 20 ? "PANICO EXTREMO → señal COMPRA muy fuerte"
    : fg.value < 35 ? "MIEDO → sesgo compra"
    : fg.value > 80 ? "EUFORIA → señal VENTA muy fuerte"
    : fg.value > 65 ? "CODICIA → sesgo venta"
    : "NEUTRAL";

  // Inyectar reglas de aprendizaje activo
  const rules = pos.learningRules || state?.learningRules;
  const reglasStr = rules ? `
REGLAS APRENDIDAS DE HISTORIAL REAL (aplica estas por encima de las generales):
- Mejores activos: ${(rules.mejoresActivos||[]).join(", ")}
- Regla específica para ${sym}: ${rules.reglasEntrada?.[sym] || "sin datos suficientes"}
- F&G óptimo compra: ${rules.fgOptimo?.compra || "no definido"}
- Confianza histórica en ${sym}: ${rules.confianzaPorActivo?.[sym] || "MEDIA"}
- Evitar: ${rules.evitar || "no definido"}
- Duración óptima: ${rules.duracionOptima || "no definido"}
` : "Sin reglas de aprendizaje aun — usando criterios generales.";

  // Calcular zonas dinámicas desde precio actual
  const buyTarget  = price * (1 - asset.swingPct);
  const sellTarget = price * (1 + asset.swingPct);
  const stopPrice  = pos.entryPrice ? pos.entryPrice * (1 - asset.swingPct * asset.stopMult) : 0;

  // R:R dinamico
  const riskPct = asset.swingPct * asset.stopMult;
  const rrMin   = asset.rrMin || 3;
  const rrStop  = price * (1 - riskPct);
  const rrTgt   = price * (1 + riskPct * rrMin);
  const rrTgtP1 = price * (1 + riskPct * (rrMin + 1));

  const prompt = `Eres el motor de decision de Bitcopper v4.1 para Pedro.
Meta semanal: $1,000. Capital en ${sym}: $${asset.capital}.
FILOSOFIA: Solo entrar con Riesgo:Recompensa minimo ${rrMin}:1 ${sym === "XAU" ? "(oro requiere mayor confirmacion)" : "(cripto)"}.

ACTIVO: ${sym} | Precio: ${fmtP(price)} | F&G: ${fg.value} (${fgSignal})
Cambio reciente: ${changePctFromLast.toFixed(2)}% | BTC Dom: ${btcDom}%
Fase: ${pos.phase}${pos.phase === 'HOLDING' ? ` | Entrada: ${fmtP(pos.entryPrice)} | PnL: ${changePctFromEntry.toFixed(2)}%` : ''}

NOTICIAS (${sym}):
${newsStr}

${reglasStr}

CALCULO R:R si entra ahora:
Stop: ${fmtP(rrStop)} | Target ${rrMin}:1: ${fmtP(rrTgt)} | Target ${rrMin+1}:1: ${fmtP(rrTgtP1)}

REGLAS:
- COMPRAR: soporte claro + target ${rrMin}:1 alcanzable + F&G<70 + noticias no bajistas
- VENDER: precio alcanzo target 3:1 o 4:1
- PREPARAR_COMPRA: estructura bajista agotandose, soporte visible
- PREPARAR_VENTA: precio cerca del target
- STOP_DEFENSIVO: rompio soporte con fuerza
- ESPERAR: sin R:R ${rrMin}:1 claro. Calidad sobre cantidad.

Responde SOLO JSON sin markdown:
{
  "decision": "COMPRAR"|"VENDER"|"PREPARAR_COMPRA"|"PREPARAR_VENTA"|"STOP_DEFENSIVO"|"ESPERAR",
  "confianza": "ALTA"|"MEDIA"|"BAJA",
  "razon": "max 2 lineas con R:R",
  "stopPrice": ${rrStop.toFixed(2)},
  "targetPrice": ${rrTgt.toFixed(2)},
  "ratio": "${rrMin}:1",
  "gananciaEstimada": ${(asset.capital * riskPct * rrMin).toFixed(0)},
  "urgencia": "INMEDIATA"|"PROXIMA_HORA"|"HOY"
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


// ─── MOTOR SHORTS EXNESS ─────────────────────────────────────
async function claudeShort(sym, price, ex, fg, btcDom, news, state) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const newsStr = news.length > 0
    ? news.slice(0,4).map((n,i)=>`[${i+1}] ${n.source}: "${n.title}"`).join("\n")
    : "Sin noticias relevantes.";
  const fgSignal = fg.value > 75 ? "EUFORIA → SHORT fuerte"
    : fg.value > 60 ? "CODICIA → sesgo SHORT"
    : fg.value < 25 ? "PANICO → evitar shorts"
    : "NEUTRAL";
  const riskPct = ex.swingPct * ex.stopMult;
  const stopSh  = price * (1 + riskPct);
  const tgt     = price * (1 - riskPct * ex.rrMin);
  const shortPos = state.shortPositions?.[sym];
  const prompt = `Motor de shorts Bitcopper para Pedro. Capital Exness ${sym}: $${ex.capital} | Lote: ${ex.lote}
Solo shortear con R:R minimo ${ex.rrMin}:1. Complementa los longs de Binance.
Precio: $${price} | F&G: ${fg.value} (${fgSignal}) | BTC Dom: ${btcDom}%
${shortPos?.phase === "SHORT_OPEN" ? `SHORT ABIERTO desde $${shortPos.entryPrice}` : "Sin short abierto"}
NOTICIAS: ${newsStr}
R:R SHORT: Stop $${stopSh.toFixed(0)} | Target ${ex.rrMin}:1 = $${tgt.toFixed(0)}
REGLAS: SHORT si resistencia clara + F&G>55 + R:R${ex.rrMin}:1. CUBRIR si llego target o F&G<35. ESPERAR si F&G<20.
Responde SOLO JSON: {"decision":"ABRIR_SHORT"|"CUBRIR_SHORT"|"PREPARAR_SHORT"|"ESPERAR","confianza":"ALTA"|"MEDIA"|"BAJA","razon":"max 2 lineas","stopPrice":${stopSh.toFixed(2)},"targetPrice":${tgt.toFixed(2)},"ratio":"${ex.rrMin}:1","lote":${ex.lote},"gananciaEstimada":${(ex.capital*riskPct*ex.rrMin).toFixed(0)},"urgencia":"INMEDIATA"|"PROXIMA_HORA"|"HOY"}`;
  try {
    const r = await post("https://api.anthropic.com/v1/messages",
      { model:"claude-sonnet-4-20250514", max_tokens:250, messages:[{role:"user",content:prompt}] },
      {"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01"});
    return JSON.parse((r.body?.content?.[0]?.text??"{}").replace(/```json|```/g,"").trim());
  } catch(e) { console.log(`  ⚠️ Short error (${sym}):`,e.message?.slice(0,40)); return null; }
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

  // Cargar estado: Gist primero, fallback a local
  let state = await loadStateFromGist();
  if (!state) {
    console.log("  📂 Sin estado en Gist — cargando local");
    state = loadState();
  } else {
    console.log("  ✅ Estado cargado desde Gist");
    // Migración: asegurar campos nuevos
    if (!state.tradeLog)      state.tradeLog      = [];
    if (!state.weeklyTrades)  state.weeklyTrades  = [];
    if (!state.learningNotes) state.learningNotes = [];
    if (!state.totalCycles)   state.totalCycles   = 0;
  }
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
      const result = await claudeDecide(sym, price, pos, fg, btcDom, relevantNews, asset, state);

      if (result && result.decision !== "ESPERAR") {
        // Si es COMPRAR: guardar pendingConfirmation en Gist ANTES de enviar WhatsApp
        // Así cuando Pedro responda "1", el webhook ya encuentra el pending
        if (result.decision === "COMPRAR") {
          state.pendingConfirmation = {
            sym,
            price,
            razon:       result.razon,
            stopPrice:   result.stopPrice  || price * (1 - asset.swingPct * asset.stopMult),
            targetPrice: result.targetPrice || price * (1 + asset.swingPct * asset.stopMult * 3),
            ratio:       result.ratio || "3:1",
            ts:          Date.now(),
          };
          state.alerts[`${sym}_DECIDE`] = Date.now();
          saveState(state);
          await saveStateToGist(state);  // guardar ANTES del WhatsApp
          console.log(`  💾 Pending guardado en Gist: ${sym} a ${fmtP(price)}`);
        }

        const msgLines = buildMessage(sym, result, price, asset, pos);
        const ok = await sendWA(msgLines);

        if (ok) {
          if (result.decision !== "COMPRAR") {
            state.alerts[`${sym}_DECIDE`] = Date.now();
          }
          sent++;

          // Actualizar estado según decisión
          if (result.decision === "COMPRAR") {
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


  // ── SHORTS EXNESS ────────────────────────────────────────
  if (!state.shortPositions) state.shortPositions = {};
  for (const [sym, ex] of Object.entries(EXNESS)) {
    const pd = prices[sym] || prices["XAU"];
    if (!pd?.price) continue;
    const price    = pd.price;
    const shortPos = state.shortPositions[sym] || { phase:"SHORT_WAITING", entryPrice:0, lastPrice:0 };
    const relNews  = newNews.filter(n => getAffectedAssets(n.title,n.desc).includes(sym));
    const cdOk     = canAlert(state, `${sym}_SHORT`, 0.75);
    const movPct   = shortPos.lastPrice ? Math.abs(pctChange(shortPos.lastPrice, price)) : 100;
    const inShort  = shortPos.phase === "SHORT_OPEN";
    const stopHit  = inShort && pctChange(shortPos.entryPrice, price) >= ex.swingPct * ex.stopMult * 100;

    if ((movPct >= ex.swingPct*60 || relNews.length > 0 || stopHit) && cdOk) {
      const result = await claudeShort(sym, price, ex, fg, btcDom, relNews, state);
      if (result && result.decision !== "ESPERAR") {
        const icons = { ABRIR_SHORT:"🔴", CUBRIR_SHORT:"💚", PREPARAR_SHORT:"⚡" };
        const urgStr = result.urgencia==="INMEDIATA"?"⏰ INMEDIATA":result.urgencia==="PROXIMA_HORA"?"🕐 Próx hora":"📅 Hoy";
        const lines = [
          `${icons[result.decision]||"🔵"} *${result.decision.replace(/_/g," ")} — ${sym} EXNESS*`,
          `━━━━━━━━━━━━━━━━━━━━`,
          `💰 Precio: ${fmtP(price)} | ${urgStr} | Confianza: ${result.confianza}`,
        ];
        if (result.decision === "ABRIR_SHORT") {
          lines.push(`📉 Stop: ${fmtP(result.stopPrice)} | Target ${result.ratio}: ${fmtP(result.targetPrice)}`);
          lines.push(`📦 Lote: ${result.lote} ${ex.simbolo} en Exness MT5`);
          lines.push(`💵 Capital: $${ex.capital} | Ganancia est: ~$${result.gananciaEstimada}`);
          lines.push(``, `Responde *1* para confirmar / *2* para ignorar`);
          state.pendingShort = { sym, price, razon:result.razon, stopPrice:result.stopPrice, targetPrice:result.targetPrice, ratio:result.ratio, lote:result.lote, ts:Date.now() };
          saveState(state);
          await saveStateToGist(state);
        }
        if (result.decision === "CUBRIR_SHORT" && inShort) {
          const pnl = (shortPos.entryPrice - price) * ex.capital / shortPos.entryPrice;
          lines.push(`📈 Entrada: ${fmtP(shortPos.entryPrice)} | PnL: ${pnl>=0?"+":""}$${pnl.toFixed(0)}`);
          lines.push(`👉 Cubrir en Exness MT5 → ${ex.simbolo}`);
        }
        if (result.decision === "PREPARAR_SHORT") {
          lines.push(`📉 Precio cerca de resistencia — prepara short en Exness`);
        }
        lines.push(``, `🧠 ${result.razon}`);
        const ok = await sendWA(lines);
        if (ok) {
          state.alerts[`${sym}_SHORT`] = Date.now();
          sent++;
          if (result.decision === "CUBRIR_SHORT" && inShort) {
            const pnl = (shortPos.entryPrice - price) * ex.capital / shortPos.entryPrice;
            state.monthlyPnl += pnl; state.weeklyPnl += pnl;
            const trade = { sym, tipo:"SHORT_EXNESS", entryPrice:shortPos.entryPrice, exitPrice:price,
              pnl:+pnl.toFixed(2), pnlPct:+((shortPos.entryPrice-price)/shortPos.entryPrice*100).toFixed(2),
              capital:ex.capital, lote:ex.lote,
              fechaEntrada:shortPos.entryTs?new Date(shortPos.entryTs).toISOString():"?",
              fechaSalida:new Date().toISOString(),
              duracionH:shortPos.entryTs?+((Date.now()-shortPos.entryTs)/3600000).toFixed(1):0,
              resultado:pnl>=0?"GANANCIA":"PERDIDA", razonEntrada:shortPos.razon||"?", razonSalida:result.razon, fg:fg.value };
            state.tradeLog.push(trade); state.weeklyTrades.push(trade);
            state.shortPositions[sym] = { phase:"SHORT_WAITING", entryPrice:0, lastPrice:price };
          }
        }
      }
      state.shortPositions[sym] = { ...shortPos, lastPrice:price };
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

  const isHeartbeatHour = hour === 7 || hour === 19;
  if (isHeartbeatHour && canAlert(state, "HEARTBEAT_DAILY", HEARTBEAT_CD)) {
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
  // Enviar cualquier lunes entre 8AM y 20PM, con cooldown de 20h para no repetir
  const isMonday = now.getDay() === 1;
  const isWeeklyWindow = hour >= 8 && hour <= 20;
  const weeklyNotSentToday = canAlert(state, "WEEKLY_REPORT", 20);
  if (isMonday && isWeeklyWindow && weeklyNotSentToday) {
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
    if (apiKey) {
      try {
        const tradeResumen = wt.map(t =>
          `${t.sym}|${t.tipo}|E:${t.entryPrice}→S:${t.exitPrice}|PnL:${t.pnl>0?"+":""}$${t.pnl}(${t.pnlPct}%)|${t.duracionH}h|F&G:${t.fg}|${t.resultado}|EntradaPor:"${t.razonEntrada}"|SalidaPor:"${t.razonSalida}"`
        ).join("\n");

        const posicionesActuales = Object.entries(state.positions || {})
          .map(([s,p]) => p.phase === "HOLDING"
            ? `${s}: HOLDING desde $${p.entryPrice} | Ciclos: ${p.cycleCount} | PnL acum: $${(p.profitAccum||0).toFixed(0)}`
            : `${s}: USDT | Ciclos: ${p.cycleCount} | PnL acum: $${(p.profitAccum||0).toFixed(0)}`
          ).join("\n");

        const prompt = `Eres el analista de rendimiento de Bitcopper para Pedro (Calama, Chile).
Meta semanal: $1,000 USDT. Meta mensual: $4,000. Capital: $15,000. Activos: BTC/ETH/SOL/TAO/XAU.
Estrategia: R:R minimo 3:1. Solo entradas con soporte tecnico claro.
Semana: PnL $${totalPnl.toFixed(0)} | ${wt.length} trades cerrados | Win rate: ${winRate}% | F&G actual: ${fg.value}

POSICIONES ACTUALES:
${posicionesActuales}

TRADES CERRADOS ESTA SEMANA:
${wt.length > 0 ? tradeResumen : "Sin trades cerrados esta semana — capital en USDT esperando oportunidades R:R 3:1"}

HISTORIAL ACUMULADO:
${Object.entries(state.positions||{}).map(([s,p])=>`${s}: $${(p.profitAccum||0).toFixed(0)} acum | ${p.cycleCount||0} ciclos`).join(" | ")}

APRENDIZAJES PREVIOS:
${state.learningNotes.slice(-4).join("\n") || "Primera semana de operacion."}

Analiza y responde UNICAMENTE con este JSON sin markdown:
{
  "resumen": "1 linea resultado semana",
  "loQueFunciono": "que activos/condiciones generaron ganancias o protegieron capital",
  "loQueNoFunciono": "que fallo o por que no hubo trades esta semana",
  "patronesDetectados": "patrones R:R, F&G optimo, activos mas rentables",
  "ajustesRecomendados": "3 ajustes concretos para proxima semana considerando R:R 3:1",
  "activosPrioridad": ["BTC","ETH"],
  "alertaRiesgo": "riesgo sistemico o null",
  "proyeccionProxSemana": "expectativa PnL y condiciones favorables considerando F&G actual"
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
      // Generar nuevas reglas de aprendizaje basadas en historial completo
      console.log("  🧠 Generando reglas de aprendizaje...");
      const newRules = await generateLearningRules(state, fg, btcDom);
      if (newRules) {
        state.learningRules = newRules;
        console.log("  ✅ Reglas de aprendizaje actualizadas v" + newRules.version);
        // Notificar a Pedro las nuevas reglas
        const rulesMsg = [
          `🧠 *REGLAS ACTUALIZADAS — Bitcopper v4.1*`,
          `━━━━━━━━━━━━━━━━━━━━`,
          `📅 Versión: ${newRules.version}`,
          ``,
          `🏆 *Activos prioritarios:* ${(newRules.mejoresActivos||[]).join(" · ")}`,
          ``,
          `📊 *Confianza por activo:*`,
          ...Object.entries(newRules.confianzaPorActivo||{}).map(([s,c]) =>
            `  ${c==="ALTA"?"🟢":c==="MEDIA"?"🟡":"🔴"} ${s}: ${c}`
          ),
          ``,
          `🎯 *Esta semana:* ${newRules.prioridadSemanal}`,
          ``,
          `⚠️ *Evitar:* ${newRules.evitar}`,
        ].join("\n");
        await sendWA(rulesMsg.split("\n"));
      }
      state.weeklyTrades   = [];
      state.weeklyPnl      = 0;
      state.lastWeekReset  = Date.now();
      sent++;
      console.log("  📊 Informe semanal enviado y estado reseteado");
    }
  }

  console.log(sent === 0 ? "\n✅ Sin alertas." : `\n📱 ${sent} alerta(s) enviada(s).`);
  saveState(state);
  await saveStateToGist(state);
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
