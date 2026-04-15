// server.js — Bitcopper Webhook Server para Railway
// Servidor HTTP permanente que recibe respuestas 1/2 de WhatsApp

const https = require("https");
const http  = require("http");

const GIST_ID   = "fcb66e3c3aa96220b17040fd72295fab";
const GIST_FILE = "state.json";
const PORT      = process.env.PORT || 3000;

// ─── HELPERS ─────────────────────────────────────────────────
function httpRequest(url, method = "GET", payload = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method,
      headers:  { "User-Agent": "BitcopperWebhook/1.0", ...headers },
    };
    if (payload) {
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      options.headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = https.request(options, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(typeof payload === "string" ? payload : JSON.stringify(payload));
    req.end();
  });
}

async function loadGist(token) {
  try {
    const r = await httpRequest(
      `https://api.github.com/gists/${GIST_ID}`,
      "GET", null,
      { "Authorization": `token ${token}`, "Accept": "application/vnd.github.v3+json" }
    );
    const content = r.body?.files?.[GIST_FILE]?.content;
    return content ? JSON.parse(content) : null;
  } catch(e) {
    console.error("Gist load error:", e.message);
    return null;
  }
}

async function saveGist(token, state) {
  try {
    await httpRequest(
      `https://api.github.com/gists/${GIST_ID}`,
      "PATCH",
      { files: { [GIST_FILE]: { content: JSON.stringify(state, null, 2) } } },
      { "Authorization": `token ${token}`, "Content-Type": "application/json",
        "Accept": "application/vnd.github.v3+json" }
    );
  } catch(e) {
    console.error("Gist save error:", e.message);
  }
}

async function sendWA(sid, auth, from, to, message) {
  try {
    const body = new URLSearchParams({ From: from, To: to, Body: message }).toString();
    await httpRequest(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      "POST", body,
      {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${Buffer.from(`${sid}:${auth}`).toString("base64")}`,
      }
    );
  } catch(e) {
    console.error("WhatsApp error:", e.message);
  }
}

function fmtP(p) {
  if (!p) return "$0";
  return p >= 1000
    ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : `$${p.toFixed(2)}`;
}

// ─── PROCESAR BODY ───────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => body += chunk.toString());
    req.on("end", () => resolve(body));
  });
}

// ─── HANDLER ─────────────────────────────────────────────────
async function handleWebhook(req, res) {
  const GIST_TOKEN    = process.env.GIST_TOKEN;
  const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH   = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_FROM   = process.env.TWILIO_WHATSAPP_FROM;
  const TWILIO_TO     = process.env.TWILIO_WHATSAPP_TO;

  const rawBody = await parseBody(req);
  const params  = new URLSearchParams(rawBody);
  const msgBody = (params.get("Body") || "").trim();

  console.log(`📨 Mensaje recibido: "${msgBody}"`);

  if (!GIST_TOKEN) {
    console.error("Sin GIST_TOKEN");
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end("<Response></Response>");
  }

  const state = await loadGist(GIST_TOKEN);
  if (!state) {
    res.writeHead(200, { "Content-Type": "text/xml" });
    return res.end("<Response></Response>");
  }

  const ASSET_CONFIG = {
    BTC: { capital: 4500, swingPct: 0.04, stopMult: 1.8 },
    ETH: { capital: 3500, swingPct: 0.05, stopMult: 1.8 },
    SOL: { capital: 2500, swingPct: 0.06, stopMult: 1.7 },
    TAO: { capital: 2000, swingPct: 0.07, stopMult: 1.7 },
    XAU: { capital: 2500, swingPct: 0.04, stopMult: 1.6 },
  };

  const pending = state.pendingConfirmation;

  if (msgBody === "1" && pending) {
    // ✅ CONFIRMÓ COMPRA
    const { sym, price, razon } = pending;
    const asset = ASSET_CONFIG[sym];
    if (!asset) {
      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end("<Response></Response>");
    }

    const target   = price * (1 + asset.swingPct);
    const stop     = price * (1 - asset.swingPct * asset.stopMult);
    const ganancia = asset.capital * asset.swingPct;

    if (!state.positions) state.positions = {};
    state.positions[sym] = {
      ...(state.positions[sym] || {}),
      phase:        "HOLDING",
      entryPrice:   price,
      entryTs:      Date.now(),
      razonEntrada: razon || "Confirmado manualmente",
      lastPrice:    price,
      cycleCount:   (state.positions[sym]?.cycleCount || 0) + 1,
    };
    state.pendingConfirmation = null;

    await saveGist(GIST_TOKEN, state);

    const msg = [
      `✅ *COMPRA REGISTRADA — ${sym}*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `💰 Entrada: ${fmtP(price)}`,
      `🎯 Target venta: ${fmtP(target)} (+${(asset.swingPct*100).toFixed(0)}%)`,
      `🛡️ Stop mental: ${fmtP(stop)}`,
      `💵 Ganancia estimada: ~$${ganancia.toFixed(0)}`,
      ``,
      `📌 Pon orden límite venta en Binance: ${fmtP(target)}`,
      `🤖 El bot monitorea y avisa cuando llegue.`,
    ].join("\n");

    await sendWA(TWILIO_SID, TWILIO_AUTH, TWILIO_FROM, TWILIO_TO, msg);
    console.log(`✅ Compra registrada: ${sym} a ${fmtP(price)}`);

  } else if (msgBody === "2" && pending) {
    // ❌ IGNORÓ SEÑAL
    state.pendingConfirmation = null;
    await saveGist(GIST_TOKEN, state);
    await sendWA(TWILIO_SID, TWILIO_AUTH, TWILIO_FROM, TWILIO_TO,
      `⏭️ Señal ${pending.sym} ignorada. El bot sigue monitoreando.`);

  } else if (msgBody.toUpperCase().startsWith("ENTRADA ")) {
    // Comando manual: ENTRADA BTC 67153
    const parts = msgBody.split(" ");
    if (parts.length === 3) {
      const sym   = parts[1].toUpperCase();
      const price = parseFloat(parts[2]);
      const asset = ASSET_CONFIG[sym];

      if (asset && price > 0) {
        const target   = price * (1 + asset.swingPct);
        const stop     = price * (1 - asset.swingPct * asset.stopMult);
        const ganancia = asset.capital * asset.swingPct;

        if (!state.positions) state.positions = {};
        state.positions[sym] = {
          ...(state.positions[sym] || {}),
          phase:        "HOLDING",
          entryPrice:   price,
          entryTs:      Date.now(),
          razonEntrada: "Entrada manual via WhatsApp",
          lastPrice:    price,
          cycleCount:   (state.positions[sym]?.cycleCount || 0) + 1,
        };

        await saveGist(GIST_TOKEN, state);

        const msg = [
          `✅ *ENTRADA MANUAL — ${sym}*`,
          `💰 Precio: ${fmtP(price)}`,
          `🎯 Target: ${fmtP(target)} (+${(asset.swingPct*100).toFixed(0)}%)`,
          `🛡️ Stop: ${fmtP(stop)}`,
          `💵 Ganancia est: ~$${ganancia.toFixed(0)}`,
        ].join("\n");

        await sendWA(TWILIO_SID, TWILIO_AUTH, TWILIO_FROM, TWILIO_TO, msg);
        console.log(`✅ Entrada manual: ${sym} a ${fmtP(price)}`);
      }
    }

  } else if (msgBody.toUpperCase().startsWith("SALIDA ")) {
    // Comando: SALIDA BTC 89500 — cierra trade y registra en historial
    const parts = msgBody.split(" ");
    if (parts.length === 3) {
      const sym      = parts[1].toUpperCase();
      const exitPrice = parseFloat(parts[2]);
      const pos      = state.positions?.[sym];

      if (pos && pos.phase === "HOLDING" && pos.entryPrice && exitPrice > 0) {
        const capital  = ASSET_CONFIG[sym]?.capital || 0;
        const pnl      = (exitPrice - pos.entryPrice) * (capital / pos.entryPrice);
        const pnlPct   = ((exitPrice - pos.entryPrice) / pos.entryPrice * 100);
        const durH     = pos.entryTs ? +((Date.now() - pos.entryTs) / 3600000).toFixed(1) : 0;
        const resultado = pnl >= 0 ? "GANANCIA" : "PERDIDA";

        // Registrar trade en historial
        const trade = {
          sym, tipo: "SALIDA_MANUAL",
          entryPrice: pos.entryPrice,
          exitPrice,
          pnl:        +pnl.toFixed(2),
          pnlPct:     +pnlPct.toFixed(2),
          capital,
          fechaEntrada: pos.entryTs ? new Date(pos.entryTs).toISOString() : "?",
          fechaSalida:  new Date().toISOString(),
          duracionH:    durH,
          resultado,
          razonEntrada: pos.razonEntrada || "manual",
          razonSalida:  durH <= 3 ? "salida por momentum/lateral" : "salida manual",
          fg:           0,
        };

        if (!state.tradeLog)    state.tradeLog    = [];
        if (!state.weeklyTrades) state.weeklyTrades = [];
        state.tradeLog.push(trade);
        state.weeklyTrades.push(trade);
        if (state.tradeLog.length > 300) state.tradeLog = state.tradeLog.slice(-300);

        // Actualizar PnL
        state.monthlyPnl = (state.monthlyPnl || 0) + pnl;
        state.weeklyPnl  = (state.weeklyPnl  || 0) + pnl;

        // Cerrar posición
        state.positions[sym] = {
          ...pos,
          phase:       "WAITING_BUY",
          entryPrice:  0,
          entryTs:     0,
          targetPrice: 0,
          razonEntrada: "",
          lastPrice:   exitPrice,
          profitAccum: (pos.profitAccum || 0) + pnl,
        };

        await saveGist(GIST_TOKEN, state);

        const icon = pnl >= 0 ? "💰" : "📉";
        const msg = [
          `${icon} *TRADE CERRADO — ${sym}*`,
          `━━━━━━━━━━━━━━━━━━━━`,
          `📈 Entrada: ${fmtP(pos.entryPrice)}`,
          `📉 Salida:  ${fmtP(exitPrice)}`,
          `💵 PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)} (${pnlPct.toFixed(1)}%)`,
          `⏱️ Duración: ${durH}h`,
          ``,
          `📊 PnL mes: $${(state.monthlyPnl||0).toFixed(0)} / $4,000`,
          `🤖 ${sym} vuelve a modo ESPERA — monitoreando próxima entrada.`,
        ].join("\n");

        await sendWA(TWILIO_SID, TWILIO_AUTH, TWILIO_FROM, TWILIO_TO, msg);
        console.log(`✅ Trade cerrado: ${sym} | PnL: $${pnl.toFixed(0)}`);
      } else {
        await sendWA(TWILIO_SID, TWILIO_AUTH, TWILIO_FROM, TWILIO_TO,
          `⚠️ No tienes posición HOLDING en ${sym}`);
      }
    }

  } else if (msgBody.toUpperCase().startsWith("VENTA ")) {
    // Comando: VENTA BTC 90000 — registra target de venta
    const parts = msgBody.split(" ");
    if (parts.length === 3) {
      const sym    = parts[1].toUpperCase();
      const target = parseFloat(parts[2]);
      if (sym && target > 0 && state.positions?.[sym]) {
        state.positions[sym].targetPrice = target;
        await saveGist(GIST_TOKEN, state);
        const entry = state.positions[sym].entryPrice || 0;
        const gain  = entry > 0 ? ((target - entry) / entry * 100).toFixed(1) : "?";
        const msg = [
          `🎯 *TARGET REGISTRADO — ${sym}*`,
          `━━━━━━━━━━━━━━━━━━━━`,
          `💰 Entrada: ${fmtP(entry)}`,
          `🎯 Venta target: ${fmtP(target)} (+${gain}%)`,
          `🤖 El bot avisa cuando el precio se acerque.`,
        ].join("\n");
        await sendWA(TWILIO_SID, TWILIO_AUTH, TWILIO_FROM, TWILIO_TO, msg);
        console.log(`🎯 Target registrado: ${sym} → ${fmtP(target)}`);
      } else {
        await sendWA(TWILIO_SID, TWILIO_AUTH, TWILIO_FROM, TWILIO_TO,
          `⚠️ No tienes posición abierta en ${parts[1]?.toUpperCase() || "?"}`);
      }
    }

  } else if (msgBody.toUpperCase() === "ESTADO") {
    // Ver posiciones actuales con targets
    const lines = ["📊 *POSICIONES ACTUALES*", "━━━━━━━━━━━━━━━━━━━━"];
    for (const [sym, pos] of Object.entries(state.positions || {})) {
      if (pos.phase === "HOLDING" && pos.entryPrice) {
        const pnlLine = pos.targetPrice
          ? `Target: ${fmtP(pos.targetPrice)}`
          : `Sin target definido`;
        lines.push(`🟢 ${sym}: ${fmtP(pos.entryPrice)} → ${pnlLine}`);
      } else {
        lines.push(`⚪ ${sym}: esperando entrada`);
      }
    }
    lines.push(``, `💵 PnL mes: $${(state.monthlyPnl||0).toFixed(0)} / $4,000`);
    lines.push(`🔄 Ciclos totales: ${state.totalCycles || 0}`);
    await sendWA(TWILIO_SID, TWILIO_AUTH, TWILIO_FROM, TWILIO_TO, lines.join("\n"));

  } else {
    // Ayuda
    const helpMsg = [
      `🤖 *Bitcopper — Comandos:*`,
      ``,
      `*1* → Confirmar compra pendiente`,
      `*2* → Ignorar señal`,
      `*ENTRADA BTC 71319* → Registrar compra manual`,
      `*SALIDA BTC 89500* → Cerrar trade y registrar PnL`,
      `*VENTA BTC 90000* → Registrar target de venta`,
      `*ESTADO* → Ver posiciones y targets`,
    ].join("\n");
    await sendWA(TWILIO_SID, TWILIO_AUTH, TWILIO_FROM, TWILIO_TO, helpMsg);
  }

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end("<Response></Response>");
}

// ─── SERVIDOR HTTP ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`);

  if (req.url === "/webhook" && req.method === "POST") {
    await handleWebhook(req, res);
  } else if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "Bitcopper Webhook v1.0" }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Bitcopper Webhook corriendo en puerto ${PORT}`);
});
