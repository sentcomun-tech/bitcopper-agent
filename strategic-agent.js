// Bitcopper Strategic Investment Assistant
// Asistente estratégico personal de Pedro — Bitcopper Technologies LLC
// Combina: precios en vivo + estado del ciclo + razonamiento Claude + WhatsApp

const https = require("https");
const fs    = require("fs");

// ─── PERFIL DEL INVERSOR ───────────────────────────────────
const INVESTOR = {
  name:     "Pedro",
  goal:     "$4,000 USD adicionales por mes",
  capital:  10000,
  style:    "Swing trading spot — comprar en soporte, vender en resistencia",
  risk:     "Moderado-agresivo. Stop loss siempre activo.",
  company:  "Bitcopper Technologies LLC — Calama, Chile",
};

const ASSETS = {
  ETH: {
    cgId: "ethereum",  qty: 1.2544,   avgCost: 2067.16,
    buyZone:  { min: 1900,  max: 2050  }, sellZone: { min: 2200,  max: 2350  }, stop: 1750,
  },
  TAO: {
    cgId: "bittensor", qty: 7.21819,  avgCost: 315.10,
    buyZone:  { min: 265,   max: 310   }, sellZone: { min: 360,   max: 420   }, stop: 240,
  },
  SOL: {
    cgId: "solana",    qty: 15.87655, avgCost: 96.52,
    buyZone:  { min: 70,    max: 88    }, sellZone: { min: 105,   max: 125   }, stop: 65,
  },
  BTC: {
    cgId: "bitcoin",   qty: 0.00751,  avgCost: 67926.34,
    buyZone:  { min: 60000, max: 68000 }, sellZone: { min: 78000, max: 85000 }, stop: 57000,
  },
};

const PHASE = { HOLDING: "HOLDING", WAITING_BUY: "WAITING_BUY" };
const STATE_FILE = "/tmp/bitcopper_strategic_state.json";

// ─── HELPERS ───────────────────────────────────────────────
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "BitcopperStrategicAgent/2.0" } }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on("error", reject);
  });
}

function post(url, payload, headers) {
  return new Promise((resolve, reject) => {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: { "Content-Length": Buffer.byteLength(body), ...headers },
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch {
    const state = { alerts: {}, cycles: {}, history: [], weeklyPnl: 0, monthlyPnl: 0, lastWeekReset: Date.now(), lastMonthReset: Date.now() };
    for (const sym of Object.keys(ASSETS)) {
      state.cycles[sym] = { phase: PHASE.HOLDING, entryPrice: ASSETS[sym].avgCost, cycleCount: 1, profitAccum: 0 };
    }
    return state;
  }
}

function saveState(state) { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

function canAlert(state, key, cooldownH = 3) {
  const last = state.alerts[key];
  return !last || (Date.now() - last) / 3600000 >= cooldownH;
}

function fmtPrice(price) {
  return price >= 1000
    ? `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : `$${price.toFixed(2)}`;
}

function fmtPnl(entry, current, qty) {
  const usd = (current - entry) * qty;
  const pct = ((current - entry) / entry * 100).toFixed(1);
  return `${usd >= 0 ? "+" : ""}$${Math.abs(usd).toFixed(0)} (${pct >= 0 ? "+" : ""}${pct}%)`;
}

// ─── FETCH DATA ────────────────────────────────────────────
async function fetchAll() {
  const ids = Object.values(ASSETS).map(a => a.cgId).join(",");
  const [priceData, fgData, globalData] = await Promise.all([
    get(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_7d_change=true`),
    get("https://api.alternative.me/fng/?limit=1").catch(() => ({ data: [{ value: "?", value_classification: "Unknown" }] })),
    get("https://api.coingecko.com/api/v3/global").catch(() => ({ data: { market_cap_percentage: { btc: 0 } } })),
  ]);

  const prices = {};
  for (const [sym, info] of Object.entries(ASSETS)) {
    prices[sym] = {
      price:     priceData[info.cgId]?.usd            ?? 0,
      change24h: priceData[info.cgId]?.usd_24h_change ?? 0,
      change7d:  priceData[info.cgId]?.usd_7d_change  ?? 0,
    };
  }

  return {
    prices,
    fg:     { value: fgData.data[0].value, label: fgData.data[0].value_classification },
    btcDom: globalData.data?.market_cap_percentage?.btc?.toFixed(1) ?? "?",
  };
}

// ─── CLAUDE STRATEGIC ANALYSIS ────────────────────────────
async function getStrategicAnalysis(prices, fg, btcDom, state, triggerType, triggerSym) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  // Construir contexto completo del portafolio
  const portfolioLines = Object.entries(ASSETS).map(([sym, info]) => {
    const p     = prices[sym];
    const cycle = state.cycles[sym];
    const value = p.price * info.qty;
    const pnl   = ((p.price - info.avgCost) / info.avgCost * 100).toFixed(1);
    return `${sym}: ${fmtPrice(p.price)} | 24h:${p.change24h.toFixed(1)}% | 7d:${p.change7d.toFixed(1)}% | Fase:${cycle.phase} | Ciclos:${cycle.cycleCount} | PnL acum:${pnl}% | Valor:$${value.toFixed(0)}`;
  }).join("\n");

  const totalValue = Object.entries(ASSETS).reduce((s, [sym, info]) => s + prices[sym].price * info.qty, 0);
  const totalCost  = Object.entries(ASSETS).reduce((s, [, info]) => s + info.avgCost * info.qty, 0);
  const totalPnl   = ((totalValue - totalCost) / totalCost * 100).toFixed(1);

  const systemPrompt = `Eres el asistente estratégico de inversiones personal de ${INVESTOR.name}, fundador de ${INVESTOR.company}.

Tu rol: analista cripto senior de confianza. Conoces perfectamente su portafolio, sus objetivos y su estilo. Eres directo, preciso y útil. Nunca genérico.

PERFIL DEL INVERSOR:
- Objetivo: ${INVESTOR.goal}
- Estilo: ${INVESTOR.style}
- Tolerancia al riesgo: ${INVESTOR.risk}
- Capital total: $${INVESTOR.capital.toLocaleString()} USD

PORTAFOLIO ACTUAL:
${portfolioLines}

MERCADO:
- Fear & Greed: ${fg.value} (${fg.label})
- BTC Dominance: ${btcDom}%
- Portafolio total: $${totalValue.toFixed(0)} | PnL: ${totalPnl}%
- PnL semanal acumulado: $${state.weeklyPnl.toFixed(0)}
- PnL mensual acumulado: $${state.monthlyPnl.toFixed(0)} / objetivo $4,000

TARGETS POR ACTIVO:
- ETH: compra $1,900–$2,050 | venta $2,200–$2,350 | stop $1,750
- TAO: compra $265–$310 | venta $360–$420 | stop $240
- SOL: compra $70–$88 | venta $105–$125 | stop $65
- BTC: compra $60,000–$68,000 | venta $78,000–$85,000 | stop $57,000

Responde siempre en español. Sé conciso (máx 5 líneas de análisis). Usa datos reales del portafolio.`;

  const triggerContext = triggerSym
    ? `El precio de ${triggerSym} acaba de activar una señal: ${triggerType}. Da tu análisis estratégico específico para esta situación y qué impacto tiene en el portafolio completo. ¿Hay algo más que Pedro deba considerar en los otros activos dado este movimiento?`
    : `Es la revisión periódica del portafolio. ¿Cuál es tu lectura estratégica del momento actual? ¿Hay algo relevante que Pedro deba saber o hacer esta semana?`;

  try {
    const r = await post("https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: triggerContext }],
      },
      { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    );
    return r.body?.content?.[0]?.text ?? null;
  } catch { return null; }
}

// ─── SEND WHATSAPP ─────────────────────────────────────────
async function sendWhatsApp(lines) {
  const sid  = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const to   = process.env.TWILIO_WHATSAPP_TO;

  const time = new Date().toLocaleTimeString("es-CL", { timeZone: "America/Santiago", hour: "2-digit", minute: "2-digit" });
  const text = [...lines, "", `_${time} · Bitcopper Strategic Agent_`].join("\n");

  if (!sid || !auth || !from || !to) {
    console.log("\n📱 [SIMULADO]\n" + "─".repeat(40) + "\n" + text + "\n" + "─".repeat(40));
    return true;
  }

  const body  = new URLSearchParams({ From: from, To: to, Body: text }).toString();
  const creds = Buffer.from(`${sid}:${auth}`).toString("base64");
  const r = await post(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    body,
    { "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Basic ${creds}` }
  );
  return r.status === 201;
}

// ─── BUILD ALERT MESSAGES ──────────────────────────────────
function buildCycleAlert(sym, type, price, cycle, asset, analysis) {
  const analysisBlock = analysis ? [``, `🧠 *Análisis estratégico:*`, analysis] : [];

  const templates = {
    NEAR_SELL: [
      `⚡ *${sym} — PREPARA VENTA*`,
      `Precio: ${fmtPrice(price)} → target ${fmtPrice(asset.sellZone.min)}`,
      `Faltan: ${((asset.sellZone.min - price) / price * 100).toFixed(1)}%`,
      `PnL posición: ${fmtPnl(cycle.entryPrice, price, asset.qty)}`,
      ``,
      `👉 Abre Binance y prepara la orden de venta.`,
      ...analysisBlock,
    ],
    SELL: [
      `🔴 *VENDER ${sym} — ZONA ALCANZADA*`,
      `Precio: ${fmtPrice(price)} ✓ zona ${fmtPrice(asset.sellZone.min)}–${fmtPrice(asset.sellZone.max)}`,
      `Profit estimado: ${fmtPnl(cycle.entryPrice, price, asset.qty)} 💰`,
      `Ciclo #${cycle.cycleCount} completado.`,
      ``,
      `👉 Vender en Binance spot ahora.`,
      `Próximo ciclo: recomprar en ${fmtPrice(asset.buyZone.min)}–${fmtPrice(asset.buyZone.max)}`,
      ...analysisBlock,
    ],
    NEAR_BUY: [
      `⚡ *${sym} — PREPARA COMPRA*`,
      `Precio: ${fmtPrice(price)} → zona ${fmtPrice(asset.buyZone.min)}–${fmtPrice(asset.buyZone.max)}`,
      `Profit esperado al vender: ~${((asset.sellZone.min - asset.buyZone.max) / asset.buyZone.max * 100).toFixed(1)}%`,
      ``,
      `👉 Abre Binance y prepara la orden de compra.`,
      ...analysisBlock,
    ],
    BUY: [
      `🟢 *COMPRAR ${sym} — ZONA ALCANZADA*`,
      `Precio: ${fmtPrice(price)} ✓ zona ${fmtPrice(asset.buyZone.min)}–${fmtPrice(asset.buyZone.max)}`,
      `Target venta: ${fmtPrice(asset.sellZone.min)} (+${((asset.sellZone.min - price) / price * 100).toFixed(1)}%)`,
      `Stop loss: ${fmtPrice(asset.stop)}`,
      ``,
      `👉 Comprar en Binance spot ahora.`,
      ...analysisBlock,
    ],
    STOP: [
      `🛑 *STOP LOSS — ${sym}*`,
      `Precio: ${fmtPrice(price)} ≤ stop ${fmtPrice(asset.stop)}`,
      `PnL: ${fmtPnl(cycle.entryPrice, price, asset.qty)}`,
      ``,
      `👉 Salir en Binance. Siguiente entrada: ${fmtPrice(asset.buyZone.min)}–${fmtPrice(asset.buyZone.max)}`,
      ...analysisBlock,
    ],
  };

  return templates[type] || [];
}

// ─── WEEKLY REPORT ─────────────────────────────────────────
async function buildWeeklyReport(prices, fg, btcDom, state, analysis) {
  const totalValue = Object.entries(ASSETS).reduce((s, [sym, info]) => s + prices[sym].price * info.qty, 0);
  const totalCost  = Object.entries(ASSETS).reduce((s, [, info]) => s + info.avgCost * info.qty, 0);
  const totalPnl   = totalValue - totalCost;
  const progress   = Math.min(100, (state.monthlyPnl / 4000 * 100)).toFixed(0);

  const lines = [
    `📊 *INFORME SEMANAL — BITCOPPER*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `F&G: ${fg.value} (${fg.label}) | BTC Dom: ${btcDom}%`,
    ``,
    `💼 *PORTAFOLIO*`,
    `Total: $${totalValue.toFixed(0)} | PnL: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(0)}`,
    `PnL semana: $${state.weeklyPnl.toFixed(0)}`,
    `Avance mensual: $${state.monthlyPnl.toFixed(0)} / $4,000 (${progress}%)`,
    ``,
    `📌 *ACTIVOS*`,
  ];

  for (const [sym, info] of Object.entries(ASSETS)) {
    const p     = prices[sym];
    const cycle = state.cycles[sym];
    const pnlUsd = (p.price - info.avgCost) * info.qty;
    const signal = p.price >= info.sellZone.min ? "🔴 VENDER"
                 : p.price <= info.buyZone.max  ? "🟢 COMPRAR"
                 : "🟡 HOLD";
    lines.push(`${sym}: ${fmtPrice(p.price)} | ${signal} | Ciclo #${cycle.cycleCount} | PnL ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(0)}`);
  }

  if (analysis) {
    lines.push(``, `━━━━━━━━━━━━━━━━━━━━`, `🧠 *Análisis estratégico semanal:*`, ``, analysis);
  }

  return lines;
}

// ─── MAIN ──────────────────────────────────────────────────
async function main() {
  const time = new Date().toLocaleTimeString("es-CL", { timeZone: "America/Santiago" });
  console.log(`🤖 Bitcopper Strategic Agent — ${time}`);

  const state = loadState();
  const { prices, fg, btcDom } = await fetchAll();

  // Reset PnL semanal (lunes)
  const now = new Date();
  if (now.getDay() === 1 && (Date.now() - state.lastWeekReset) > 6 * 24 * 3600000) {
    console.log("📅 Reset PnL semanal");
    state.weeklyPnl = 0;
    state.lastWeekReset = Date.now();
  }
  // Reset PnL mensual
  if (now.getDate() === 1 && (Date.now() - state.lastMonthReset) > 20 * 24 * 3600000) {
    console.log("📅 Reset PnL mensual");
    state.monthlyPnl = 0;
    state.lastMonthReset = Date.now();
  }

  let triggered = false;

  // ── Revisar ciclos ──
  for (const [sym, asset] of Object.entries(ASSETS)) {
    const { price } = prices[sym];
    if (!price) continue;

    const cycle = state.cycles[sym];
    console.log(`  ${sym}: ${fmtPrice(price)} | ${cycle.phase} | Ciclo #${cycle.cycleCount}`);

    let alertType = null;

    if (cycle.phase === PHASE.HOLDING) {
      if (price <= asset.stop && canAlert(state, `${sym}_STOP`)) alertType = "STOP";
      else if (price >= asset.sellZone.min && canAlert(state, `${sym}_SELL`)) alertType = "SELL";
      else if (((asset.sellZone.min - price) / price * 100) <= 1.5 && canAlert(state, `${sym}_NEAR_SELL`)) alertType = "NEAR_SELL";
    }
    else if (cycle.phase === PHASE.WAITING_BUY) {
      if (price <= asset.buyZone.max && price >= asset.buyZone.min && canAlert(state, `${sym}_BUY`)) alertType = "BUY";
      else if (((asset.buyZone.max - price) / price * 100) <= 1.5 && price > asset.buyZone.max && canAlert(state, `${sym}_NEAR_BUY`)) alertType = "NEAR_BUY";
    }

    if (alertType) {
      console.log(`  📱 Activando: ${sym}_${alertType}`);
      const analysis = await getStrategicAnalysis(prices, fg, btcDom, state, alertType, sym);
      const lines    = buildCycleAlert(sym, alertType, price, cycle, asset, analysis);
      const ok       = await sendWhatsApp(lines);

      if (ok) {
        state.alerts[`${sym}_${alertType}`] = Date.now();
        triggered = true;

        // Actualizar ciclo
        if (alertType === "SELL") {
          const profit = (price - cycle.entryPrice) * asset.qty;
          state.weeklyPnl  += profit;
          state.monthlyPnl += profit;
          state.history.push({ sym, type: "SELL", price, profit, date: new Date().toISOString() });
          state.cycles[sym] = { phase: PHASE.WAITING_BUY, cycleCount: cycle.cycleCount, profitAccum: cycle.profitAccum + profit };
        }
        else if (alertType === "BUY") {
          state.history.push({ sym, type: "BUY", price, date: new Date().toISOString() });
          state.cycles[sym] = { phase: PHASE.HOLDING, entryPrice: price, cycleCount: cycle.cycleCount + 1, profitAccum: cycle.profitAccum };
        }
        else if (alertType === "STOP") {
          const loss = (price - cycle.entryPrice) * asset.qty;
          state.weeklyPnl  += loss;
          state.monthlyPnl += loss;
          state.cycles[sym] = { phase: PHASE.WAITING_BUY, cycleCount: cycle.cycleCount, profitAccum: cycle.profitAccum + loss };
        }
      }
    }
  }

  // ── Informe semanal (lunes 08:00 Santiago) ──
  const isMonday8am = now.getDay() === 1 && now.getHours() >= 10 && now.getHours() <= 12;
  if (isMonday8am && canAlert(state, "WEEKLY_REPORT", 120)) {
    console.log("📊 Generando informe semanal...");
    const analysis = await getStrategicAnalysis(prices, fg, btcDom, state, "WEEKLY", null);
    const lines    = await buildWeeklyReport(prices, fg, btcDom, state, analysis);
    const ok       = await sendWhatsApp(lines);
    if (ok) state.alerts["WEEKLY_REPORT"] = Date.now();
    triggered = true;
  }

  if (!triggered) console.log("✅ Sin alertas — portafolio en zona neutral.");

  saveState(state);
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
