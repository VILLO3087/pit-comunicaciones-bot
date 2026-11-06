
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API_VERSION = process.env.GRAPH_API_VERSION || "v25.0";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const POE_IMAGE_URL =
  "https://raw.githubusercontent.com/VILLO3087/pit-comunicaciones-bot/main/poe.jpg";

const ROUTER_IMAGE_URL =
  "https://raw.githubusercontent.com/VILLO3087/pit-comunicaciones-bot/main/router.jpg";

// MEMORIA DE CONVERSACIONES
const conversations = new Map();
const salesSessions = new Map();
const MEMORY_LIMIT = 12;
const SESSION_TTL = 24 * 60 * 60 * 1000;

// PAUSAS MANUALES PERSISTENTES
const manualPauses = new Map();
const processedEchoes = new Map();
const MANUAL_PAUSE_DURATION = 30 * 60 * 1000;

const DATA_DIR = process.env.DATA_DIR || "/data";
const PAUSES_FILE = path.join(DATA_DIR, "manual-pauses.json");

let pauseWriteQueue = Promise.resolve();

async function persistManualPauses() {
  const snapshot = Object.fromEntries(manualPauses);

  pauseWriteQueue = pauseWriteQueue
    .then(async () => {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });

      const tempFile = `${PAUSES_FILE}.tmp`;

      await fs.promises.writeFile(
        tempFile,
        JSON.stringify(snapshot, null, 2),
        "utf8"
      );

      await fs.promises.rename(tempFile, PAUSES_FILE);
    })
    .catch(error => {
      console.error("ERROR GUARDANDO PAUSAS:", error);
    });

  return pauseWriteQueue;
}

async function loadManualPauses() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });

  try {
    const content = await fs.promises.readFile(PAUSES_FILE, "utf8");
    const savedPauses = JSON.parse(content);
    const now = Date.now();

    for (const [phone, pauseUntil] of Object.entries(savedPauses)) {
      if (
        typeof pauseUntil === "number" &&
        Number.isFinite(pauseUntil) &&
        pauseUntil > now
      ) {
        manualPauses.set(phone, pauseUntil);
      }
    }

    console.log(`PAUSAS RECUPERADAS: ${manualPauses.size}`);

    if (manualPauses.size !== Object.keys(savedPauses).length) {
      await persistManualPauses();
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("Creando archivo inicial de pausas.");
      await persistManualPauses();
      return;
    }

    throw error;
  }
}

// INFORMACIÓN OFICIAL DEL NEGOCIO
const businessInfo = {
  business: "PIT COMUNICACIONES",
  plan: {
    name: "Plan Familiar",
    downloadMbps: 25,
    uploadMbps: 10,
    monthlyPriceMXN: 350,
    unlimitedNavigation: true,
    devices:
      "Sin cantidad máxima fija. La velocidad se comparte entre los dispositivos conectados."
  },
  installation: [
    { locality: "La Libertad, Chiapas", feeMXN: 600 },
    { locality: "Emiliano Zapata, Tabasco", feeMXN: 800 },
    { locality: "Ejido Morelos", feeMXN: 1200 }
  ],
  paymentMethods: [
    "Efectivo",
    "Transferencia bancaria",
    "Depósito en OXXO"
  ],
  supportHours: {
    mondayToFriday: "07:00 a 18:00",
    saturday: "07:00 a 14:00",
    sunday: "Sin servicio técnico"
  }
};

// MEMORIA
function getConversation(phone) {
  let session = conversations.get(phone);

  if (!session || Date.now() - session.updatedAt > SESSION_TTL) {
    session = {
      messages: [],
      updatedAt: Date.now()
    };
    conversations.set(phone, session);
  }

  session.updatedAt = Date.now();
  return session;
}

function saveConversation(phone, role, content) {
  const session = getConversation(phone);
  session.messages.push({ role, content });
  session.messages = session.messages.slice(-MEMORY_LIMIT);
  session.updatedAt = Date.now();
}

// MENÚ PRINCIPAL
function mainMenu() {
  return `📡 *PIT COMUNICACIONES*

¡Hola! 👋 Bienvenido.

Estamos para ayudarte. ¿Qué servicio necesitas hoy?

📋 *MENÚ DE ATENCIÓN*

1️⃣ 📡 No tengo Internet.
2️⃣ 🐢 Mi Internet está lento.
3️⃣ 💳 Información sobre pagos.
4️⃣ 🚀 Consultar planes y precios.
5️⃣ 🏠 ¡Quiero contratar Internet!
6️⃣ 📍 Cobertura y horarios de atención.
7️⃣ 👨‍🔧 Hablar con un técnico.

✍️ Escribe el número de la opción que necesitas.

💙 *PIT COMUNICACIONES*
Conectando contigo.`;
}

// ENVÍO DE TEXTO
async function sendWhatsAppMessage(to, message) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Faltan variables de WhatsApp.");
    return false;
  }

  const url =
    `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: message }
    })
  });

  const result = await response.json();

  if (!response.ok) {
    console.error("ERROR ENVIANDO TEXTO:", result);
    return false;
  }

  console.log("Texto enviado a:", to);
  return true;
}

// ENVÍO DE FOTOGRAFÍAS
async function sendWhatsAppImage(to, imageUrl, caption) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Faltan variables de WhatsApp.");
    return false;
  }

  const url =
    `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "image",
      image: {
        link: imageUrl,
        caption
      }
    })
  });

  const result = await response.json();

  if (!response.ok) {
    console.error("ERROR ENVIANDO IMAGEN:", result);
    return false;
  }

  console.log("Imagen enviada a:", to);
  return true;
}

// GUÍA TÉCNICA PASO A PASO
async function sendNoInternetGuide(to) {
  console.log(`Iniciando guía de conexión para ${to}`);

  // PASO 1: IDENTIFICAR EL PoE
  await sendWhatsAppMessage(
    to,
    `📡 *VAMOS A REVISAR TU CONEXIÓN*

Te guiaremos paso a paso. Primero identifica el adaptador PoE de tu instalación.

Observa la siguiente fotografía antes de continuar.`
  );

  // PASO 2: CABLES DEL PoE
  const poeSent = await sendWhatsAppImage(
    to,
    POE_IMAGE_URL,
    `🔌 *PASO 1. ADAPTADOR PoE*

Identifica los dos cables de red:

⚫ *Cable negro:* está conectado en el puerto que dice *POE*. Desconéctalo y vuelve a conectarlo en ese mismo puerto.

⚪ *Cable gris:* está conectado en el puerto que dice *LAN*. Desconéctalo y vuelve a conectarlo en ese mismo puerto.

🚨 *NO INTERCAMBIES LOS CABLES.*
El cable negro debe regresar a POE y el cable gris debe regresar a LAN.

No cambies ninguno de los cables de posición.`
  );

  if (!poeSent) {
    console.error("No se pudo enviar imagen PoE a:", to);
  }

  // PASO 3: IDENTIFICAR EL ROUTER
  await sendWhatsAppMessage(
    to,
    `Ahora vamos a revisar el router WiFi. Observa la siguiente fotografía e identifica el puerto WAN.`
  );

  // PASO 4: CABLE WAN DEL ROUTER
  const routerSent = await sendWhatsAppImage(
    to,
    ROUTER_IMAGE_URL,
    `📶 *PASO 2. ROUTER WiFi*

Localiza el cable de red conectado en el puerto que dice *WAN*.

Desconecta ese cable y vuelve a conectarlo en el mismo puerto *WAN*.

⚠️ No lo conectes en ningún otro puerto del router. Si lo cambias de puerto, el servicio podría quedarse sin Internet.

❌ No presiones el botón RESET.`
  );

  if (!routerSent) {
    console.error("No se pudo enviar imagen del router a:", to);
  }

  // PASO 5: ESPERA Y CONFIRMACIÓN
  await sendWhatsAppMessage(
    to,
    `⏱️ *PASO 3. ESPERA*

Ya que volviste a conectar los cables:

1️⃣ Verifica que el cable negro esté en POE.
2️⃣ Verifica que el cable gris esté en LAN.
3️⃣ Verifica que el cable de red del router esté en WAN.
4️⃣ Espera de 3 a 5 minutos para que los equipos restablezcan la conexión.

🚨 *RECOMENDACIONES IMPORTANTES*

❌ No presiones RESET en ningún equipo.
❌ No intercambies los cables POE y LAN.
❌ No conectes el cable WAN del router en otro puerto.
❌ No desconectes ni manipules la antena o el cableado exterior.

*¿Ya tienes Internet nuevamente?*

Responde:
✅ *SI* — Si ya tienes servicio.
❌ *NO* — Si todavía no tienes Internet.

💙 *PIT COMUNICACIONES*`
  );

  console.log(`Guía visual terminada para ${to}`);
}

// RESPUESTAS FIJAS DEL MENÚ
function getMenuReply(message) {
  const option = message.trim().toLowerCase();

  if (["hola", "buenas", "inicio", "menú", "menu"].includes(option)) {
    return mainMenu();
  }

  switch (option) {
    case "1":
      return null;

    case "2":
      return `🐢 *INTERNET LENTO*

Vamos a revisar tu conexión.

1. Acércate al router.
2. Revisa que los cables estén conectados correctamente.
3. Si identificas alguna conexión floja, no cambies los cables de puerto.
4. Espera unos minutos y vuelve a probar.

Si continúa lento, escribe *TECNICO* para solicitar ayuda.

No presiones RESET ni manipules la antena o el cableado exterior.`;

    case "3":
      return `💳 *INFORMACIÓN DE PAGOS*

Puedes realizar tu pago mediante:

💵 Efectivo.
🏦 Transferencia bancaria.
🏪 Depósito en OXXO.

Si realizas un pago, envíanos tu nombre completo y una fotografía del comprobante.

⏳ Tu pago quedará pendiente de revisión hasta verificarlo.`;

    case "4":
      return `🚀 *PLAN FAMILIAR PIT COMUNICACIONES*

📥 25 Mbps de bajada.
📤 10 Mbps de subida.
💰 $350 MXN mensuales.
♾️ Sin límite de navegación.
📱 Puedes conectar los dispositivos que necesites.

La velocidad se comparte entre los dispositivos conectados.

¿Te gustaría contratar? Escribe *5*.`;

    case "5":
      return `🏠 *¡QUEREMOS LLEVAR INTERNET HASTA TU HOGAR!*

Primero, ¿en qué localidad vives?`;

    case "6":
      return `📍 *COBERTURA Y HORARIOS*

🕒 HORARIOS DE ATENCIÓN TÉCNICA

Lunes a viernes: 07:00 a 18:00.
Sábados: 07:00 a 14:00.
Domingos: Sin servicio técnico.

🛠️ *COSTOS DE INSTALACIÓN*

📍 La Libertad, Chiapas: $600.
📍 Emiliano Zapata, Tabasco: $800.
📍 Ejido Morelos: $1,200.

En otras comunidades debemos verificar cobertura y costo.`;

    case "7":
    case "tecnico":
    case "técnico":
      return `👨‍🔧 *ATENCIÓN TÉCNICA*

Para solicitar atención, envíanos:

👤 Nombre completo.
📍 Localidad.
📱 Número de teléfono.
📝 Describe brevemente tu problema.

Un técnico deberá revisar tu solicitud.`;

    default:
      return null;
  }
}

// CONTRATACIONES
function startSales(phone) {
  salesSessions.set(phone, {
    step: "locality",
    locality: "",
    name: "",
    address: "",
    updatedAt: Date.now()
  });
}

function getInstallationFee(locality) {
  const normalized = locality.toLowerCase();

  if (normalized.includes("la libertad")) return 600;
  if (normalized.includes("emiliano zapata")) return 800;
  if (normalized.includes("morelos")) return 1200;

  return null;
}

function handleSales(phone, message) {
  const text = message.trim();
  const lower = text.toLowerCase();
  const session = salesSessions.get(phone);

  if (lower === "cancelar") {
    salesSessions.delete(phone);
    return "De acuerdo, hemos detenido la solicitud. Si necesitas ayuda, escribe MENU.";
  }

  if (!session || Date.now() - session.updatedAt > SESSION_TTL) {
    return null;
  }

  session.updatedAt = Date.now();

  if (session.step === "locality") {
    if (text.length < 3) {
      return "Por favor, dime el nombre de tu localidad o comunidad.";
    }

    session.locality = text;
    session.step = "name";

    const fee = getInstallationFee(text);
    const feeText = fee !== null
      ? `El costo de instalación registrado es de $${fee} MXN.`
      : "Un técnico debe confirmar primero la cobertura y el costo de instalación.";

    return `${feeText}

Ahora, ¿me compartes tu nombre completo?`;
  }

  if (session.step === "name") {
    if (text.length < 5 || !text.includes(" ")) {
      return "Por favor, escribe tu nombre y apellidos.";
    }

    session.name = text;
    session.step = "address";

    return `Gracias, ${session.name}.

Ahora compárteme tu dirección, colonia, calle o una referencia de ubicación.`;
  }

  if (session.step === "address") {
    if (text.length < 5) {
      return "Por favor, envíame una dirección o referencia más completa.";
    }

    session.address = text;

    const fee = getInstallationFee(session.locality);
    const feeText = fee !== null
      ? `Costo de instalación registrado: $${fee} MXN.`
      : "Costo de instalación pendiente de confirmación.";

    const summary = `SOLICITUD DE CONTRATACIÓN PIT COMUNICACIONES

Nombre: ${session.name}
Teléfono: ${phone}
Localidad: ${session.locality}
Dirección: ${session.address}
Plan: Familiar 25/10 Mbps.
Mensualidad: $350 MXN.
${feeText}
Estado: Pendiente de revisión.`;

    console.log("NUEVA SOLICITUD:\n" + summary);

    salesSessions.delete(phone);

    return `¡Gracias, ${session.name}!

Hemos recibido tus datos para solicitar el servicio.

${feeText}

Nuestro equipo deberá revisar la cobertura y ponerse en contacto contigo.

Tu solicitud todavía no representa una instalación confirmada.

Si necesitas algo más, escribe MENU.`;
  }

  return null;
}

// INTELIGENCIA ARTIFICIAL
async function getAIReply(phone, message) {
  if (!OPENAI_API_KEY) {
    return "Por el momento no puedo responder automáticamente. Escribe MENU o TECNICO.";
  }

  const session = getConversation(phone);

  const instructions = `Eres el asesor virtual de PIT COMUNICACIONES, proveedor de Internet inalámbrico en La Libertad, Chiapas.

INFORMACIÓN OFICIAL:
${JSON.stringify(businessInfo)}

REGLAS:
- Responde en español mexicano, de forma amable, natural y breve.
- Mantén el contexto de la conversación.
- El plan disponible cuesta $350 MXN al mes e incluye 25 Mbps de bajada y 10 Mbps de subida.
- No tiene límite de navegación. La velocidad se comparte entre los dispositivos.
- No inventes otros planes, precios, promociones, cobertura ni fechas.
- Instalación: La Libertad $600; Emiliano Zapata $800; Ejido Morelos $1,200.
- En otras localidades un técnico debe confirmar cobertura y costo.
- Si el cliente quiere contratar, pregunta primero su localidad; después nombre completo y dirección, uno por uno.
- No confirmes instalaciones ni pagos.
- Métodos de pago: efectivo, transferencia y depósito OXXO.
- Para fallas persistentes solicita nombre, localidad, teléfono y descripción.
- Para problemas de conexión, ofrece la guía visual de revisión de cables cuando el cliente indique que no tiene Internet o escriba la opción 1.
- La guía correcta del PoE es: cable negro en POE y cable gris en LAN. Se desconectan y vuelven a conectar en sus mismos puertos. Nunca intercambiarlos.
- En el router, el cable de red se desconecta y vuelve a conectar en el mismo puerto WAN.
- Nunca indiques presionar RESET, cambiar los cables de puerto ni manipular antena o cableado exterior.
- Nunca solicites contraseñas, códigos ni datos completos de tarjetas.
- Si no tienes certeza, dilo y deriva con un técnico.
- Sólo puedes ayudar con los servicios de PIT COMUNICACIONES.`;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        instructions,
        input: [
          ...session.messages,
          { role: "user", content: message }
        ],
        max_output_tokens: 300,
        store: false
      }),
      signal: AbortSignal.timeout(25000)
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("ERROR OPENAI:", result);
      return "En este momento tengo dificultades para responder. Escribe MENU o TECNICO.";
    }

    const answer = (result.output || [])
      .filter(item => item.type === "message")
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text)
      .join("\n")
      .trim();

    if (!answer) {
      return "No pude preparar una respuesta. Escribe MENU para ver las opciones.";
    }

    saveConversation(phone, "user", message);
    saveConversation(phone, "assistant", answer);

    return answer.slice(0, 3500);
  } catch (error) {
    console.error("ERROR CONSULTANDO OPENAI:", error);
    return "En este momento no puedo responder. Inténtalo nuevamente o escribe TECNICO.";
  }
}

// PAUSA DE ATENCIÓN MANUAL
function pauseCustomer(phone) {
  if (!phone) return;

  const pauseUntil = Date.now() + MANUAL_PAUSE_DURATION;
  manualPauses.set(phone, pauseUntil);
  persistManualPauses();

  console.log(
    `PAUSA MANUAL ACTIVADA PARA ${phone} HASTA ${new Date(pauseUntil).toISOString()}`
  );
}

function isCustomerPaused(phone) {
  const pauseUntil = manualPauses.get(phone);

  if (!pauseUntil) return false;

  if (Date.now() >= pauseUntil) {
    manualPauses.delete(phone);
    persistManualPauses();
    console.log(`PAUSA FINALIZADA PARA ${phone}`);
    return false;
  }

  return true;
}

// DETECCIÓN DE MENSAJES ENVIADOS DESDE WHATSAPP BUSINESS
function processManualMessageEchoes(change) {
  if (change.field !== "smb_message_echoes") return;

  const echoes = change.value?.message_echoes || [];

  console.log("EVENTO SMB_MESSAGE_ECHOES RECIBIDO.");

  for (const echo of echoes) {
    const recipient = Array.isArray(echo.to)
      ? echo.to[0]
      : echo.to;

    if (!recipient) {
      console.log("ECHO SIN DESTINATARIO:", JSON.stringify(echo));
      continue;
    }

    if (echo.id && processedEchoes.has(echo.id)) continue;

    if (echo.id) {
      processedEchoes.set(echo.id, Date.now());
    }

    pauseCustomer(recipient);
  }
}

// LIMPIEZA DE REGISTROS
setInterval(() => {
  const now = Date.now();
  let changed = false;

  for (const [phone, pauseUntil] of manualPauses.entries()) {
    if (now >= pauseUntil) {
      manualPauses.delete(phone);
      changed = true;
      console.log(`Pausa eliminada para ${phone}`);
    }
  }

  if (changed) persistManualPauses();

  for (const [id, timestamp] of processedEchoes.entries()) {
    if (now - timestamp > 60 * 60 * 1000) {
      processedEchoes.delete(id);
    }
  }
}, 60 * 1000);

// VERIFICACIÓN DEL WEBHOOK
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("WEBHOOK VERIFICADO.");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// RECEPCIÓN DE EVENTOS DE WHATSAPP
app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  const body = req.body;

  if (body.object !== "whatsapp_business_account") return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {

      if (change.field === "smb_message_echoes") {
        processManualMessageEchoes(change);
        continue;
      }

      if (change.field !== "messages") continue;

      const messages = change.value?.messages || [];

      for (const message of messages) {
        if (message.type !== "text") continue;

        const from = message.from;
        const text = (message.text?.body || "").trim();

        if (!from || !text) continue;

        console.log("MENSAJE RECIBIDO:", from, text);

        if (isCustomerPaused(from)) {
          console.log(`BOT EN PAUSA: mensaje ignorado de ${from}`);
          continue;
        }

        const lowerText = text.toLowerCase();

        if (["menu", "menú"].includes(lowerText)) {
          salesSessions.delete(from);
          conversations.delete(from);
          sendWhatsAppMessage(from, mainMenu()).catch(console.error);
          continue;
        }

        // OPCIÓN 1: GUÍA VISUAL DE CONEXIÓN
        if (lowerText === "1") {
          saveConversation(from, "user", text);
          saveConversation(
            from,
            "assistant",
            "Se envió la guía visual de revisión de conexión."
          );

          sendNoInternetGuide(from).catch(error => {
            console.error("ERROR EN GUÍA VISUAL:", error);
          });

          continue;
        }

        // CONFIRMACIÓN DE SI O NO DESPUÉS DE LA GUÍA
        if (["si", "sí", "ya tengo", "ya funciona"].includes(lowerText)) {
          sendWhatsAppMessage(
            from,
            "¡Excelente! Nos alegra que tu servicio haya regresado. 💙 ¿Necesitas algo más? Escribe MENU para ver las opciones."
          ).catch(console.error);
          continue;
        }

        if (["no", "todavía no", "aun no", "aún no"].includes(lowerText)) {
          sendWhatsAppMessage(
            from,
            `Entendido. Vamos a solicitar apoyo técnico. 👨‍🔧

Por favor, envíanos:
1. Nombre completo.
2. Localidad.
3. Número de teléfono.
4. Describe si las luces del PoE o del router están encendidas o apagadas.

No presiones RESET ni cambies los cables de sus puertos.`
          ).catch(console.error);
          continue;
        }

        const salesReply = handleSales(from, text);

        if (salesReply) {
          saveConversation(from, "user", text);
          saveConversation(from, "assistant", salesReply);
          sendWhatsAppMessage(from, salesReply).catch(console.error);
          continue;
        }

        const fixedReply = getMenuReply(text);

        if (fixedReply) {
          if (lowerText === "5") startSales(from);

          saveConversation(from, "user", text);
          saveConversation(from, "assistant", fixedReply);
          sendWhatsAppMessage(from, fixedReply).catch(console.error);
          continue;
        }

        getAIReply(from, text)
          .then(async reply => {
            if (isCustomerPaused(from)) {
              console.log(`RESPUESTA CANCELADA: ${from} EN PAUSA MANUAL`);
              return;
            }

            const salesIntent =
              /contratar|quiero internet|me interesa|quiero el servicio|darme de alta/.test(lowerText);

            if (salesIntent && !salesSessions.has(from)) {
              startSales(from);
              reply = "¡Con gusto te ayudamos a contratar! Primero, ¿en qué localidad vives?";
              saveConversation(from, "assistant", reply);
            }

            await sendWhatsAppMessage(from, reply);
          })
          .catch(error => {
            console.error("ERROR PROCESANDO MENSAJE:", error);
          });
      }
    }
  }
});

// RUTAS
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "pit-comunicaciones-api",
    whatsappWebhook: true,
    aiConfigured: Boolean(OPENAI_API_KEY),
    aiModel: OPENAI_MODEL,
    conversationMemory: "temporary",
    manualCustomerPause: "30 minutes",
    manualPauseStorage: "persistent-file",
    manualPauseStoragePath: DATA_DIR,
    activeManualPauses: manualPauses.size,
    visualSupport: true,
    poeImageConfigured: Boolean(POE_IMAGE_URL),
    routerImageConfigured: Boolean(ROUTER_IMAGE_URL)
  });
});

app.get("/api/business-info", (_req, res) => {
  res.json(businessInfo);
});

app.post("/api/test-message", (req, res) => {
  const message = typeof req.body.message === "string"
    ? req.body.message.trim()
    : "";

  if (!message) {
    return res.status(400).json({
      error: "Envía un mensaje de prueba en el campo message."
    });
  }

  res.json({ received: true, message });
});

// INICIO DEL SERVIDOR
loadManualPauses()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`PIT COMUNICACIONES activo en puerto ${PORT}`);
      console.log(`Almacenamiento persistente: ${DATA_DIR}`);
      console.log(`Archivo de pausas: ${PAUSES_FILE}`);
      console.log("Guía visual PoE y router configurada.");
    });
  })
  .catch(error => {
    console.error("ERROR INICIANDO ALMACENAMIENTO:", error);
    process.exit(1);
  });
