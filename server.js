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

// IMÁGENES
const POE_IMAGE_URL =
  "https://raw.githubusercontent.com/VILLO3087/pit-comunicaciones-bot/main/poe.jpg";

const ROUTER_IMAGE_URL =
  "https://raw.githubusercontent.com/VILLO3087/pit-comunicaciones-bot/main/router.jpg";

// MEMORIA Y SESIONES
const conversations = new Map();
const salesSessions = new Map();
const salesOffers = new Map();
const guideSessions = new Map();
const guideOffers = new Map();

const MEMORY_LIMIT = 12;
const SESSION_TTL = 24 * 60 * 60 * 1000;

// PAUSA MANUAL PERSISTENTE
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
      console.log("Creando archivo de pausas.");
      await persistManualPauses();
      return;
    }

    throw error;
  }
}

// INFORMACIÓN DEL NEGOCIO
const businessInfo = {
  business: "PIT COMUNICACIONES",
  plan: {
    name: "Plan Familiar",
    downloadMbps: 25,
    uploadMbps: 10,
    monthlyPriceMXN: 350,
    unlimitedNavigation: true,
    devices: "Sin cantidad máxima fija; la velocidad se comparte."
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
  paymentPolicy: {
    paymentStartDay: 15,
    paymentEndDay: 20,
    lateFeeStartDay: 21,
    lateFeeMXN: 30,
    suspensionPossible: true,
    description: "Los pagos mensuales deben realizarse del día 15 al 20 de cada mes. A partir del día 21 se cobran $30 MXN adicionales por mora y el servicio puede ser suspendido."
  },
  supportHours: {
    mondayToFriday: "07:00 a 18:00",
    saturday: "07:00 a 14:00",
    sunday: "Sin servicio técnico"
  }
};

// UTILIDADES
function normalize(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isYes(text) {
  return /^(si|sí|ok|okay|claro|correcto|listo|continuar|adelante|va|de acuerdo|ya)$/.test(
    normalize(text)
  );
}

function isNo(text) {
  return /^(no|nop|negativo|todavia no|aun no|aún no)$/.test(
    normalize(text)
  );
}

// MEMORIA
function getConversation(phone) {
  const session = conversations.get(phone);

  if (!session || Date.now() - session.updatedAt > SESSION_TTL) {
    const fresh = {
      messages: [],
      updatedAt: Date.now()
    };

    conversations.set(phone, fresh);
    return fresh;
  }

  session.updatedAt = Date.now();
  return session;
}

function sessionTextForSales(phone, currentMessage) {
  const session = getConversation(phone);

  return [
    ...session.messages.map(item => item.content || ""),
    currentMessage || ""
  ].join(" ");
}

function saveConversation(phone, role, content) {
  const session = getConversation(phone);

  session.messages.push({ role, content });
  session.messages = session.messages.slice(-MEMORY_LIMIT);
  session.updatedAt = Date.now();
}

// MENÚ
function mainMenu() {
  return `📡 *PIT COMUNICACIONES*

¡Hola! 👋 Bienvenido.

¿En qué podemos ayudarte?

📋 *MENÚ DE ATENCIÓN*

1️⃣ 📡 No tengo Internet.
2️⃣ 🐢 Mi Internet está lento.
3️⃣ 💳 Información sobre pagos.
4️⃣ 🚀 Planes y precios.
5️⃣ 🏠 Quiero contratar Internet.
6️⃣ 📍 Cobertura y horarios.
7️⃣ 👨‍🔧 Hablar con un técnico.

✍️ Escribe el número de la opción.

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

// ENVÍO DE IMÁGENES
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

// GUÍA DE CONEXIÓN PASO A PASO
async function startConnectionGuide(phone) {
  guideOffers.delete(phone);

  guideSessions.set(phone, {
    step: "poe",
    updatedAt: Date.now()
  });

  await sendWhatsAppMessage(
    phone,
    `📡 *VAMOS A REVISAR TU CONEXIÓN*

Te ayudaré paso a paso.

Primero revisaremos el adaptador PoE de tu instalación.

Observa la siguiente fotografía. No desconectes nada todavía.`
  );

  await sendWhatsAppImage(
    phone,
    POE_IMAGE_URL,
    `🔌 *PASO 1. ADAPTADOR PoE*

Identifica los dos cables de red:

⚫ *Cable negro:* conectado en el puerto que dice *POE*.

⚪ *Cable gris:* conectado en el puerto que dice *LAN*.

Cuando hayas identificado ambos cables, responde *SI* para continuar.`
  );
}

// CONTROL DE LA GUÍA
async function handleConnectionGuide(phone, message) {
  const session = guideSessions.get(phone);

  if (!session) return false;

  const answer = normalize(message);

  if (answer === "cancelar") {
    guideSessions.delete(phone);

    await sendWhatsAppMessage(
      phone,
      "De acuerdo. Hemos detenido la guía. Si necesitas ayuda, escribe MENU."
    );

    return true;
  }

  if (!isYes(message) && !isNo(message)) {
    await sendWhatsAppMessage(
      phone,
      "Para continuar con la guía, responde *SI*. Si deseas detenerla, escribe *CANCELAR*."
    );

    return true;
  }

  if (session.step === "poe") {
    if (isNo(message)) {
    await sendWhatsAppMessage(
      phone,
      "De acuerdo. Hemos detenido la guía. Si necesitas ayuda, escribe MENU."
    );

    return true;
  }

  if (!isYes(message) && !isNo(message)) {
    await sendWhatsAppMessage(
      phone,
      "Para continuar con la guía, responde *SI*. Si deseas detenerla, escribe *CANCELAR*."
    );

    return true;
  }

  if (session.step === "poe") {
    if (isNo(message)) {
      await sendWhatsAppMessage(
        phone,
        "No hay problema. Cuando hayas identificado el adaptador PoE y sus dos cables, responde *SI* para continuar."
      );

      return true;
    }

    session.step = "router";
    session.updatedAt = Date.now();

    await sendWhatsAppMessage(
      phone,
      `🔌 *PASO 2. CONEXIONES DEL ADAPTADOR PoE*

Ahora revisaremos los dos cables de red del adaptador.

⚫ *CABLE NEGRO:*
Está conectado en el puerto que dice *POE*.

Desconéctalo y vuelve a conectarlo en ESE MISMO PUERTO.

⚪ *CABLE GRIS:*
Está conectado en el puerto que dice *LAN*.

Desconéctalo y vuelve a conectarlo en ESE MISMO PUERTO.

🚨 *MUY IMPORTANTE*

❌ No intercambies los cables.
❌ El negro regresa a POE.
❌ El gris regresa a LAN.
❌ No cambies los cables de posición.

Cuando termines, responde *SI* para revisar el router.`
    );

    return true;
  }

  if (session.step === "router") {
    if (isNo(message)) {
      await sendWhatsAppMessage(
        phone,
        "Está bien. Termina de conectar correctamente los cables del adaptador PoE. Cuando estés listo, responde *SI*."
      );

      return true;
    }

    session.step = "wait";
    session.updatedAt = Date.now();

    await sendWhatsAppMessage(
      phone,
      `📶 *PASO 3. ROUTER WiFi*

Observa la fotografía e identifica el cable de red conectado en el puerto que dice *WAN*.

Desconecta ese cable y vuelve a conectarlo en ESE MISMO PUERTO WAN.

⚠️ No lo conectes en ningún otro puerto del router.

❌ No presiones el botón RESET.

Cuando termines, responde *SI* para continuar.`
    );

    await sendWhatsAppImage(
      phone,
      ROUTER_IMAGE_URL,
      "📶 *Identifica el puerto WAN de tu router.* Desconecta y vuelve a conectar el cable en ese mismo puerto."
    );

    return true;
  }

  if (session.step === "wait") {
    if (isNo(message)) {
      await sendWhatsAppMessage(
        phone,
        "No hay problema. Revisa que el cable del router esté conectado nuevamente en el mismo puerto WAN. Cuando termines, responde *SI*."
      );

      return true;
    }

    session.step = "confirmation";
    session.updatedAt = Date.now();

    await sendWhatsAppMessage(
      phone,
      `⏱️ *PASO 4. ESPERA Y COMPROBACIÓN*

Verifica que las conexiones estén en su lugar:

1️⃣ Cable negro conectado en *POE*.
2️⃣ Cable gris conectado en *LAN*.
3️⃣ Cable del router conectado en *WAN*.

Espera de 3 a 5 minutos para que los equipos restablezcan la conexión.

🚨 *RECUERDA*

❌ No presiones RESET.
❌ No intercambies los cables POE y LAN.
❌ No conectes el cable WAN en otro puerto.
❌ No manipules la antena ni el cableado exterior.

Después de esperar, responde *SI* si ya tienes Internet o *NO* si todavía no tienes servicio.`
    );

    return true;
  }

  if (session.step === "confirmation") {
    if (isYes(message)) {
      guideSessions.delete(phone);

      await sendWhatsAppMessage(
        phone,
        `✅ ¡Excelente! Nos alegra que tu servicio de Internet haya regresado.

Gracias por seguir los pasos.

💙 *PIT COMUNICACIONES*
Conectando contigo.`
      );

      return true;
    }

    guideSessions.delete(phone);

    await sendWhatsAppMessage(
      phone,
      `👨‍🔧 *NECESITAMOS AYUDARTE*

Si después de realizar los pasos sigues sin Internet, vamos a solicitar atención técnica.

Por favor, envíanos:

1️⃣ Nombre completo.
2️⃣ Localidad.
3️⃣ Número de teléfono de contacto.
4️⃣ Confírmanos que sigues sin Internet.

Un técnico deberá revisar tu reporte.

💙 *PIT COMUNICACIONES*`
    );

    return true;
  }

  return false;
}

// RESPUESTAS DEL MENÚ
function getMenuReply(message) {
  const option = normalize(message);

  if (["hola", "buenas", "inicio", "menu"].includes(option)) {
    return mainMenu();
  }

  switch (option) {
    case "1":
      return null;

    case "2":
      return `🐢 *INTERNET LENTO*

Vamos a revisar tu conexión.

1. Acércate al router.
2. Comprueba que los cables estén conectados.
3. Reinicia únicamente el router desconectando su alimentación eléctrica durante 30 segundos.
4. Conéctalo nuevamente y espera de 3 a 5 minutos.

No presiones el botón RESET.

Si continúa lento, escribe *TECNICO*.`;

    case "3":
      return `💳 *INFORMACIÓN DE PAGOS*

Puedes realizar tu pago mediante:

💵 Efectivo.
🏦 Transferencia bancaria.
🏪 Depósito en OXXO.

📅 *FECHAS DE PAGO*
Del día 15 al 20 de cada mes.

⚠️ A partir del día 21 se cobran $30 MXN adicionales por mora.

🚫 El servicio podrá ser suspendido si no se realiza el pago.

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
      return `👨‍🔧 *ATENCIÓN TÉCNICA*

Con gusto te ayudaremos.

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
  guideOffers.delete(phone);
  guideSessions.delete(phone);
  salesOffers.delete(phone);
  salesSessions.set(phone, {
    step: "locality",
    locality: "",
    name: "",
    address: "",
    updatedAt: Date.now()
  });
}

function getInstallationFee(locality) {
  const normalized = normalize(locality);

  if (normalized.includes("la libertad")) return 600;
  if (normalized.includes("emiliano zapata")) return 800;
  if (normalized.includes("morelos")) return 1200;

  return null;
}

// DETECTAR LOCALIDADES MENCIONADAS
function getMentionedLocalities(text) {
  const normalized = normalize(text);
  const found = [];

  if (normalized.includes("la libertad")) {
    found.push("La Libertad, Chiapas");
  }

  if (normalized.includes("emiliano zapata")) {
    found.push("Emiliano Zapata, Tabasco");
  }

  if (
    normalized.includes("ejido morelos") ||
    normalized.includes("morelos")
  ) {
    found.push("Ejido Morelos");
  }

  return [...new Set(found)];
}

// PROCESAR ACEPTACIÓN DE CONTRATACIÓN
function handleSalesOfferAcceptance(phone, message) {
  const offer = salesOffers.get(phone);

  if (!offer) return null;

  const normalized = normalize(message);

  const isAcceptance =
    isYes(message) ||
    /\b(600|800|1200)\b/.test(normalized) ||
    /contrat|instalacion|instalar|en la libertad|emiliano zapata|morelos/.test(
      normalized
    );
  if (!isAcceptance) return null;

  const mentioned = getMentionedLocalities(message);
  let locality = mentioned.length === 1 ? mentioned[0] : "";

  if (!locality && offer.localities.length === 1) {
    locality = offer.localities[0];
  }

  salesOffers.delete(phone);

  if (!locality) {
    startSales(phone);

    return "¡Con gusto te ayudamos con la contratación! Primero, ¿en qué localidad deseas instalar el servicio?";
  }

  salesSessions.set(phone, {
    step: "name",
    locality,
    name: "",
    address: "",
    updatedAt: Date.now()
  });

  const fee = getInstallationFee(locality);

  const feeText = fee !== null
    ? `El costo de instalación en ${locality} es de $${fee} MXN.`
    : "Un técnico debe confirmar la cobertura y el costo de instalación.";

  return `${feeText}

Para continuar con tu contratación, ¿me compartes tu nombre completo?`;
}

function getSalesQuestionReply(session, message) {
  const normalized = normalize(message);

  // FECHAS DE PAGO, MORA Y POSIBLE SUSPENSION
  const asksPaymentDates =
    /\b(fecha|fechas|dia|dias|cuando|pagar|pago|pagos|mensualidad|mensualidades|mora|recargo|atraso|suspension|suspender|corte|cortan)\b/.test(normalized) &&
    /\b(pago|pagos|mensualidad|mensualidades|fecha|fechas|mora|recargo|atraso|servicio|internet|mes)\b/.test(normalized);

  if (asksPaymentDates) {
    return `💳 *FECHAS DE PAGO – PIT COMUNICACIONES*

📅 Los pagos deben realizarse del día *15 al 20 de cada mes*.

⚠️ A partir del día 21 se cobran *$30 MXN adicionales por mora* a la mensualidad.

🚫 Si no se realiza el pago, el servicio podrá ser suspendido.

Te recomendamos pagar dentro del periodo establecido para evitar cargos adicionales o interrupciones.

${salesPendingPrompt(session)}`;
  }

  // CONSULTAS SOBRE OTROS PLANES: DERIVAR A VENTAS
  const asksOtherPlans =
    /\b(otro|otra|otros|otras)\b.*\b(plan|planes|paquete|paquetes|servicio|opcion|opciones)\b|\b(plan|planes|paquete|paquetes)\b.*\b(otro|otra|diferente|diferentes|adicional|adicionales|aparte|distinto|distintos)\b|\b(tienen|manejan|cuentan|ofrecen|hay|existe|existen|disponen|trabajan)\b.*\b(plan|planes|paquete|paquetes|opcion|opciones)\b|\b(que|cuales)\b.*\b(plan|planes|paquete|paquetes)\b|\bmas opciones\b|\botras opciones\b|\balgun(a|o|os|as)?\b.*\b(plan|planes|paquete|paquetes)\b/.test(normalized);

  if (asksOtherPlans) {
    return `¡Claro! 😊

Para conocer si contamos con otros planes o paquetes, te recomendamos solicitar hablar con un *asesor de ventas de PIT COMUNICACIONES*. Él podrá brindarte información más detallada y confirmar las opciones disponibles.

Escribe *ASESOR DE VENTAS* para solicitar atención comercial por este mismo WhatsApp.

${salesPendingPrompt(session)}`;
  }

  const asksMonthly = /mensualidad|mensualidades|cuanto cuesta.*(mes|mensual)|precio.*(mes|mensual)|costo.*(mes|mensual)|pago mensual/.test(normalized);
  const asksPlan = /plan familiar|planes|precio.*internet|costo.*internet|cuanto cuesta.*internet|velocidad|cuantos megas|cuantos mbps/.test(normalized);
  const asksInstallation = /instalacion|instalar|costo.*instalacion|precio.*instalacion/.test(normalized);

  if (asksMonthly || asksPlan) {
    return `📡 *PLAN FAMILIAR PIT COMUNICACIONES*

📥 25 Mbps de bajada.
📤 10 Mbps de subida.
💰 *$350 MXN mensuales.*
♾️ Sin límite de navegación.

` + salesPendingPrompt(session);
  }

  if (asksInstallation) {
    const fee = session.locality ? getInstallationFee(session.locality) : null;
    const feeText = fee !== null
      ? `La instalación en ${session.locality} cuesta $${fee} MXN.`
      : "El costo de instalación depende de la localidad. En otras comunidades, un técnico debe confirmar cobertura y precio.";
    return `${feeText}

${salesPendingPrompt(session)}`;
  }

  return null;
}

function salesPendingPrompt(session) {
  if (session.step === "locality") return "Para continuar con tu solicitud, dime en qué localidad deseas el servicio.";
  if (session.step === "name") return "Para continuar con tu contratación, todavía necesito tu *nombre completo y apellidos*.";
  if (session.step === "address") return "Para continuar con tu contratación, todavía necesito tu *dirección, colonia, calle o una referencia de ubicación*.";
  return "Seguimos con tu solicitud de contratación.";
}

function looksLikeQuestion(text) {
  const normalized = normalize(text);
  return /[?¿]/.test(text) || /^(que|cual|cuanto|cuantos|como|cuando|donde|por que|porque|y las|y la|y el|aceptan|tienen|manejan|cuesta|costo|precio|mensualidad|mensualidades|plan|velocidad)\b/.test(normalized);
}

function handleSales(phone, message) {
  const text = message.trim();
  const session = salesSessions.get(phone);

  if (normalize(text) === "cancelar") {
    salesSessions.delete(phone);

    return "De acuerdo, hemos detenido la solicitud. Si necesitas ayuda, escribe MENU.";
  }

  if (!session) return null;

  if (Date.now() - session.updatedAt > SESSION_TTL) {
    salesSessions.delete(phone);
    return null;
  }

  session.updatedAt = Date.now();

  const normalizedMessage = normalize(text);
  if (/^(asesor|asesor de ventas|ventas|hablar con asesor)$/.test(normalizedMessage)) {
    return `Con gusto. Tu consulta es para el área de *ventas* de PIT COMUNICACIONES. Nuestro equipo podrá brindarte información sobre las opciones disponibles.\n\n${salesPendingPrompt(session)}`;
  }

  const salesQuestionReply = getSalesQuestionReply(session, text);
  if (salesQuestionReply) return salesQuestionReply;

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
    if (looksLikeQuestion(text) || text.length < 5 || !text.includes(" ")) {
      return "Con gusto te aclaro tus dudas. Para continuar con la contratación, por favor escribe tu *nombre completo y apellidos*.";
    }

    session.name = text;
    session.step = "address";

    return `Gracias, ${session.name}.

Ahora compárteme tu dirección, colonia, calle o una referencia de ubicación.`;
  }

  if (session.step === "address") {
    if (looksLikeQuestion(text) || text.length < 5) {
      return "Con gusto te aclaro tus dudas. Para completar la solicitud, todavía necesito tu *dirección, colonia, calle o una referencia de ubicación*.";
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
Plan: Familiar 25 Mbps / 10 Mbps.
Mensualidad: $350 MXN.
${feeText}
Estado: Pendiente de revisión.`;

    console.log("NUEVA SOLICITUD:\n" + summary);

    salesSessions.delete(phone);

    return `¡Gracias, ${session.name}!

Hemos recibido tus datos para solicitar el servicio.

${feeText}

Nuestro equipo deberá revisar la cobertura y ponerse en contacto contigo.

Tu solicitud todavía no representa una instalación confirmada.`;
  }

  return null;
}

// INTELIGENCIA ARTIFICIAL
async function getAIReply(phone, message) {
  const normalizedMessage = normalize(message);
  const asksPaymentDates =
    /\b(fecha|fechas|dia|dias|cuando|pagar|pago|pagos|mensualidad|mensualidades|mora|recargo|atraso|suspension|suspender|corte|cortan)\b/.test(normalizedMessage) &&
    /\b(pago|pagos|mensualidad|mensualidades|fecha|fechas|mora|recargo|atraso|servicio|internet|mes)\b/.test(normalizedMessage);

  if (asksPaymentDates) {
    return `💳 *FECHAS DE PAGO – PIT COMUNICACIONES*

📅 Los pagos deben realizarse del día *15 al 20 de cada mes*.

⚠️ A partir del día 21 se cobran *$30 MXN adicionales por mora* a la mensualidad.

🚫 Si no se realiza el pago, el servicio podrá ser suspendido.

Te recomendamos pagar dentro del periodo establecido para evitar cargos adicionales o interrupciones.`;
  }

  if (!OPENAI_API_KEY) {
    return "Por el momento no puedo responder esa consulta. Escribe MENU para ver las opciones o TECNICO para solicitar atención.";
  }

  const session = getConversation(phone);

  const instructions = `Eres el asesor virtual de PIT COMUNICACIONES, proveedor de Internet inalámbrico en La Libertad, Chiapas.

INFORMACIÓN OFICIAL:
${JSON.stringify(businessInfo)}

REGLAS:
- Responde en español mexicano, de forma amable, natural y breve.
- Mantén el contexto de la conversación.
- El Plan Familiar cuesta $350 MXN al mes e incluye 25 Mbps de bajada y 10 Mbps de subida.
- No tiene límite de navegación.
- El cliente puede conectar los dispositivos que necesite. La velocidad se comparte.
- No inventes planes, precios, promociones, cobertura ni fechas.
- Instalación: La Libertad $600, Emiliano Zapata $800, Ejido Morelos $1,200.
- En otras localidades un técnico debe confirmar cobertura y costo.
- Los pagos mensuales deben realizarse del día 15 al 20 de cada mes.
- A partir del día 21 se cobran $30 MXN adicionales por mora a la mensualidad.
- Si no se realiza el pago, el servicio podrá ser suspendido.
- Nunca digas que el cliente puede pagar cualquier día del mes sin recargo.
- No inventes otras fechas, cargos o políticas de pago.
- Si el cliente pregunta por fechas de pago, mora o suspensión, informa exactamente la política anterior.
- Si el cliente quiere contratar, pregunta primero su localidad. Después solicita nombre completo y dirección, paso a paso.
- No confirmes instalaciones ni pagos.
- Métodos de pago: efectivo, transferencia y depósito OXXO.
- Para fallas persistentes solicita nombre, localidad, teléfono y descripción.
- Nunca solicites contraseñas, códigos ni datos de tarjetas.
- Si el cliente pregunta si puedes compartir una guía rápida para revisar cables, puedes ofrecerla.
- Si el cliente acepta una guía, responde brevemente. El sistema enviará la guía paso a paso.
- Nunca indiques presionar RESET, intercambiar cables POE/LAN ni manipular antena o cableado exterior.
- Si no tienes certeza, dilo y deriva con un técnico.
- No respondas consultas ajenas a PIT COMUNICACIONES.`;

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

    return "En este momento no puedo responder esa consulta. Inténtalo nuevamente o escribe TECNICO.";
  }
}

// PAUSA MANUAL
function pauseCustomer(phone) {
  if (!phone) return;

  const pauseUntil = Date.now() + MANUAL_PAUSE_DURATION;

  manualPauses.set(phone, pauseUntil);
  persistManualPauses();

  console.log(
    `PAUSA MANUAL para ${phone} hasta ${new Date(pauseUntil).toISOString()}`
  );
}

function isCustomerPaused(phone) {
  const pauseUntil = manualPauses.get(phone);

  if (!pauseUntil) return false;
  if (Date.now() >= pauseUntil) {
    manualPauses.delete(phone);
    persistManualPauses();

    console.log(`PAUSA FINALIZADA para ${phone}.`);

    return false;
  }

  return true;
}

// DETECCIÓN DE MENSAJES MANUALES
function processManualMessageEchoes(change) {
  if (change.field !== "smb_message_echoes") return;

  const echoes = change.value?.message_echoes || [];

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

// LIMPIEZA
setInterval(() => {
  const now = Date.now();
  let pausesChanged = false;

  for (const [phone, pauseUntil] of manualPauses.entries()) {
    if (now >= pauseUntil) {
      manualPauses.delete(phone);
      pausesChanged = true;

      console.log(`Pausa eliminada para ${phone}.`);
    }
  }

  if (pausesChanged) persistManualPauses();

  for (const [id, timestamp] of processedEchoes.entries()) {
    if (now - timestamp > 60 * 60 * 1000) {
      processedEchoes.delete(id);
    }
  }

  for (const [phone, session] of guideSessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL) {
      guideSessions.delete(phone);
    }
  }

  for (const [phone, session] of salesSessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL) {
      salesSessions.delete(phone);
    }
  }

  for (const [phone, offer] of salesOffers.entries()) {
    if (now - offer.updatedAt > SESSION_TTL) {
      salesOffers.delete(phone);
    }
  }
}, 60 * 1000);

// VERIFICACIÓN WEBHOOK
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente.");

    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// RECEPCIÓN DE MENSAJES
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
          console.log(`BOT EN PAUSA: ${from}`);
          continue;
        }

        const normalized = normalize(text);

        // MENÚ PRINCIPAL
        if (["menu", "inicio"].includes(normalized)) {
          guideSessions.delete(from);
          guideOffers.delete(from);
          salesSessions.delete(from);
          salesOffers.delete(from);
          conversations.delete(from);

          sendWhatsAppMessage(from, mainMenu()).catch(console.error);
          continue;
        }

        // SI EXISTE UNA GUÍA EN CURSO, ATENDERLA PRIMERO
        if (guideSessions.has(from)) {
          handleConnectionGuide(from, text).catch(console.error);
          continue;
        }

        // SI HAY UNA CONTRATACIÓN ACTIVA, SUS MENSAJES TIENEN PRIORIDAD.
        // Así una pregunta de precio no se confunde con nombre/dirección ni pasa al flujo de soporte.
        if (salesSessions.has(from)) {
          const activeSalesReply = handleSales(from, text);
          if (activeSalesReply) {
            saveConversation(from, "user", text);
            saveConversation(from, "assistant", activeSalesReply);
            sendWhatsAppMessage(from, activeSalesReply).catch(console.error);
            continue;
          }
        }

        // ACEPTACIÓN DE UNA GUÍA OFRECIDA POR LA IA
        if (guideOffers.has(from)) {
          if (isYes(text)) {
            startConnectionGuide(from).catch(console.error);
            continue;
          }

          if (isNo(text)) {
            guideOffers.delete(from);

            sendWhatsAppMessage(
              from,
              "De acuerdo. Si necesitas revisar tu conexión, escribe MENU y selecciona la opción 1."
            ).catch(console.error);

            continue;
          }
        }

        // ACEPTACIÓN DE UNA OFERTA DE CONTRATACIÓN GENERADA POR LA IA
        const offerReply = handleSalesOfferAcceptance(from, text);

        if (offerReply) {
          saveConversation(from, "user", text);
          saveConversation(from, "assistant", offerReply);

          sendWhatsAppMessage(from, offerReply).catch(console.error);
          continue;
        }

        // OPCIÓN 1: INICIAR GUÍA PASO A PASO
        if (normalized === "1") {
          startConnectionGuide(from).catch(console.error);
          continue;
        }

        // CONTRATACIONES EN CURSO
        const salesReply = handleSales(from, text);

        if (salesReply) {
          saveConversation(from, "user", text);
          saveConversation(from, "assistant", salesReply);

          sendWhatsAppMessage(from, salesReply).catch(console.error);
          continue;
        }

        // OPCIONES DEL MENÚ
        const fixedReply = getMenuReply(text);

        if (fixedReply) {
          if (normalized === "5") startSales(from);

          saveConversation(from, "user", text);
          saveConversation(from, "assistant", fixedReply);

          sendWhatsAppMessage(from, fixedReply).catch(console.error);
          continue;
        }

        // RESPUESTA DE IA
        getAIReply(from, text)
          .then(async reply => {
            if (isCustomerPaused(from)) {
              console.log(`RESPUESTA CANCELADA POR PAUSA: ${from}`);
              return;
            }

            // Una respuesta de IA iniciada antes de comenzar la contratación no debe
            // mezclarse con el flujo nuevo (por ejemplo, enviar soporte técnico).
            if (salesSessions.has(from)) {
              console.log(`RESPUESTA IA CANCELADA: contratación activa para ${from}`);
              return;
            }

            const lowerMessage = normalized;

            const salesIntent =
              /contratar|quiero internet|me interesa|quiero el servicio|darme de alta/.test(
                lowerMessage
              );

            if (salesIntent && !salesSessions.has(from)) {
              startSales(from);

              reply =
                "¡Con gusto te ayudamos a contratar! Primero, ¿en qué localidad vives?";

              saveConversation(from, "assistant", reply);
            }

            // GUARDAR OFERTA DE CONTRATACIÓN Y LOCALIDADES DEL CONTEXTO
            const offersSales =
              /contrat|ayude con la contratacion|ayudarte con la contratacion/.test(
                normalize(reply)
              );

            if (offersSales) {
              const historyText = sessionTextForSales(from, text);

              salesOffers.set(from, {
                localities: getMentionedLocalities(historyText),
                updatedAt: Date.now()
              });
            }

            // DETECTAR OFERTA DE GUÍA DE CONEXIÓN
            const offersGuide =
              /guia rapida|guia para revisar|revisar los cables|revisar las conexiones|guia visual/.test(
                normalize(reply)
              );

            if (offersGuide) {
              guideOffers.set(from, Date.now());
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
    guideMode: "step-by-step",
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

// INICIAR SERVIDOR
loadManualPauses()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`PIT COMUNICACIONES activo en puerto ${PORT}`);
      console.log(`Almacenamiento persistente: ${DATA_DIR}`);
      console.log(`Archivo de pausas: ${PAUSES_FILE}`);
      console.log("Guía visual paso a paso configurada.");
    });
  })
  .catch(error => {
    console.error("ERROR INICIANDO ALMACENAMIENTO:", error);
    process.exit(1);
  });

