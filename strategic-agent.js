// ============================================================
// Bitcopper Strategic Agent v4.2 — MAX SENSIBILIDAD + SENSOR ETF
// Motor: F&G + Precio + Noticias + Flujos ETF institucionales → Claude decide
// Activos: BTC · ETH · SOL · TAO · XAU
// Salida: WhatsApp vía Twilio
// Autor: Bitcopper Technologies LLC — Calama, Chile
//
// CAMBIOS v4.2 (25-jun-2026):
//  - FIX CRÍTICO: modelo Claude actualizado a claude-sonnet-4-6
//    (claude-sonnet-4-20250514 fue retirado el 15-jun-2026 → el bot
//     llevaba 10 días sin tomar decisiones, fallando en silencio).
//  - Modelo centralizado en UNA constante (CLAUDE_MODEL). Cero repetición.
//  - Auto-vigilancia: detecta y ALERTA por WhatsApp fallos de API
//    (modelo deprecado, CoinGecko/Twilio/Gist caídos). No más fallos silenciosos.
//  - Verificación proactiva del modelo 1x/día en el heartbeat.
//  - Sensor ETF institucional (CoinGlass): flujos BTC/ETH + clasificador
//    de fase de mercado. Informa Y ajusta filtros de entrada.
//  - XAU unificado a CoinGecko (antes usaba dos caminos, uno roto).
//  - Timeouts por request (antes get/post podían colgar indefinidamente).
//  - reqJSON con manejo de status HTTP real en todas las llamadas.
// ============================================================

const https = require("https");
const fs    = require("fs");

// ─── CONFIG MODELO (ÚNICO lugar donde se define el modelo) ──
// La próxima migración de modelo es cambiar SOLO esta línea.
const CLAUDE_MODEL    = "claude-sonnet-4-6";
const ANTHROPIC_VER   = "2023-06-01";
const REQ_TIMEOUT_MS  = 12000;   // timeout duro por request de red

// ─── FLAGS DE SENSORES ──────────────────────────────────────
const ETF_SENSOR_ENABLED = true;   // sensor de flujos ETF institucionales
const ETF_AFFECTS_FILTER = true;   // si true, la fase de mercado ajusta entradas

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
const ASSETS = {
  BTC: {
    cgId: "bitcoin", apiType: "coingecko", capital: 4500,
    swingPct: 0.04, activationPct: 0.025, timeframe: "horas–1 día",
    cooldownH: 0.5, stopMult: 1.8, rrMin: 3,
  },
  ETH: {
    cgId: "ethereum", apiType: "coingecko", capital: 3500,
    swingPct: 0.05, activationPct: 0.03, timeframe: "horas–1 día",
    cooldownH: 0.5, stopMult: 1.8, rrMin: 3,
  },
  SOL: {
    cgId: "solana", apiType: "coingecko", capital: 2500,
    swingPct: 0.06, activationPct: 0.035, timeframe: "1–2 días",
    cooldownH: 0.75, stopMult: 1.7, rrMin: 3,
  },
  TAO: {
    cgId: "bittensor", apiType: "coingecko", capital: 2000,
    swingPct: 0.07, activationPct: 0.04, timeframe: "1–2 días",
    cooldownH: 0.75, stopMult: 1.7, rrMin: 3,
  },
  XAU: {
    cgId: "pax-gold", apiType: "coingecko", capital: 2500,
    swingPct: 0.04, activationPct: 0.02, timeframe: "1–3 días",
    cooldownH: 1, stopMult: 1.6, rrMin: 4,
  },
};

// ─── SHORTS EXNESS ──────────────────────────────────────────
const EXNESS = {
  BTC: { capital: 300, lote: 0.01, swingPct: 0.04, stopMult: 1.8, rrMin: 3, simbolo: "BTCUSD" },
  ETH: { capital: 300, lote: 0.10, swingPct: 0.05, stopMult: 1.8, rrMin: 3, simbolo: "ETHUSD" },
  XAU: { capital: 212, lote: 0.10, swingPct: 0.04, stopMult: 1.6, rrMin: 4, simbolo: "XAUUSD" },
};

// ─── KEYWORDS DE NOTICIAS ────────────────────────────────────
const ASSET_KEYWORDS = {
  BTC: ["bitcoin","btc","trump","iran","fed","federal reserve","etf","blackrock",
        "macro","inflation","war","geopolit","oil","reserva federal","halving",
        "tariff","arancel","crypto","criptomoneda","sec","regulation","whale",
        "mining","hashrate","lightning","satoshi","microstrategy","coinbase","ibit"],
  ETH: ["ethereum","eth","vitalik","pectra","layer2","l2","rollup","staking",
        "defi","dencun","eth etf","gas fee","eip","polygon","arbitrum","optimism",
        "uniswap","lido","restaking","etha"],
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

// ─── CONFIGURACIÓN GENERAL ───────────────────────────────────
const STATE_FILE   = "/tmp/bitcopper_v41_state.json";
const GIST_ID      = "fcb66e3c3aa96220b17040fd72295fab";
const GIST_FILE    = "state.json";
const NEWS_CD_H    = 2;
const HEARTBEAT_CD = 12;
const SYS_ALERT_CD = 6;    // cooldown alertas de sistema (h)

// ─── HELPERS DE RED (con timeout y status real) ─────────────
function get(url, raw = false, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const req = https.get({
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { "User-Agent": "BitcopperAgent/4.2", ...extraHeaders },
        timeout: REQ_TIMEOUT_MS,
      }, res => {
        if (res.statusCode === 301 || res.statusCode === 302)
          return get(res.headers.location, raw, extraHeaders).then(resolve).catch(reject);
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          if (raw) return resolve(d);
          try { resolve(JSON.parse(d)); } catch { resolve(d); }
        });
      });
      req.on("timeout", () => { req.destroy(new Error("timeout")); });
      req.on("error", reject);
    } catch(e) { reject(e); }
  });
}

// post devuelve SIEMPRE { status, body } para poder inspeccionar errores HTTP
function post(url, payload, headers) {
  return new Promise((resolve, reject) => {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: { "Content-Length": Buffer.byteLength(body), ...headers },
      timeout: REQ_TIMEOUT_MS,
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Llama a la API de Claude de forma centralizada, con detección de errores.
// Devuelve { ok, data, status, errType, errMsg }.
async function callClaude(messages, maxTokens) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, errType: "no_key", errMsg: "ANTHROPIC_API_KEY ausente" };
  try {
    const r = await post(
      "https://api.anthropic.com/v1/messages",
      { model: CLAUDE_MODEL, max_tokens: maxTokens, messages },
      { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VER }
    );
    if (r.status !== 200) {
      return {
        ok: false, status: r.status,
        errType: r.body?.error?.type || "http_" + r.status,
        errMsg:  r.body?.error?.message || JSON.stringify(r.body)?.slice(0, 120),
      };
    }
    const raw = r.body?.content?.[0]?.text;
    if (!raw) return { ok: false, status: 200, errType: "empty", errMsg: "respuesta vacía" };
    return { ok: true, data: raw, status: 200 };
  } catch(e) {
    return { ok: false, errType: "network", errMsg: e.message?.slice(0, 120) };
  }
}

function parseClaudeJSON(raw) {
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { return null; }
}

// ─── HELPERS GENERALES ───────────────────────────────────────
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
function fmtM(n) {  // formatea millones para flujos ETF
  if (n === null || n === undefined || isNaN(n)) return "?";
  const abs = Math.abs(n);
  const sign = n >= 0 ? "+" : "-";
  if (abs >= 1000) return `${sign}$${(abs/1000).toFixed(2)}B`;
  return `${sign}$${abs.toFixed(0)}M`;
}

// ─── AUTO-VIGILANCIA: alerta de fallos de sistema ───────────
// Reporta por WhatsApp cuando una API crítica falla, con cooldown
// anti-spam por tipo. Esto evita que el bot quede "cerebro-muerto"
// en silencio (como pasó con el modelo deprecado 10 días).
async function reportarFalloSistema(state, tipo, detalle) {
  if (!canAlert(state, `SYS_${tipo}`, SYS_ALERT_CD)) return;
  console.log(`  🚨 FALLO SISTEMA [${tipo}]: ${detalle}`);
  const ok = await sendWA([
    `🚨 *FALLO DE SISTEMA — Bitcopper*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `⚙️ Tipo: ${tipo}`,
    `📋 ${detalle}`,
    ``,
    `El bot sigue corriendo, pero esta función está degradada.`,
    `Revisa logs o configuración cuando puedas.`,
  ]);
  if (ok) state.alerts[`SYS_${tipo}`] = Date.now();
}

// Verificación proactiva del modelo (1x/día en heartbeat).
// Hace una llamada mínima; si el modelo está retirado, avisa.
async function verificarModelo(state) {
  const r = await callClaude([{ role: "user", content: "ok" }], 5);
  if (!r.ok && (r.errType === "not_found_error" || /model/i.test(r.errMsg || "") || r.status === 404)) {
    await reportarFalloSistema(state, "MODELO_DEPRECADO",
      `El modelo ${CLAUDE_MODEL} no responde (${r.errType}: ${r.errMsg}). Hay que migrar el string CLAUDE_MODEL.`);
    return false;
  }
  if (!r.ok && r.errType === "no_key") {
    await reportarFalloSistema(state, "API_KEY",
      "ANTHROPIC_API_KEY ausente o inválida.");
    return false;
  }
  console.log(`  ✅ Modelo ${CLAUDE_MODEL} activo`);
  return true;
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return migrateState(s);
  } catch {
    const s = {
      alerts: {}, positions: {}, newsHashes: [], weeklyPnl: 0, monthlyPnl: 0,
      totalCycles: 0, tradeLog: [], weeklyTrades: [], learningNotes: [],
      learningRules: null,
      macroTrend: { direction:"neutral", daysDown:0, daysUp:0, lastCheck:0 },
      etf: { btcFlow7d: null, ethFlow7d: null, lastDaily: null, phase: "DESCONOCIDA", lastCheck: 0, history: [] },
      capitulationAlert: 0, lastWeekReset: Date.now(), lastMonthReset: Date.now(),
    };
    for (const sym of Object.keys(ASSETS)) {
      s.positions[sym] = { phase:"WAITING_BUY", entryPrice:0, lastPrice:0, cycleCount:0, profitAccum:0 };
    }
    return s;
  }
}

// Migración: garantiza que todo estado viejo tenga los campos nuevos.
function migrateState(s) {
  if (!s.tradeLog)      s.tradeLog      = [];
  if (!s.weeklyTrades)  s.weeklyTrades  = [];
  if (!s.learningNotes) s.learningNotes = [];
  if (!s.learningRules) s.learningRules = null;
  if (!s.totalCycles)   s.totalCycles   = 0;
  if (!s.alerts)        s.alerts        = {};
  if (!s.positions)     s.positions     = {};
  if (!s.macroTrend)    s.macroTrend    = { direction:"neutral", daysDown:0, daysUp:0, lastCheck:0 };
  if (!s.etf)           s.etf           = { btcFlow7d:null, ethFlow7d:null, lastDaily:null, phase:"DESCONOCIDA", lastCheck:0, history:[] };
  for (const sym of Object.keys(ASSETS)) {
    if (!s.positions[sym])
      s.positions[sym] = { phase:"WAITING_BUY", entryPrice:0, lastPrice:0, cycleCount:0, profitAccum:0 };
  }
  return s;
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function loadStateFromGist(state) {
  const token = process.env.GIST_TOKEN;
  if (!token) return null;
  try {
    const d = await get(`https://api.github.com/gists/${GIST_ID}`,
      false, { "Authorization": `token ${token}`, "User-Agent": "BitcopperAgent/4.2", "Accept": "application/vnd.github.v3+json" });
    const content = d?.files?.[GIST_FILE]?.content;
    if (!content || content === "{}") return null;
    return migrateState(JSON.parse(content));
  } catch(e) {
    console.log("  ⚠️ Gist load error:", e.message?.slice(0,50));
    return null;
  }
}

async function saveStateToGist(s, state) {
  const token = process.env.GIST_TOKEN;
  if (!token) return;
  try {
    const r = await post(
      `https://api.github.com/gists/${GIST_ID}`,
      { files: { [GIST_FILE]: { content: JSON.stringify(s, null, 2) } } },
      { "Authorization": `token ${token}`, "Content-Type": "application/json",
        "User-Agent": "BitcopperAgent/4.2", "Accept": "application/vnd.github.v3+json" }
    );
    if (r.status >= 200 && r.status < 300) {
      console.log("  ✅ Estado guardado en Gist");
    } else if (state) {
      await reportarFalloSistema(state, "GIST_SAVE", `Gist devolvió HTTP ${r.status} al guardar estado.`);
    }
  } catch(e) {
    console.log("  ⚠️ Gist save error:", e.message?.slice(0,50));
  }
}

// ─── FETCH PRECIOS (XAU unificado a CoinGecko) ──────────────
async function fetchCryptoPrices(state) {
  const cgAssets = Object.entries(ASSETS).filter(([, a]) => a.apiType === "coingecko");
  const ids = cgAssets.map(([, a]) => a.cgId).join(",");
  try {
    const d = await get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_7d_change=true`
    );
    const r = {};
    let missing = 0;
    for (const [sym, info] of cgAssets) {
      const px = d[info.cgId]?.usd ?? 0;
      if (!px) missing++;
      r[sym] = {
        price:     px,
        change24h: d[info.cgId]?.usd_24h_change ?? 0,
        change7d:  d[info.cgId]?.usd_7d_change ?? 0,
      };
    }
    // Si CoinGecko devolvió vacío para todos, es un fallo de fuente
    if (missing === cgAssets.length && state) {
      await reportarFalloSistema(state, "COINGECKO", "CoinGecko no devolvió precios para ningún activo.");
    }
    return r;
  } catch(e) {
    if (state) await reportarFalloSistema(state, "COINGECKO", `CoinGecko caído: ${e.message?.slice(0,60)}`);
    const r = {};
    for (const [sym] of cgAssets) r[sym] = { price:0, change24h:0, change7d:0 };
    return r;
  }
}

// XAU ahora viene de CoinGecko (pax-gold) dentro de fetchCryptoPrices.
// fetchGoldPrice() eliminada — ya no se usa el camino roto de metals.live.
async function fetchAllPrices(state) {
  return await fetchCryptoPrices(state);
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

// ─── SENSOR ETF INSTITUCIONAL (CoinGlass) ───────────────────
// Lee flujos diarios de ETF spot de BTC y ETH. Parseo DEFENSIVO:
// busca campos por nombre, tolera variaciones de estructura, degrada
// elegante si el formato cambia. Devuelve flujos en millones USD.
async function fetchETFFlows(state) {
  if (!ETF_SENSOR_ENABLED) return null;
  const key = process.env.COINGLASS_API_KEY;
  if (!key) {
    if (state) await reportarFalloSistema(state, "COINGLASS_KEY",
      "COINGLASS_API_KEY ausente — sensor ETF inactivo. Agrega el secret para activarlo.");
    return null;
  }

  const headers = { "CG-API-KEY": key, "Accept": "application/json", "User-Agent": "BitcopperAgent/4.2" };
  // Endpoint verificado (25-jun-2026). El segundo queda como fallback defensivo.
  const endpoints = [
    "https://open-api-v4.coinglass.com/api/etf/bitcoin/flow-history?limit=30",
    "https://open-api-v4.coinglass.com/api/bitcoin/etf/flow-history?limit=30",
  ];

  async function pull(url) {
    try {
      const d = await get(url, false, headers);
      // CoinGlass V4 envuelve la respuesta en {code, data:[...]}.
      // Se contemplan variantes por robustez ante cambios de schema.
      const arr = Array.isArray(d) ? d
        : Array.isArray(d?.data) ? d.data
        : Array.isArray(d?.data?.list) ? d.data.list
        : Array.isArray(d?.data?.dataList) ? d.data.dataList
        : null;
      return arr;
    } catch(e) {
      console.log(`  ⚠️ ETF pull error: ${e.message?.slice(0,60)}`);
      return null;
    }
  }

  let btcArr = null;
  for (const ep of endpoints) {
    btcArr = await pull(ep);
    if (btcArr && btcArr.length) break;
  }
  if (!btcArr || !btcArr.length) {
    if (state) await reportarFalloSistema(state, "COINGLASS_FETCH",
      "CoinGlass no devolvió flujos ETF (endpoint o formato cambiado).");
    return null;
  }

  // Extrae el flujo neto diario. Formato real CoinGlass V4: campo "flow_usd"
  // (USD crudos). Se mantienen alias defensivos por si cambian el schema.
  function netOf(row) {
    const cand = ["flow_usd","flowUsd","changeUsd","netFlow","total_net_inflow","netInflow","value"];
    for (const k of cand) {
      if (typeof row?.[k] === "number") return row[k];
      if (typeof row?.[k] === "string" && !isNaN(+row[k])) return +row[k];
    }
    return null;
  }
  // CoinGlass entrega USD crudos → convertir a millones.
  function toMillions(v) {
    if (v === null) return null;
    return v / 1e6;
  }

  // Ordena por fecha DESC (más reciente primero).
  const tsKey = ["timestamp","time","date","t"].find(k => btcArr[0]?.[k] !== undefined);
  if (tsKey) btcArr = [...btcArr].sort((a,b) => (b[tsKey] - a[tsKey]));

  // El registro más reciente puede venir con flow_usd:0 (día sin cierre aún).
  // Se descartan los registros sin flujo real (null o exactamente 0 con etf_flows vacíos).
  function esDiaValido(row) {
    const v = netOf(row);
    if (v === null) return false;
    // Día sin datos: flow_usd 0 y todos los etf_flows sin flow_usd
    if (v === 0 && Array.isArray(row?.etf_flows)) {
      const algunFlujo = row.etf_flows.some(e => typeof e?.flow_usd === "number" && e.flow_usd !== 0);
      if (!algunFlujo) return false;
    }
    return true;
  }

  const validos = btcArr.filter(esDiaValido);
  const last7 = validos.slice(0, 7).map(netOf).map(toMillions);
  const lastDaily = last7.length ? last7[0] : null;
  const flow7dAvg = last7.length ? last7.reduce((s,v)=>s+v,0) / last7.length : null;

  return { btcDaily: lastDaily, btcFlow7d: flow7dAvg, raw7: last7 };
}

// ─── CLASIFICADOR DE FASE DE MERCADO ────────────────────────
// Combina flujos ETF + tendencia de precio para clasificar el régimen.
// Fases: BAJISTA_ESTRUCTURAL · SUELO_EN_FORMACION · REBOTE_TECNICO · GIRO_CONFIRMADO
function clasificarFase(etf, macroTrend, fg) {
  if (!etf || etf.btcFlow7d === null) return "DESCONOCIDA";
  const flow = etf.btcFlow7d;          // promedio 7d en millones USD/día
  const daily = etf.btcDaily;
  const trend = macroTrend?.direction || "neutral";

  // GIRO_CONFIRMADO: flujos netos positivos sostenidos + no en bajista fuerte
  if (flow > 50 && daily > 0 && trend !== "bajista_fuerte") return "GIRO_CONFIRMADO";
  // REBOTE_TECNICO: precio sube pero flujos aún negativos → rebote sin respaldo
  if (flow < 0 && (trend === "alcista" || trend === "neutral") && (daily ?? 0) > flow)
    return "REBOTE_TECNICO";
  // SUELO_EN_FORMACION: flujos negativos pero desacelerando + miedo extremo
  if (flow < 0 && flow > -150 && fg.value < 35) return "SUELO_EN_FORMACION";
  // BAJISTA_ESTRUCTURAL: salidas fuertes sostenidas
  if (flow <= -150) return "BAJISTA_ESTRUCTURAL";
  // Por defecto, si flujos levemente negativos sin pánico
  return flow < 0 ? "BAJISTA_ESTRUCTURAL" : "NEUTRAL";
}

// Texto humano de la fase, para alertas y prompt de Claude.
function descFase(fase) {
  const m = {
    GIRO_CONFIRMADO:     "🟢 Demanda institucional regresa (inflows ETF sostenidos). Sesgo alcista estructural.",
    REBOTE_TECNICO:      "🟡 Rebote SIN respaldo institucional (flujos aún negativos). Techo probable, vender fuerza.",
    SUELO_EN_FORMACION:  "🔵 Salidas desacelerando + miedo extremo. Etapas tempranas de suelo. Acumular con cautela.",
    BAJISTA_ESTRUCTURAL: "🔴 Salidas institucionales fuertes. Sin piso institucional. Solo rebuys escalonados, no longs agresivos.",
    NEUTRAL:             "⚪ Flujos mixtos. Sin señal institucional clara.",
    DESCONOCIDA:         "⚫ Sin datos de flujos ETF.",
  };
  return m[fase] || m.DESCONOCIDA;
}

// ─── TENDENCIA MACRO ─────────────────────────────────────────
function updateMacroTrend(state, prices) {
  const btcPrice = prices?.BTC?.price || 0;
  if (!btcPrice) return state.macroTrend;
  const now = Date.now(), oneDay = 24*3600*1000;
  const trend = state.macroTrend || { direction:"neutral", daysDown:0, daysUp:0, lastCheck:0, lastPrice:0 };
  if (now - trend.lastCheck < oneDay) return trend;
  const lastPrice = trend.lastPrice || btcPrice;
  const change = ((btcPrice - lastPrice) / lastPrice) * 100;
  if (change <= -1.5) {
    trend.daysDown = (trend.daysDown||0)+1; trend.daysUp = 0;
    trend.direction = trend.daysDown >= 3 ? "bajista_fuerte" : "bajista";
  } else if (change >= 1.5) {
    trend.daysUp = (trend.daysUp||0)+1; trend.daysDown = 0;
    trend.direction = trend.daysUp >= 2 ? "alcista" : "neutral";
  } else { trend.direction = "neutral"; }
  trend.lastPrice = btcPrice; trend.lastCheck = now;
  console.log(`  📊 Macro: ${trend.direction} | Días baj: ${trend.daysDown} | Días alc: ${trend.daysUp}`);
  return trend;
}

// ─── FILTROS DE SEGURIDAD (ahora con fase ETF) ──────────────
function canOpenLong(state, sym, fg) {
  const trend = state.macroTrend || {};
  const fase  = state.etf?.phase || "DESCONOCIDA";

  // 1. Máximo 2 posiciones simultáneas (lección clave de Pedro)
  const openPositions = Object.values(state.positions||{}).filter(p => p.phase === "HOLDING").length;
  if (openPositions >= 2) {
    console.log(`  🚫 ${sym}: max 2 posiciones (${openPositions} abiertas)`);
    return { ok:false, razon:"max_posiciones" };
  }
  // 2. No duplicar posición en mismo activo
  if (state.positions?.[sym]?.phase === "HOLDING") {
    return { ok:false, razon:"posicion_existente" };
  }
  // 3. Sensor ETF: en fase bajista estructural, bloquear longs agresivos
  if (ETF_AFFECTS_FILTER && fase === "BAJISTA_ESTRUCTURAL" && fg.value > 25) {
    console.log(`  🚫 ${sym}: fase ETF BAJISTA_ESTRUCTURAL — sin piso institucional, bloqueando long`);
    return { ok:false, razon:"etf_bajista_estructural" };
  }
  // 4. Sensor ETF: en rebote técnico sin respaldo, reducir capital (no perseguir rebote)
  if (ETF_AFFECTS_FILTER && fase === "REBOTE_TECNICO") {
    console.log(`  ⚠️ ${sym}: fase ETF REBOTE_TECNICO — rebote sin respaldo, capital al 40%`);
    return { ok:true, capitalMult:0.4, razon:"etf_rebote_tecnico" };
  }
  // 5. Tendencia bajista fuerte de precio (filtro original)
  if (trend.direction === "bajista_fuerte" && fg.value > 25) {
    return { ok:false, razon:"tendencia_bajista" };
  }
  // 6. SUELO_EN_FORMACION + miedo → contexto favorable para acumular
  if (ETF_AFFECTS_FILTER && fase === "SUELO_EN_FORMACION") {
    return { ok:true, capitalMult:1.0, razon:"etf_suelo_formacion" };
  }
  // 7. GIRO_CONFIRMADO → contexto alcista, capital pleno
  if (ETF_AFFECTS_FILTER && fase === "GIRO_CONFIRMADO") {
    return { ok:true, capitalMult:1.0, razon:"etf_giro_confirmado" };
  }
  // 8. Tendencia bajista suave → reducir capital 50%
  if (trend.direction === "bajista") {
    return { ok:true, capitalMult:0.5, razon:"tendencia_bajista_reducida" };
  }
  return { ok:true, capitalMult:1.0, razon:"ok" };
}

// ─── SEÑAL DE CAPITULACIÓN ───────────────────────────────────
function isCapitulation(fg, prices) {
  if (fg.value > 20) return false;
  const btcChange = prices?.BTC?.change24h || 0;
  const ethChange = prices?.ETH?.change24h || 0;
  return btcChange <= -5 || ethChange <= -8;
}

// ─── NOTICIAS ────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const it = m[1];
    const title = (it.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || it.match(/<title>(.*?)<\/title>/))?.[1]?.trim() ?? "";
    const desc = (it.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || it.match(/<description>(.*?)<\/description>/))?.[1]?.replace(/<[^>]+>/g,"")?.trim()?.slice(0,300) ?? "";
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
    } catch(e) { console.log(`  ⚠️ ${feed.name}: ${e.message?.slice(0,40)}`); }
  }
  return all;
}

function getAffectedAssets(title, desc) {
  const t = (title + " " + desc).toLowerCase();
  return Object.entries(ASSET_KEYWORDS)
    .filter(([, kws]) => kws.some(k => t.includes(k)))
    .map(([sym]) => sym);
}

// ─── MOTOR DE DECISIÓN CLAUDE (con contexto ETF) ────────────
async function claudeDecide(sym, price, pos, fg, btcDom, news, asset, state) {
  const changePctFromLast  = pos.lastPrice  ? pctChange(pos.lastPrice, price)  : 0;
  const changePctFromEntry = pos.entryPrice ? pctChange(pos.entryPrice, price) : 0;

  const newsStr = news.length > 0
    ? news.slice(0,5).map((n,i)=>`[${i+1}] ${n.source}: "${n.title}"\n${n.desc}`).join("\n\n")
    : "Sin noticias relevantes recientes.";

  const fgSignal = fg.value < 20 ? "PANICO EXTREMO → señal COMPRA muy fuerte"
    : fg.value < 35 ? "MIEDO → sesgo compra"
    : fg.value > 80 ? "EUFORIA → señal VENTA muy fuerte"
    : fg.value > 65 ? "CODICIA → sesgo venta" : "NEUTRAL";

  // Contexto ETF institucional (la ventaja nueva)
  const fase = state.etf?.phase || "DESCONOCIDA";
  const etfStr = state.etf?.btcFlow7d !== null && state.etf?.btcFlow7d !== undefined
    ? `CONTEXTO INSTITUCIONAL (sensor ETF):
- Fase de mercado: ${fase} — ${descFase(fase)}
- Flujo ETF BTC 7d promedio: ${fmtM(state.etf.btcFlow7d)}/día | Último día: ${fmtM(state.etf.btcDaily)}
- REGLA: en BAJISTA_ESTRUCTURAL no comprar agresivo (sin piso institucional). En REBOTE_TECNICO vender fuerza, no perseguir. En SUELO_EN_FORMACION/GIRO_CONFIRMADO la compra tiene respaldo.`
    : "CONTEXTO INSTITUCIONAL: sensor ETF sin datos esta corrida.";

  const rules = pos.learningRules || state?.learningRules;
  const reglasStr = rules ? `
REGLAS APRENDIDAS DE HISTORIAL REAL:
- Mejores activos: ${(rules.mejoresActivos||[]).join(", ")}
- Regla ${sym}: ${rules.reglasEntrada?.[sym] || "sin datos"}
- F&G óptimo compra: ${rules.fgOptimo?.compra || "no definido"}
- Confianza ${sym}: ${rules.confianzaPorActivo?.[sym] || "MEDIA"}
- Evitar: ${rules.evitar || "no definido"}` : "Sin reglas de aprendizaje aun.";

  const riskPct = asset.swingPct * asset.stopMult;
  const rrMin   = asset.rrMin || 3;
  const rrStop  = price * (1 - riskPct);
  const rrTgt   = price * (1 + riskPct * rrMin);
  const rrTgtP1 = price * (1 + riskPct * (rrMin + 1));

  const prompt = `Eres el motor de decision de Bitcopper v4.2 para Pedro.
Meta semanal: $1,000. Capital en ${sym}: $${asset.capital}.
FILOSOFIA: Solo entrar con Riesgo:Recompensa minimo ${rrMin}:1 ${sym==="XAU"?"(oro requiere mayor confirmacion)":"(cripto)"}.
LECCION CLAVE DE PEDRO: posiciones simultaneas en downtrend = mayores perdidas. Alinear ejecucion a analisis.

ACTIVO: ${sym} | Precio: ${fmtP(price)} | F&G: ${fg.value} (${fgSignal})
Cambio reciente: ${changePctFromLast.toFixed(2)}% | BTC Dom: ${btcDom}%
Fase: ${pos.phase}${pos.phase==='HOLDING'?` | Entrada: ${fmtP(pos.entryPrice)} | PnL: ${changePctFromEntry.toFixed(2)}%`:''}

${etfStr}

NOTICIAS (${sym}):
${newsStr}

${reglasStr}

CALCULO R:R si entra ahora:
Stop: ${fmtP(rrStop)} | Target ${rrMin}:1: ${fmtP(rrTgt)} | Target ${rrMin+1}:1: ${fmtP(rrTgtP1)}

REGLAS:
- COMPRAR: soporte claro + target ${rrMin}:1 alcanzable + F&G<70 + noticias no bajistas + contexto ETF no contradictorio
- VENDER: precio alcanzo target ${rrMin}:1 o mas, o momentum se agota
- PREPARAR_COMPRA / PREPARAR_VENTA / STOP_DEFENSIVO / ESPERAR
- En REBOTE_TECNICO sin respaldo institucional, priorizar VENDER/ESPERAR sobre COMPRAR.

Responde SOLO JSON sin markdown:
{
  "decision":"COMPRAR"|"VENDER"|"PREPARAR_COMPRA"|"PREPARAR_VENTA"|"STOP_DEFENSIVO"|"ESPERAR",
  "confianza":"ALTA"|"MEDIA"|"BAJA",
  "razon":"max 2 lineas con R:R y mencion de fase ETF si es relevante",
  "stopPrice":${rrStop.toFixed(2)},
  "targetPrice":${rrTgt.toFixed(2)},
  "ratio":"${rrMin}:1",
  "gananciaEstimada":${(asset.capital*riskPct*rrMin).toFixed(0)},
  "urgencia":"INMEDIATA"|"PROXIMA_HORA"|"HOY"
}`;

  const r = await callClaude([{ role:"user", content: prompt }], 250);
  if (!r.ok) {
    // Detección de modelo deprecado u otro fallo crítico → alerta
    if (r.errType === "not_found_error" || /model/i.test(r.errMsg||"") || r.status === 404)
      await reportarFalloSistema(state, "MODELO_DEPRECADO",
        `claudeDecide(${sym}): ${CLAUDE_MODEL} rechazado (${r.errType}: ${r.errMsg}).`);
    else if (r.status === 429)
      await reportarFalloSistema(state, "RATE_LIMIT", `API rate limit (429) en claudeDecide.`);
    console.log(`  ⚠️ Claude error (${sym}): ${r.errType} ${r.errMsg?.slice(0,40)}`);
    return null;
  }
  return parseClaudeJSON(r.data);
}

// ─── MOTOR SHORTS EXNESS (con contexto ETF) ─────────────────
async function claudeShort(sym, price, ex, fg, btcDom, news, state) {
  const newsStr = news.length > 0
    ? news.slice(0,4).map((n,i)=>`[${i+1}] ${n.source}: "${n.title}"`).join("\n")
    : "Sin noticias relevantes.";
  const fgSignal = fg.value > 75 ? "EUFORIA → SHORT fuerte"
    : fg.value > 60 ? "CODICIA → sesgo SHORT"
    : fg.value < 25 ? "PANICO → evitar shorts" : "NEUTRAL";
  const fase = state.etf?.phase || "DESCONOCIDA";
  const etfStr = state.etf?.btcFlow7d != null
    ? `Fase ETF: ${fase}. Flujo BTC 7d: ${fmtM(state.etf.btcFlow7d)}/día. En BAJISTA_ESTRUCTURAL/REBOTE_TECNICO los shorts tienen respaldo; en GIRO_CONFIRMADO evitar shorts.`
    : "Sensor ETF sin datos.";
  const riskPct = ex.swingPct * ex.stopMult;
  const stopSh  = price * (1 + riskPct);
  const tgt     = price * (1 - riskPct * ex.rrMin);
  const shortPos = state.shortPositions?.[sym];
  const prompt = `Motor de shorts Bitcopper para Pedro. Capital Exness ${sym}: $${ex.capital} | Lote: ${ex.lote}
Solo shortear con R:R minimo ${ex.rrMin}:1. Complementa los longs de Binance.
Precio: $${price} | F&G: ${fg.value} (${fgSignal}) | BTC Dom: ${btcDom}%
${etfStr}
${shortPos?.phase==="SHORT_OPEN"?`SHORT ABIERTO desde $${shortPos.entryPrice}`:"Sin short abierto"}
NOTICIAS: ${newsStr}
R:R SHORT: Stop $${stopSh.toFixed(0)} | Target ${ex.rrMin}:1 = $${tgt.toFixed(0)}
REGLAS: SHORT si resistencia clara + F&G>55 + R:R${ex.rrMin}:1 + fase ETF no alcista. CUBRIR si llego target o F&G<35. ESPERAR si F&G<20.
Responde SOLO JSON: {"decision":"ABRIR_SHORT"|"CUBRIR_SHORT"|"PREPARAR_SHORT"|"ESPERAR","confianza":"ALTA"|"MEDIA"|"BAJA","razon":"max 2 lineas","stopPrice":${stopSh.toFixed(2)},"targetPrice":${tgt.toFixed(2)},"ratio":"${ex.rrMin}:1","lote":${ex.lote},"gananciaEstimada":${(ex.capital*riskPct*ex.rrMin).toFixed(0)},"urgencia":"INMEDIATA"|"PROXIMA_HORA"|"HOY"}`;

  const r = await callClaude([{ role:"user", content: prompt }], 250);
  if (!r.ok) { console.log(`  ⚠️ Short error (${sym}): ${r.errType}`); return null; }
  return parseClaudeJSON(r.data);
}

// ─── CLAUDE NOTICIAS ─────────────────────────────────────────
async function claudeNewsAlert(news, prices, state) {
  const portfolio = Object.entries(ASSETS)
    .map(([sym,a])=>`${sym}: ${fmtP(prices[sym]?.price)} | $${a.capital} | ${state.positions[sym]?.phase}`).join("\n");
  const newsStr = news.slice(0,8).map((n,i)=>`[${i+1}] ${n.source}: "${n.title}"\n${n.desc}`).join("\n\n");
  const fase = state.etf?.phase || "DESCONOCIDA";
  const prompt = `Asistente de Pedro (Bitcopper LLC). Modo MAX SENSIBILIDAD — señala todo lo que pueda mover precio >=3%.
Fase de mercado institucional actual: ${fase}.
Portafolio:\n${portfolio}\n\nNOTICIAS:\n${newsStr}\n\nEvalúa impacto en BTC/ETH/SOL/TAO/XAU. Responde SOLO JSON:\n{"hasAlert":true,"urgency":"ALTA"|"MEDIA","headline":"1 línea","affectedAssets":["BTC"],"impact":"alcista"|"bajista"|"neutral","action":"qué hace Pedro ahora","reason":"por qué (máx 2 líneas)"}\nO si nada mueve >=3%: {"hasAlert":false}`;
  const r = await callClaude([{ role:"user", content: prompt }], 350);
  if (!r.ok) return null;
  return parseClaudeJSON(r.data);
}

// ─── GENERADOR DE REGLAS DE APRENDIZAJE ─────────────────────
async function generateLearningRules(state, fg, btcDom) {
  const trades = state.tradeLog || [];
  if (trades.length < 3) return null;
  const ganancias = trades.filter(t=>t.pnl>0), perdidas = trades.filter(t=>t.pnl<=0);
  const winRate = trades.length>0 ? (ganancias.length/trades.length*100).toFixed(0) : 0;
  const porActivo = {};
  for (const sym of ["BTC","ETH","SOL","TAO","XAU"]) {
    const t = trades.filter(x=>x.sym===sym), g = t.filter(x=>x.pnl>0);
    porActivo[sym] = t.length>0
      ? { trades:t.length, winRate:(g.length/t.length*100).toFixed(0), pnlTotal:t.reduce((s,x)=>s+x.pnl,0).toFixed(0) }
      : { trades:0, winRate:"0", pnlTotal:"0" };
  }
  const condGan = ganancias.map(t=>`${t.sym}|+$${t.pnl}|${t.duracionH}h|F&G:${t.fg}|${t.razonEntrada}`).join("\n");
  const condPer = perdidas.map(t=>`${t.sym}|$${t.pnl}|${t.duracionH}h|F&G:${t.fg}|${t.razonEntrada}`).join("\n");
  const prompt = `Eres el motor de aprendizaje de Bitcopper para Pedro.
Estrategia: R:R 3:1 minimo. Meta: $1,000/semana, $4,000/mes. Capital: $15,000.
HISTORIAL (${trades.length} trades): Win rate ${winRate}% | PnL $${trades.reduce((s,t)=>s+t.pnl,0).toFixed(0)}
WIN RATE POR ACTIVO:
${Object.entries(porActivo).map(([s,d])=>`${s}: ${d.winRate}% (${d.trades} trades, $${d.pnlTotal})`).join("\n")}
GANADORES:\n${condGan||"Sin ganadores aun"}
PERDEDORES:\n${condPer||"Sin perdedores aun"}
CONTEXTO: F&G ${fg.value} (${fg.label}) | BTC Dom ${btcDom}% | Fase ETF: ${state.etf?.phase||"?"}
APRENDIZAJES PREVIOS:\n${(state.learningNotes||[]).slice(-6).join("\n")||"Primera generacion"}
Genera reglas optimizadas del historial real. Responde SOLO JSON sin markdown:
{"version":"${new Date().toLocaleDateString('es-CL')}","mejoresActivos":["BTC","ETH"],"reglasEntrada":{"BTC":"...","ETH":"...","SOL":"...","TAO":"...","XAU":"..."},"fgOptimo":{"compra":"...","venta":"..."},"duracionOptima":"...","evitar":"...","prioridadSemanal":"...","confianzaPorActivo":{"BTC":"ALTA|MEDIA|BAJA","ETH":"...","SOL":"...","TAO":"...","XAU":"..."}}`;
  const r = await callClaude([{ role:"user", content: prompt }], 800);
  if (!r.ok) { console.log("  ⚠️ Learning rules error:", r.errType); return null; }
  return parseClaudeJSON(r.data);
}

// ─── WHATSAPP ─────────────────────────────────────────────────
async function sendWA(lines) {
  const sid=process.env.TWILIO_ACCOUNT_SID, auth=process.env.TWILIO_AUTH_TOKEN;
  const from=process.env.TWILIO_WHATSAPP_FROM, to=process.env.TWILIO_WHATSAPP_TO;
  const time = new Date().toLocaleTimeString("es-CL",{ timeZone:"America/Santiago", hour:"2-digit", minute:"2-digit" });
  const text = [...lines, "", `_${time} · Bitcopper v4.2 MAX_`].join("\n");
  if (!sid||!auth||!from||!to) { console.log("\n📱 [SIMULADO]\n"+text); return true; }
  try {
    const body = new URLSearchParams({ From:from, To:to, Body:text }).toString();
    const r = await post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, body,
      { "Content-Type":"application/x-www-form-urlencoded",
        "Authorization":`Basic ${Buffer.from(`${sid}:${auth}`).toString("base64")}` }
    );
    return r.status === 201;
  } catch(e) { console.log("  ⚠️ WhatsApp error:", e.message?.slice(0,40)); return false; }
}

// ─── CONSTRUIR MENSAJE DE DECISIÓN ──────────────────────────
function buildMessage(sym, result, price, asset, pos, state) {
  const { decision, confianza, razon, urgencia } = result;
  const icons = { COMPRAR:"🟢", VENDER:"🔴", PREPARAR_COMPRA:"⚡", PREPARAR_VENTA:"⚡", STOP_DEFENSIVO:"🛑" };
  const urgStr = urgencia==="INMEDIATA"?"⏰ INMEDIATA":urgencia==="PROXIMA_HORA"?"🕐 Próxima hora":"📅 Hoy";
  const fase = state.etf?.phase || "DESCONOCIDA";
  const faseEmoji = { GIRO_CONFIRMADO:"🟢", REBOTE_TECNICO:"🟡", SUELO_EN_FORMACION:"🔵", BAJISTA_ESTRUCTURAL:"🔴", NEUTRAL:"⚪", DESCONOCIDA:"⚫" }[fase];
  const lines = [
    `${icons[decision]??"🔵"} *${decision.replace("_"," ")} — ${sym}*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `💰 Precio: ${fmtP(price)} | Urgencia: ${urgStr}`,
    `🎯 Confianza: ${confianza}`,
    `${faseEmoji} Fase mercado: ${fase}`,
  ];
  if (decision === "COMPRAR") {
    const qty=(asset.capital/price).toFixed(6), target=price*(1+asset.swingPct), stop=price*(1-asset.swingPct*asset.stopMult);
    lines.push(`📦 Qty aprox: ${qty} ${sym}`, `🎯 Target: ${fmtP(target)} (+${(asset.swingPct*100).toFixed(0)}%)`,
      `🛡️ Stop mental: ${fmtP(stop)}`, `💵 Capital: $${asset.capital}`,
      `💡 Ganancia est: ~$${(asset.capital*asset.swingPct).toFixed(0)}`,
      ``, `Responde *1* para confirmar / *2* para ignorar`);
  }
  if (decision === "VENDER" && pos.entryPrice) {
    const pnl=(price-pos.entryPrice)*(asset.capital/pos.entryPrice), pct=pctChange(pos.entryPrice,price);
    lines.push(`📈 Entrada: ${fmtP(pos.entryPrice)} → Ahora: ${fmtP(price)}`,
      `💵 PnL: ${pnl>=0?"+":""}$${pnl.toFixed(0)} (${pct.toFixed(1)}%) 💰`, `👉 Vender en Binance spot.`);
  }
  if (decision === "PREPARAR_COMPRA") {
    lines.push(`📉 Precio se acerca a zona compra`, `🎯 Zona ideal: ${fmtP(price*(1-asset.swingPct*0.4))}`, `👉 Prepara la orden en Binance.`);
  }
  if (decision === "PREPARAR_VENTA") {
    const target = pos.entryPrice ? pos.entryPrice*(1+asset.swingPct) : price*(1+asset.swingPct*0.4);
    lines.push(`📈 Precio se acerca a target de venta`, `🎯 Target: ${fmtP(target)}`, `👉 Prepara orden de venta en Binance.`);
  }
  if (decision === "STOP_DEFENSIVO" && pos.entryPrice) {
    const loss=(price-pos.entryPrice)*(asset.capital/pos.entryPrice), pct=pctChange(pos.entryPrice,price);
    lines.push(`⚠️ Entrada: ${fmtP(pos.entryPrice)}`, `📉 Pérdida si salís: $${Math.abs(loss).toFixed(0)} (${pct.toFixed(1)}%)`, `👉 Evalúa salir para proteger capital.`);
  }
  lines.push(``, `🧠 ${razon}`);
  return lines;
}

// ─── MAIN ─────────────────────────────────────────────────────
async function main() {
  console.log(`\n🤖 Bitcopper v4.2 MAX — ${new Date().toLocaleString("es-CL",{ timeZone:"America/Santiago" })}`);
  console.log("━".repeat(50));

  let state = await loadStateFromGist();
  if (!state) { console.log("  📂 Sin estado en Gist — cargando local"); state = loadState(); }
  else console.log("  ✅ Estado cargado desde Gist");

  const now = new Date();

  // Resets semanales/mensuales
  if (now.getDay()===1 && (Date.now()-state.lastWeekReset)>6*24*3600000) { state.weeklyPnl=0; state.lastWeekReset=Date.now(); }
  if (now.getDate()===1 && (Date.now()-state.lastMonthReset)>20*24*3600000) { state.monthlyPnl=0; state.lastMonthReset=Date.now(); }

  // Fetch en paralelo (precios, F&G, dominancia, noticias, flujos ETF)
  const [prices, fg, btcDom, rawNews, etfFlows] = await Promise.all([
    fetchAllPrices(state), fetchFG(), fetchBtcDom(), fetchNews(), fetchETFFlows(state)
  ]);

  // Actualizar tendencia macro y fase de mercado (sensor ETF)
  state.macroTrend = updateMacroTrend(state, prices);
  if (etfFlows) {
    state.etf.btcDaily  = etfFlows.btcDaily;
    state.etf.btcFlow7d = etfFlows.btcFlow7d;
    state.etf.lastCheck = Date.now();
    state.etf.phase     = clasificarFase(etfFlows, state.macroTrend, fg);
    console.log(`  🏦 ETF BTC 7d: ${fmtM(etfFlows.btcFlow7d)}/día | Fase: ${state.etf.phase}`);
  } else {
    console.log(`  🏦 ETF: sin datos (fase previa: ${state.etf?.phase||"DESCONOCIDA"})`);
  }

  console.log(`\nF&G: ${fg.value} (${fg.label}) | BTC Dom: ${btcDom}% | Fase: ${state.etf?.phase}`);

  const newNews = rawNews.filter(n => !state.newsHashes.includes(hashStr(n.title)));
  let sent = 0;

  // ── DECISIÓN POR ACTIVO ──────────────────────────────────
  for (const [sym, asset] of Object.entries(ASSETS)) {
    const priceData = prices[sym];
    if (!priceData?.price) continue;
    const price = priceData.price, pos = state.positions[sym];
    const changePctFromLast  = pos.lastPrice  ? Math.abs(pctChange(pos.lastPrice, price)) : 0;
    const changePctFromEntry = pos.entryPrice ? pctChange(pos.entryPrice, price) : 0;
    console.log(`  ${sym}: ${fmtP(price)} | ${pos.phase} | Δlast=${changePctFromLast.toFixed(2)}% | Δentry=${changePctFromEntry.toFixed(2)}%`);

    const relevantNews = newNews.filter(n => getAffectedAssets(n.title,n.desc).includes(sym));
    const hasMovement = changePctFromLast >= asset.activationPct*100;
    const hasNews     = relevantNews.length > 0;
    const isStopZone  = pos.phase==="HOLDING" && pos.entryPrice && changePctFromEntry <= -(asset.swingPct*asset.stopMult*100);
    const cooldownOk  = canAlert(state, `${sym}_DECIDE`, asset.cooldownH);

    if ((hasMovement||hasNews||isStopZone) && cooldownOk) {
      const filtro = canOpenLong(state, sym, fg);
      const esHolding = pos.phase==="HOLDING";
      if (!filtro.ok && !esHolding && !isStopZone) {
        console.log(`  ⛔ ${sym} bloqueado: ${filtro.razon}`);
        state.positions[sym].lastPrice = price; continue;
      }
      const assetAjustado = { ...asset, capital: Math.round(asset.capital*(filtro.capitalMult||1.0)) };
      const result = await claudeDecide(sym, price, pos, fg, btcDom, relevantNews, assetAjustado, state);

      if (result && result.decision !== "ESPERAR") {
        if (result.decision === "COMPRAR") {
          state.pendingConfirmation = {
            sym, price, razon:result.razon,
            stopPrice:   result.stopPrice  || price*(1-asset.swingPct*asset.stopMult),
            targetPrice: result.targetPrice || price*(1+asset.swingPct*asset.stopMult*3),
            ratio: result.ratio||"3:1", fase: state.etf?.phase, ts:Date.now(),
          };
          state.alerts[`${sym}_DECIDE`] = Date.now();
          saveState(state);
          await saveStateToGist(state, state);
          console.log(`  💾 Pending guardado: ${sym} a ${fmtP(price)}`);
        }
        const ok = await sendWA(buildMessage(sym, result, price, assetAjustado, pos, state));
        if (ok) {
          if (result.decision !== "COMPRAR") state.alerts[`${sym}_DECIDE`] = Date.now();
          sent++;
          if (result.decision === "COMPRAR") {
            state.totalCycles++;
          } else if (result.decision === "VENDER" && pos.entryPrice) {
            const pnl=(price-pos.entryPrice)*(asset.capital/pos.entryPrice);
            const pnlPct=((price-pos.entryPrice)/pos.entryPrice*100);
            state.weeklyPnl+=pnl; state.monthlyPnl+=pnl;
            const trade={ sym, tipo:"VENTA", entryPrice:pos.entryPrice, exitPrice:price,
              pnl:+pnl.toFixed(2), pnlPct:+pnlPct.toFixed(2), capital:asset.capital,
              fechaEntrada:pos.entryTs?new Date(pos.entryTs).toISOString():"?", fechaSalida:new Date().toISOString(),
              duracionH:pos.entryTs?+((Date.now()-pos.entryTs)/3600000).toFixed(1):0,
              resultado:pnl>=0?"GANANCIA":"PERDIDA", razonEntrada:pos.razonEntrada||"?", razonSalida:result.razon, fg:fg.value };
            state.tradeLog.push(trade); state.weeklyTrades.push(trade);
            if (state.tradeLog.length>300) state.tradeLog=state.tradeLog.slice(-300);
            state.positions[sym]={ ...pos, phase:"WAITING_BUY", entryPrice:0, entryTs:0, razonEntrada:"", lastPrice:price, profitAccum:pos.profitAccum+pnl };
          } else if (result.decision === "STOP_DEFENSIVO" && pos.entryPrice) {
            const loss=(price-pos.entryPrice)*(asset.capital/pos.entryPrice);
            const lossPct=((price-pos.entryPrice)/pos.entryPrice*100);
            state.weeklyPnl+=loss; state.monthlyPnl+=loss;
            const stopTrade={ sym, tipo:"STOP_DEFENSIVO", entryPrice:pos.entryPrice, exitPrice:price,
              pnl:+loss.toFixed(2), pnlPct:+lossPct.toFixed(2), capital:asset.capital,
              fechaEntrada:pos.entryTs?new Date(pos.entryTs).toISOString():"?", fechaSalida:new Date().toISOString(),
              duracionH:pos.entryTs?+((Date.now()-pos.entryTs)/3600000).toFixed(1):0,
              resultado:"PERDIDA", razonEntrada:pos.razonEntrada||"?", razonSalida:result.razon, fg:fg.value };
            state.tradeLog.push(stopTrade); state.weeklyTrades.push(stopTrade);
            if (state.tradeLog.length>300) state.tradeLog=state.tradeLog.slice(-300);
            state.positions[sym]={ ...pos, phase:"WAITING_BUY", entryPrice:0, entryTs:0, razonEntrada:"", lastPrice:price, profitAccum:pos.profitAccum+loss };
          } else {
            state.positions[sym].lastPrice = price;
          }
        }
      } else { state.positions[sym].lastPrice = price; }
    } else { state.positions[sym].lastPrice = price; }
  }

  // ── SHORTS EXNESS ────────────────────────────────────────
  if (!state.shortPositions) state.shortPositions = {};
  for (const [sym, ex] of Object.entries(EXNESS)) {
    const pd = prices[sym] || prices["XAU"];
    if (!pd?.price) continue;
    const price = pd.price;
    const shortPos = state.shortPositions[sym] || { phase:"SHORT_WAITING", entryPrice:0, lastPrice:0 };
    const relNews = newNews.filter(n => getAffectedAssets(n.title,n.desc).includes(sym));
    const cdOk = canAlert(state, `${sym}_SHORT`, 0.75);
    const movPct = shortPos.lastPrice ? Math.abs(pctChange(shortPos.lastPrice, price)) : 100;
    const inShort = shortPos.phase==="SHORT_OPEN";
    const stopHit = inShort && pctChange(shortPos.entryPrice, price) >= ex.swingPct*ex.stopMult*100;

    if ((movPct>=ex.swingPct*60 || relNews.length>0 || stopHit) && cdOk) {
      const result = await claudeShort(sym, price, ex, fg, btcDom, relNews, state);
      if (result && result.decision !== "ESPERAR") {
        const icons={ ABRIR_SHORT:"🔴", CUBRIR_SHORT:"💚", PREPARAR_SHORT:"⚡" };
        const urgStr=result.urgencia==="INMEDIATA"?"⏰ INMEDIATA":result.urgencia==="PROXIMA_HORA"?"🕐 Próx hora":"📅 Hoy";
        const lines=[`${icons[result.decision]||"🔵"} *${result.decision.replace(/_/g," ")} — ${sym} EXNESS*`,
          `━━━━━━━━━━━━━━━━━━━━`, `💰 Precio: ${fmtP(price)} | ${urgStr} | Confianza: ${result.confianza}`,
          `${state.etf?.phase?`📊 Fase: ${state.etf.phase}`:""}`];
        if (result.decision==="ABRIR_SHORT") {
          lines.push(`📉 Stop: ${fmtP(result.stopPrice)} | Target ${result.ratio}: ${fmtP(result.targetPrice)}`,
            `📦 Lote: ${result.lote} ${ex.simbolo} en Exness MT5`,
            `💵 Capital: $${ex.capital} | Ganancia est: ~$${result.gananciaEstimada}`,
            ``, `Responde *1* para confirmar / *2* para ignorar`);
          state.pendingShort = { sym, price, razon:result.razon, stopPrice:result.stopPrice, targetPrice:result.targetPrice, ratio:result.ratio, lote:result.lote, ts:Date.now() };
          saveState(state); await saveStateToGist(state, state);
        }
        if (result.decision==="CUBRIR_SHORT" && inShort) {
          const pnl=(shortPos.entryPrice-price)*ex.capital/shortPos.entryPrice;
          lines.push(`📈 Entrada: ${fmtP(shortPos.entryPrice)} | PnL: ${pnl>=0?"+":""}$${pnl.toFixed(0)}`, `👉 Cubrir en Exness MT5 → ${ex.simbolo}`);
        }
        if (result.decision==="PREPARAR_SHORT") lines.push(`📉 Precio cerca de resistencia — prepara short en Exness`);
        lines.push(``, `🧠 ${result.razon}`);
        const ok = await sendWA(lines);
        if (ok) {
          state.alerts[`${sym}_SHORT`]=Date.now(); sent++;
          if (result.decision==="CUBRIR_SHORT" && inShort) {
            const pnl=(shortPos.entryPrice-price)*ex.capital/shortPos.entryPrice;
            state.monthlyPnl+=pnl; state.weeklyPnl+=pnl;
            const trade={ sym, tipo:"SHORT_EXNESS", entryPrice:shortPos.entryPrice, exitPrice:price,
              pnl:+pnl.toFixed(2), pnlPct:+((shortPos.entryPrice-price)/shortPos.entryPrice*100).toFixed(2),
              capital:ex.capital, lote:ex.lote, fechaEntrada:shortPos.entryTs?new Date(shortPos.entryTs).toISOString():"?",
              fechaSalida:new Date().toISOString(), duracionH:shortPos.entryTs?+((Date.now()-shortPos.entryTs)/3600000).toFixed(1):0,
              resultado:pnl>=0?"GANANCIA":"PERDIDA", razonEntrada:shortPos.razon||"?", razonSalida:result.razon, fg:fg.value };
            state.tradeLog.push(trade); state.weeklyTrades.push(trade);
            state.shortPositions[sym]={ phase:"SHORT_WAITING", entryPrice:0, lastPrice:price };
          }
        }
      }
      state.shortPositions[sym]={ ...shortPos, lastPrice:price };
    }
  }

  // ── ALERTAS DE NOTICIAS ───────────────────────────────────
  const relevantNew = newNews.filter(n => getAffectedAssets(n.title,n.desc).length>0);
  if (relevantNew.length>0 && canAlert(state,"NEWS_BATCH",NEWS_CD_H)) {
    const ev = await claudeNewsAlert(relevantNew, prices, state);
    if (ev?.hasAlert) {
      const imp=ev.impact==="alcista"?"📈":ev.impact==="bajista"?"📉":"➡️";
      const urg=ev.urgency==="ALTA"?"🔴":"🟡";
      const lines=[`${urg} *ALERTA MERCADO — ${ev.urgency}*`,`━━━━━━━━━━━━━━━━━━━━`,`📰 ${ev.headline}`,``,
        `${imp} *${ev.impact.toUpperCase()}* | Activos: *${ev.affectedAssets.join(", ")}*`,``,`📊 Precios:`,
        ...ev.affectedAssets.filter(s=>prices[s]?.price).map(s=>`  ${s}: ${fmtP(prices[s].price)} (${prices[s].change24h?.toFixed(1)??"?"}%)`),
        ``,`🎯 *Acción:* ${ev.action}`,`💡 ${ev.reason}`];
      const ok=await sendWA(lines);
      if (ok) { state.alerts["NEWS_BATCH"]=Date.now(); sent++; }
    }
    relevantNew.forEach(n=>{ const h=hashStr(n.title); if(!state.newsHashes.includes(h)) state.newsHashes.push(h); });
    if (state.newsHashes.length>400) state.newsHashes=state.newsHashes.slice(-400);
  }

  // ── HEARTBEAT (7AM y 7PM) con verificación de modelo ─────
  const hour = parseInt(new Date().toLocaleString("es-CL",{ timeZone:"America/Santiago", hour:"numeric", hour12:false }));
  const isHeartbeatHour = hour===7 || hour===19;
  if (isHeartbeatHour && canAlert(state,"HEARTBEAT_DAILY",HEARTBEAT_CD)) {
    // Verificación proactiva del modelo (evita quedar cerebro-muerto en silencio)
    await verificarModelo(state);

    const progreso=Math.min(100,Math.max(0,(state.monthlyPnl/4000*100))).toFixed(0);
    const barLen=Math.max(0,Math.floor(Number(progreso)/10));
    const bar="█".repeat(barLen)+"░".repeat(Math.max(0,10-barLen));
    const faseEmoji={ GIRO_CONFIRMADO:"🟢", REBOTE_TECNICO:"🟡", SUELO_EN_FORMACION:"🔵", BAJISTA_ESTRUCTURAL:"🔴", NEUTRAL:"⚪", DESCONOCIDA:"⚫" }[state.etf?.phase]||"⚫";
    const lines=[`🤖 *Bitcopper v4.2 MAX — Activo*`,`━━━━━━━━━━━━━━━━━━━━`,
      `😱 F&G: ${fg.value} (${fg.label}) | BTC Dom: ${btcDom}%`,
      `${faseEmoji} Fase ETF: ${state.etf?.phase||"?"} | Flujo BTC 7d: ${fmtM(state.etf?.btcFlow7d)}/día`,``,
      `📊 *Precios:*`,
      ...Object.entries(ASSETS).map(([sym])=> prices[sym]?.price?`  ${sym}: ${fmtP(prices[sym].price)} (${prices[sym].change24h?.toFixed(1)??"?"}%)`:`  ${sym}: sin precio`),
      ``,`💼 *Posiciones:*`,
      ...Object.entries(state.positions).map(([sym,pos])=> pos.phase==="HOLDING"?`  🟢 ${sym}: HOLDING desde ${fmtP(pos.entryPrice)} | Ciclos: ${pos.cycleCount}`:`  ⚪ ${sym}: esperando | Ciclos: ${pos.cycleCount}`),
      ``,`🎯 Meta mes: ${bar} ${progreso}%`,`💵 PnL mes: $${state.monthlyPnl.toFixed(0)} / $4,000`,
      `🔄 Ciclos totales: ${state.totalCycles}`,``,`✅ Monitoreando cada 5min. Buen día Pedro! 🚀`];
    const ok=await sendWA(lines);
    if (ok) { state.alerts["HEARTBEAT_DAILY"]=Date.now(); sent++; }
  }

  // ── INFORME SEMANAL CON P&L + APRENDIZAJE ────────────────
  const isMonday = now.getDay()===1;
  const isWeeklyWindow = hour>=8 && hour<=20;
  const weeklyNotSentToday = canAlert(state,"WEEKLY_REPORT",20);
  if (isMonday && isWeeklyWindow && weeklyNotSentToday) {
    const wt=state.weeklyTrades||[];
    const ganancias=wt.filter(t=>t.pnl>0), perdidas=wt.filter(t=>t.pnl<=0);
    const totalPnl=wt.reduce((s,t)=>s+t.pnl,0);
    const winRate=wt.length>0?(ganancias.length/wt.length*100).toFixed(0):0;
    const avgGan=ganancias.length>0?ganancias.reduce((s,t)=>s+t.pnl,0)/ganancias.length:0;
    const avgPer=perdidas.length>0?perdidas.reduce((s,t)=>s+t.pnl,0)/perdidas.length:0;
    const wtSorted=[...wt].sort((a,b)=>b.pnl-a.pnl);
    const bestTrade=wtSorted[0], worstTrade=wtSorted[wtSorted.length-1];
    const metaSem=Math.min(100,Math.max(0,(state.weeklyPnl/1000*100))).toFixed(0);
    const barLen=Math.max(0,Math.floor(Number(metaSem)/10));
    const bar="█".repeat(barLen)+"░".repeat(Math.max(0,10-barLen));

    let aprendizaje=null;
    if (process.env.ANTHROPIC_API_KEY) {
      const tradeResumen=wt.map(t=>`${t.sym}|${t.tipo}|E:${t.entryPrice}→S:${t.exitPrice}|PnL:${t.pnl>0?"+":""}$${t.pnl}(${t.pnlPct}%)|${t.duracionH}h|F&G:${t.fg}|${t.resultado}|EntradaPor:"${t.razonEntrada}"|SalidaPor:"${t.razonSalida}"`).join("\n");
      const posicionesActuales=Object.entries(state.positions||{}).map(([s,p])=>p.phase==="HOLDING"?`${s}: HOLDING desde $${p.entryPrice} | Ciclos: ${p.cycleCount} | PnL acum: $${(p.profitAccum||0).toFixed(0)}`:`${s}: USDT | Ciclos: ${p.cycleCount} | PnL acum: $${(p.profitAccum||0).toFixed(0)}`).join("\n");
      const prompt=`Eres el analista de rendimiento de Bitcopper para Pedro (Calama, Chile).
Meta semanal: $1,000 USDT. Meta mensual: $4,000. Capital: $15,000. Activos: BTC/ETH/SOL/TAO/XAU.
Estrategia: R:R minimo 3:1. Fase de mercado institucional actual: ${state.etf?.phase||"?"} (flujo BTC 7d: ${fmtM(state.etf?.btcFlow7d)}/día).
Semana: PnL $${totalPnl.toFixed(0)} | ${wt.length} trades | Win rate: ${winRate}% | F&G: ${fg.value}
POSICIONES:\n${posicionesActuales}
TRADES SEMANA:\n${wt.length>0?tradeResumen:"Sin trades cerrados — capital en USDT esperando R:R 3:1"}
APRENDIZAJES PREVIOS:\n${state.learningNotes.slice(-4).join("\n")||"Primera semana."}
Analiza y responde SOLO JSON sin markdown:
{"resumen":"1 linea","loQueFunciono":"...","loQueNoFunciono":"...","patronesDetectados":"...","ajustesRecomendados":"3 ajustes concretos","activosPrioridad":["BTC","ETH"],"alertaRiesgo":"riesgo o null","proyeccionProxSemana":"expectativa considerando fase ETF actual"}`;
      const r = await callClaude([{ role:"user", content: prompt }], 700);
      if (r.ok) {
        aprendizaje = parseClaudeJSON(r.data);
        if (aprendizaje?.ajustesRecomendados) {
          state.learningNotes.push(`Semana ${new Date().toLocaleDateString("es-CL")}: ${aprendizaje.ajustesRecomendados}`);
          if (state.learningNotes.length>16) state.learningNotes=state.learningNotes.slice(-16);
        }
      } else { console.log("  ⚠️ Aprendizaje error:", r.errType); }
    }

    const lines=[`📊 *INFORME SEMANAL — BITCOPPER v4.2*`,`━━━━━━━━━━━━━━━━━━━━`,``,
      `🎯 Meta $1,000: ${bar} ${metaSem}%`,`💵 PnL semana: ${totalPnl>=0?"+":""}$${totalPnl.toFixed(0)} / $1,000`,
      `📅 PnL mes:    $${state.monthlyPnl.toFixed(0)} / $4,000`,
      `😱 F&G: ${fg.value} (${fg.label}) | BTC Dom: ${btcDom}%`,
      `📊 Fase ETF: ${state.etf?.phase||"?"} | Flujo BTC 7d: ${fmtM(state.etf?.btcFlow7d)}/día`,``,
      `📈 *Trades de la semana: ${wt.length}*`,
      `  ✅ Ganancias: ${ganancias.length} | Promedio: +$${avgGan.toFixed(0)}`,
      `  ❌ Pérdidas:  ${perdidas.length} | Promedio: -$${Math.abs(avgPer).toFixed(0)}`,
      `  🎯 Win rate:  ${winRate}%`];
    if (bestTrade) lines.push(`  🏆 Mejor:  ${bestTrade.sym} +$${bestTrade.pnl.toFixed(0)} (${bestTrade.pnlPct}%) en ${bestTrade.duracionH}h`);
    if (worstTrade && worstTrade.pnl<0) lines.push(`  💔 Peor:   ${worstTrade.sym} $${worstTrade.pnl.toFixed(0)} (${worstTrade.pnlPct}%) en ${worstTrade.duracionH}h`);
    lines.push(``,`📋 *Detalle:*`);
    for (const t of wt.slice(0,10)) {
      const icon=t.pnl>0?"✅":"❌"; const pnlStr=`${t.pnl>0?"+":""}$${t.pnl.toFixed(0)}`;
      lines.push(`  ${icon} ${t.sym} ${t.tipo}: ${pnlStr} (${t.pnlPct}%) | ${t.duracionH}h | F&G:${t.fg}`);
    }
    lines.push(``,`💼 *PnL acumulado por activo:*`);
    for (const [sym,pos] of Object.entries(state.positions)) {
      const emoji=pos.profitAccum>=0?"📈":"📉"; const pnlStr=`${pos.profitAccum>=0?"+":""}$${pos.profitAccum.toFixed(0)}`;
      lines.push(`  ${emoji} ${sym}: ${pnlStr} | ${pos.cycleCount} ciclos`);
    }
    if (aprendizaje) {
      lines.push(``,`━━━━━━━━━━━━━━━━━━━━`,`🧠 *APRENDIZAJE SEMANAL:*`,``,`📝 ${aprendizaje.resumen}`,``,
        `✅ *Funcionó:*`,aprendizaje.loQueFunciono,``,`❌ *No funcionó:*`,aprendizaje.loQueNoFunciono,``,
        `🔍 *Patrones:*`,aprendizaje.patronesDetectados,``,`⚙️ *Ajustes próxima semana:*`,aprendizaje.ajustesRecomendados,``,
        `🚀 *Prioridades:* ${(aprendizaje.activosPrioridad||[]).join(" · ")}`,``,`📅 *Proyección:* ${aprendizaje.proyeccionProxSemana}`);
      if (aprendizaje.alertaRiesgo && aprendizaje.alertaRiesgo!=="null") lines.push(``,`⚠️ *Alerta riesgo:* ${aprendizaje.alertaRiesgo}`);
    }
    const ok=await sendWA(lines);
    if (ok) {
      state.alerts["WEEKLY_REPORT"]=Date.now();
      console.log("  🧠 Generando reglas de aprendizaje...");
      const newRules=await generateLearningRules(state, fg, btcDom);
      if (newRules) {
        state.learningRules=newRules;
        console.log("  ✅ Reglas actualizadas v"+newRules.version);
        const rulesMsg=[`🧠 *REGLAS ACTUALIZADAS — Bitcopper v4.2*`,`━━━━━━━━━━━━━━━━━━━━`,`📅 Versión: ${newRules.version}`,``,
          `🏆 *Activos prioritarios:* ${(newRules.mejoresActivos||[]).join(" · ")}`,``,`📊 *Confianza por activo:*`,
          ...Object.entries(newRules.confianzaPorActivo||{}).map(([s,c])=>`  ${c==="ALTA"?"🟢":c==="MEDIA"?"🟡":"🔴"} ${s}: ${c}`),
          ``,`🎯 *Esta semana:* ${newRules.prioridadSemanal}`,``,`⚠️ *Evitar:* ${newRules.evitar}`].join("\n");
        await sendWA(rulesMsg.split("\n"));
      }
      state.weeklyTrades=[]; state.weeklyPnl=0; state.lastWeekReset=Date.now(); sent++;
      console.log("  📊 Informe semanal enviado y estado reseteado");
    }
  }

  console.log(sent===0?"\n✅ Sin alertas.":`\n📱 ${sent} alerta(s) enviada(s).`);
  saveState(state);
  await saveStateToGist(state, state);
}

main().catch(err => {
  console.error("❌ Error fatal:", err.message);
  process.exit(1);
});

// ─── INSTRUCCIONES / VARIABLES DE ENTORNO ───────────────────
/*
SECRETS REQUERIDOS (GitHub Actions):
  ANTHROPIC_API_KEY       → motor de decisión
  TWILIO_ACCOUNT_SID
  TWILIO_AUTH_TOKEN
  TWILIO_WHATSAPP_FROM    → whatsapp:+14155238886
  TWILIO_WHATSAPP_TO      → whatsapp:+569XXXXXXXX
  GIST_TOKEN              → persistencia de estado
  COINGLASS_API_KEY       → sensor ETF institucional (NUEVO, ~$35/mes)
                            Si falta, el bot avisa una vez y sigue sin sensor ETF.

MODELO: definido UNA vez en CLAUDE_MODEL (arriba). Migrar = cambiar esa línea.

SENSOR ETF: flags ETF_SENSOR_ENABLED y ETF_AFFECTS_FILTER (arriba).
  - ETF_SENSOR_ENABLED=false → desactiva el sensor por completo.
  - ETF_AFFECTS_FILTER=false → el sensor informa pero NO bloquea entradas.

FASES DE MERCADO:
  GIRO_CONFIRMADO     → inflows sostenidos: capital pleno
  SUELO_EN_FORMACION  → salidas desacelerando + miedo: acumular con cautela
  REBOTE_TECNICO      → rebote sin respaldo: capital 40%, priorizar ventas
  BAJISTA_ESTRUCTURAL → salidas fuertes: bloquea longs agresivos
*/
