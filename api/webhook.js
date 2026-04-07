// api/webhook.js — Bitcopper Webhook v1.0
// Recibe respuestas 1/2 de WhatsApp via Twilio
// Actualiza estado en Gist y confirma la acción

const https = require("https");

const GIST_ID   = "fcb66e3c3aa96220b17040fd72295fab";
const GIST_FILE = "state.json";

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
  const r = await httpRequest(
    `https://api.github.com/gists/${GIST_ID}`,
    "GET", null,
    { "Authorization": `token ${token}`, "Accept": "application/vnd.github.v3+json" }
  );
  const content = r.body?.files?.[GIST_FILE]?.content;
  return content ? JSON.parse(content) : null;
}

async function saveGist(token, state) {
  await httpRequest(
    `https://api.github.com/gists/${GIST_ID}`,
    "PATCH",
    { files: { [GIST_FILE]: { content: JSON.stringify(state, null, 2) } } },
    { "Authorization": `token ${token}`, "Content-Type": "application/json",
      "Accept": "application/vnd.github.v3+json" }
  );
}

async function sendWA(token, sid, from, to, message) {
  const body = new URLSearchParams({ From: from, To: to, Body: message }).toString();
  await httpRequest(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    "POST", body,
    {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
    }
  );
}

function fmtP(p) {
  if (!p) return "$0";
  return p >= 1000
    ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : `$${p.toFixed(2)}`;
}

// ─── HANDLER PRINCIPAL ───────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("<Response></Response>");
  }

  const GIST_TOKEN    = process.env.GIST_TOKEN;
  const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH   = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_FROM   = process.env.TWILIO_WHATSAPP_FROM;
  const TWILIO_TO     = process.env.TWILIO_WHATSAPP_TO;

  // Parsear body de Twilio (application/x-www-form-urlencoded)
  let body = "";
  if (typeof req.body === "string") {
    body = req.body;
  } else if (req.body) {
    body = new URLSearchParams(req.body).toString();
  }

  const params    = new URLSearchParams(body);
  const msgBody   = (params.get("Body") || "").trim();
  const fromNum   = params.get("From") || "";

  console.log(`Webhook recibido: "${msgBody}" de ${fromNum}`);

  if (!GIST_TOKEN) {
    console.error("Sin GIST_TOKEN");
    return res.status(200).send("<Response></Response>");
  }

  // Cargar estado
  const state = await loadGist(GIST_TOKEN);
  if (!state) {
    console.error("No se pudo cargar el Gist");
    return res.status(200).send("<Response></Response>");
  }

  // ── PROCESAR RESPUESTA ──────────────────────────────────────
  // El bot guarda en state.pendingConfirmation el contexto de la última alerta
  const pending = state.pendingConfirmation;

  if (msgBody === "1" && pending) {
    // ✅ CONFIRMÓ COMPRA
    const { sym, price, razon } = pending;
    const asset = {
      BTC: { capital: 4500, swingPct: 0.04, stopMult: 1.8 },
      ETH: { capital: 3500, swingPct: 0.05, stopMult: 1.8 },
      SOL: { capital: 2500, swingPct: 0.06, stopMult: 1.7 },
      TAO: { capital: 2000, swingPct: 0.07, stopMult: 1.7 },
      XAU: { capital: 2500, swingPct: 0.04, stopMult: 1.6 },
    }[sym];

    if (!asset) {
      return res.status(200).send("<Response></Response>");
    }

    const target  = price * (1 + asset.swingPct);
    const stop    = price * (1 - asset.swingPct * asset.stopMult);
    const ganancia = asset.capital * asset.swingPct;

    // Actualizar posición en el estado
    if (!state.positions) state.positions = {};
    state.positions[sym] = {
      ...( state.positions[sym] || {}),
      phase:        "HOLDING",
      entryPrice:   price,
      entryTs:      Date.now(),
      razonEntrada: razon || "Confirmado manualmente",
      lastPrice:    price,
      cycleCount:   (state.positions[sym]?.cycleCount || 0) + 1,
    };

    // Limpiar pendiente
    state.pendingConfirmation = null;

    await saveGist(GIST_TOKEN, state);

    // Confirmar al usuario
    const confirmMsg = [
      `✅ *COMPRA REGISTRADA — ${sym}*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `💰 Entrada: ${fmtP(price)}`,
      `🎯 Target venta: ${fmtP(target)} (+${(asset.swingPct*100).toFixed(0)}%)`,
      `🛡️ Stop mental: ${fmtP(stop)}`,
      `💵 Ganancia estimada: ~$${ganancia.toFixed(0)}`,
      ``,
      `📌 Pon orden límite de venta en Binance: ${fmtP(target)}`,
      `🤖 El bot monitorea y avisa cuando llegue.`,
    ].join("\n");

    await sendWA(TWILIO_AUTH, TWILIO_SID, TWILIO_FROM, TWILIO_TO, confirmMsg);
    console.log(`✅ Compra registrada: ${sym} a ${fmtP(price)}`);

  } else if (msgBody === "2" && pending) {
    // ❌ IGNORÓ LA SEÑAL
    state.pendingConfirmation = null;
    await saveGist(GIST_TOKEN, state);

    const ignoreMsg = `⏭️ Señal ${pending.sym} ignorada. El bot sigue monitoreando.`;
    await sendWA(TWILIO_AUTH, TWILIO_SID, TWILIO_FROM, TWILIO_TO, ignoreMsg);
    console.log(`❌ Señal ignorada: ${pending.sym}`);

  } else if (msgBody.toUpperCase().startsWith("ENTRADA ")) {
    // Comando manual: ENTRADA BTC 67153
    const parts = msgBody.split(" ");
    if (parts.length === 3) {
      const sym   = parts[1].toUpperCase();
      const price = parseFloat(parts[2]);
      if (sym && price > 0) {
        const asset = {
          BTC: { capital: 4500, swingPct: 0.04, stopMult: 1.8 },
          ETH: { capital: 3500, swingPct: 0.05, stopMult: 1.8 },
          SOL: { capital: 2500, swingPct: 0.06, stopMult: 1.7 },
          TAO: { capital: 2000, swingPct: 0.07, stopMult: 1.7 },
          XAU: { capital: 2500, swingPct: 0.04, stopMult: 1.6 },
        }[sym];

        if (asset) {
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

          await sendWA(TWILIO_AUTH, TWILIO_SID, TWILIO_FROM, TWILIO_TO, msg);
        }
      }
    }

  } else if (msgBody.toUpperCase() === "ESTADO") {
    // Comando: ESTADO — muestra posiciones actuales
    const lines = ["📊 *POSICIONES ACTUALES*", "━━━━━━━━━━━━━━━━━━━━"];
    for (const [sym, pos] of Object.entries(state.positions || {})) {
      if (pos.phase === "HOLDING" && pos.entryPrice) {
        lines.push(`🟢 ${sym}: HOLDING desde ${fmtP(pos.entryPrice)} | Ciclos: ${pos.cycleCount}`);
      } else {
        lines.push(`⚪ ${sym}: esperando entrada`);
      }
    }
    lines.push(``, `💵 PnL mes: $${(state.monthlyPnl||0).toFixed(0)} / $4,000`);
    await sendWA(TWILIO_AUTH, TWILIO_SID, TWILIO_FROM, TWILIO_TO, lines.join("\n"));

  } else {
    // Comando no reconocido
    const helpMsg = [
      `🤖 *Bitcopper Bot — Comandos:*`,
      ``,
      `*1* → Confirmar compra (cuando hay señal pendiente)`,
      `*2* → Ignorar señal`,
      `*ENTRADA BTC 67153* → Registrar compra manual`,
      `*ESTADO* → Ver posiciones actuales`,
    ].join("\n");
    await sendWA(TWILIO_AUTH, TWILIO_SID, TWILIO_FROM, TWILIO_TO, helpMsg);
  }

  // Twilio espera TwiML vacío como respuesta
  res.setHeader("Content-Type", "text/xml");
  return res.status(200).send("<Response></Response>");
}
