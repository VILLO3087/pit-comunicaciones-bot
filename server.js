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
const paymentFollowups = new Map();
const supportSessions = new Map();

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

      const tempFile = PAUSES_FILE + ".tmp";

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
  const value = normalize(text)
    .replace(/[.!¡?¿,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Acepta respuestas afirmativas naturales, incluso cuando el cliente
  // agrega cortesía: "sí, por favor", "sí de favor", "claro que sí".
  return /^(si|si por favor|si de favor|si gracias|si esta bien|si esta perfecto|claro|claro que si|por supuesto|ok|okay|ok gracias|correcto|listo|continuar|adelante|va|de acuerdo|ya|ya lo hice|ya quedo|ya quedo listo|terminado|hecho)$/.test(value);
}

function getMexicoTimeContext() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const hour = Number(parts.find(part => part.type === "hour")?.value || 0);
  const minute = parts.find(part => part.type === "minute")?.value || "00";

  let greeting;
  if (hour >= 6 && hour < 12) greeting = "Buenos días";
  else if (hour >= 12 && hour < 19) greeting = "Buenas tardes";
  else greeting = "Buenas noches";

  return { hour, time: `${String(hour).padStart(2, "0")}:${minute}`, greeting };
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

// RESPUESTAS DEL MENÚ PRINCIPAL
// Esta función es utilizada por el webhook para responder a las opciones 2 a 7.
function getMenuReply(message) {
  const option = normalize(message);

  if (["2", "internet lento", "mi internet esta lento", "mi internet va lento"].includes(option)) {
    return `🐢 *INTERNET LENTO – PIT COMUNICACIONES*\n\nVamos a revisar tu conexión.\n\n1️⃣ Reinicia tu módem o router desconectándolo durante 30 segundos.\n2️⃣ Conéctalo nuevamente y espera a que encienda por completo.\n3️⃣ Comprueba si mejora la conexión.\n\nSi el problema continúa, escribe *ASESOR* para solicitar ayuda de un técnico.`;
  }

  if (["3", "pagos", "pago", "informacion sobre pagos", "informacion de pagos"].includes(option)) {
    return `💳 *INFORMACIÓN DE PAGOS – PIT COMUNICACIONES*\n\n📅 Puedes realizar tu pago del día *15 al 20 de cada mes*.\n⚠️ A partir del día 21 se aplica un cargo adicional de *$30 MXN* por mora.\n🚫 El servicio puede ser suspendido por falta de pago.\n\nAceptamos efectivo, transferencia bancaria y depósito en OXXO.\n\nAl realizar tu pago, envía tu comprobante y nombre completo para verificarlo. No se confirma ningún pago hasta que sea revisado.\n\nSi necesitas apoyo, escribe *ASESOR*.`;
  }

  if (["4", "planes", "precios", "planes y precios", "precio", "plan"].includes(option)) {
    return `🚀 *PLAN FAMILIAR PIT COMUNICACIONES*\n\n📥 25 Mbps de descarga.\n📤 10 Mbps de subida.\n💰 *$350 MXN al mes.*\n♾️ Navegación sin límite.\n\n¿Te interesa contratar? Escribe *CONTRATAR*. Para hablar con ventas, escribe *ASESOR*. `;
  }

  if (["5", "contratar", "quiero contratar", "quiero contratar internet"].includes(option)) {
    return `🏠 ¡Con gusto te ayudamos a contratar!\n\nPara iniciar tu solicitud, escribe *CONTRATAR* y te pediremos tus datos paso a paso.`;
  }

  if (["6", "cobertura", "horarios", "cobertura y horarios", "zonas de cobertura"].includes(option)) {
    return `📍 *COBERTURA Y HORARIOS – PIT COMUNICACIONES*\n\nTenemos servicio en La Libertad, Chiapas y algunas comunidades cercanas. La cobertura debe confirmarse según tu localidad y domicilio.\n\n🕒 Atención técnica:\nLunes a viernes: 7:00 a 18:00.\nSábado: 7:00 a 14:00.\nDomingo: sin atención técnica.\n\nDinos tu localidad o escribe *ASESOR* para solicitar que revisemos la cobertura.`;
  }

  if (["7", "tecnico", "tecnica", "hablar con un tecnico", "hablar con tecnico", "asesor"].includes(option) || isHumanSupportRequest(message)) {
    return `👨‍🔧 *SOLICITUD DE ATENCIÓN PERSONALIZADA*\n\nCon gusto canalizamos tu solicitud con un asesor o técnico.\n\nPor favor responde con:\n1️⃣ Tu nombre completo.\n2️⃣ Tu localidad o colonia.\n3️⃣ Si necesitas un *asesor* o un *técnico*.\n\nNuestro equipo dará seguimiento dentro del horario de atención.`;
  }

  if (["menu", "inicio", "principal", "hola", "buenas", "buenos dias", "buenas tardes", "buenas noches"].includes(option)) {
    return mainMenu();
  }

  return null;
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
  guideSessions.set(phone, { step: "poe_check", updatedAt: Date.now() });

  await sendWhatsAppMessage(phone, `📡 *VAMOS A REVISAR TU CONEXIÓN*

¡Claro! 😊 Vamos a revisar tu conexión. Empezaremos por el adaptador PoE y te iré indicando qué hacer en cada paso.`);

  await sendWhatsAppImage(phone, POE_IMAGE_URL, `🔌 *PASO 1. VERIFICAR LOS PUERTOS DEL ADAPTADOR PoE*

Identifica los dos cables:

⚫ *Cable negro:* es el que viene de la antena y debe estar conectado en el puerto que dice *POE*.

⚪ *Cable gris:* debe estar conectado en el puerto que dice *LAN*.

Verifica que estén conectados exactamente así.

¿El cable negro está en POE y el cable gris en LAN?

Responde *SI* o *NO*.`);
}

// CONTROL DE LA GUÍA
async function handleConnectionGuide(phone, message) {
  const session = guideSessions.get(phone);
  if (!session) return false;
  const answer = normalize(message);

  if (answer === "cancelar") {
    guideSessions.delete(phone);
    await sendWhatsAppMessage(phone, "De acuerdo. Hemos detenido la guía. Si necesitas ayuda, escribe MENU. También puedes escribir ASESOR o TECNICO para solicitar ayuda.");
    return true;
  }

  if (isHumanSupportRequest(message) || ["asesor", "tecnico"].includes(answer)) {
    await offerHumanSupport(phone, "El cliente solicita atención personal durante la guía de conexión.");
    return true;
  }

  if (!isYes(answer) && !isNo(answer)) {
    const prompts = {
      poe_check: "Responde SI si el cable negro está en POE y el gris en LAN, o NO si no están así.",
      poe_black_reseat: "Cuando hayas desconectado y vuelto a conectar el cable negro en el mismo puerto POE, responde SI. Si todavía no lo haces, responde NO.",
      poe_gray_reseat: "Cuando hayas desconectado y vuelto a conectar el cable gris en el mismo puerto LAN, responde SI. Si todavía no lo haces, responde NO.",
      router_check: "Responde SI si el cable gris que viene del PoE está conectado en WAN, o NO si está conectado en otro puerto.",
      router_wan_reseat: "Cuando hayas desconectado y vuelto a conectar el cable gris en el mismo puerto WAN, responde SI. Si todavía no lo haces, responde NO."
    };
    await sendWhatsAppMessage(phone, prompts[session.step] || "Para continuar con la revisión, responde SI o NO. También puedes escribir ASESOR para solicitar ayuda.");
    return true;
  }

  if (session.step === "poe_check") {
    if (isNo(answer)) {
      await sendWhatsAppMessage(phone, `Revisa la conexión del adaptador PoE:\n\n⚫ El cable negro que viene de la antena debe ir en *POE*.\n⚪ El cable gris que va hacia el router debe ir en *LAN*.\n\nSi alguno está en un puerto incorrecto, colócalo en el puerto indicado. No manipules el cable instalado en el exterior ni la antena.\n\nCuando ambos estén correctamente conectados, responde *SI*.`);
      session.updatedAt = Date.now();
      return true;
    }
    session.step = "poe_black_reseat";
    session.updatedAt = Date.now();
    await sendWhatsAppMessage(phone, `✅ Gracias. Confirmamos que los cables están en los puertos correctos.\n\n*PASO 2. DESCONECTAR Y CONECTAR EL CABLE NEGRO*\n\n1. Identifica el cable negro que viene de la antena y llega al adaptador PoE.\n2. Desconecta únicamente el extremo del cable negro que está conectado al puerto *POE* del adaptador.\n3. Espera aproximadamente 10 segundos.\n4. Vuelve a conectar ese mismo extremo en el puerto *POE*.\n\nCuando termines, responde *SI*. Si necesitas ayuda, escribe *ASESOR*.`);
    return true;
  }


  if (session.step === "poe_gray_reseat") {
    if (isNo(answer)) {
      await sendWhatsAppMessage(phone, "No hay problema. Desconecta el cable gris del puerto LAN, espera 10 segundos y vuelve a conectarlo en el mismo puerto LAN. Cuando termines, responde SI.");
      return true;
    }
    session.step = "router_check";
    session.updatedAt = Date.now();
    await sendWhatsAppMessage(phone, `✅ Listo. Ahora revisaremos el router.\n\n*PASO 4. VERIFICAR EL PUERTO WAN DEL ROUTER*\n\nEl cable gris que viene del puerto *LAN* del adaptador PoE debe llegar al puerto *WAN* del router.\n\n⚠️ Debe estar conectado en *WAN* o *Internet*, no en uno de los puertos *LAN*. Si está conectado en otro puerto, el router podría no recibir Internet correctamente.\n\nObserva la imagen y verifica la conexión.\n\n¿El cable gris que viene del PoE está conectado en el puerto *WAN* del router?\n\nResponde *SI* o *NO*.`);
    await sendWhatsAppImage(phone, ROUTER_IMAGE_URL, "📶 Identifica el puerto marcado como WAN o Internet en tu router. No presiones RESET ni cambies otros cables.");
    return true;
  }

  if (session.step === "router_check") {
    if (isNo(answer)) {
      await sendWhatsAppMessage(phone, `Revisa el cable gris que viene del adaptador PoE y asegúrate de que llegue al puerto *WAN* o *Internet* del router.\n\nSi está conectado en un puerto LAN, con cuidado colócalo en el puerto WAN. No presiones RESET ni desconectes otros cables.\n\nCuando esté conectado en WAN, responde *SI*.`);
      return true;
    }
    session.step = "router_wan_reseat";
    session.updatedAt = Date.now();
    await sendWhatsAppMessage(phone, `✅ Correcto.\n\n*PASO 5. DESCONECTAR Y CONECTAR EL CABLE DEL PUERTO WAN*\n\n1. Ubica el cable gris que viene del adaptador PoE y está conectado en *WAN*.\n2. Desconéctalo del puerto *WAN* del router.\n3. Espera aproximadamente 10 segundos.\n4. Vuelve a conectarlo en el mismo puerto *WAN*.\n\nNo lo conectes en un puerto LAN y no presiones RESET.\n\nCuando termines, responde *SI*.`);
    return true;
  }

  if (session.step === "router_wan_reseat") {
    if (isNo(answer)) {
      await sendWhatsAppMessage(phone, "Está bien. Desconecta el cable gris del puerto WAN, espera 10 segundos y vuelve a conectarlo en ese mismo puerto WAN. Cuando termines, responde SI.");
      return true;
    }
    guideSessions.delete(phone);
    guideOffers.set(phone, { step: "internet_result", updatedAt: Date.now() });
    await sendWhatsAppMessage(phone, `✅ *PASOS DE CONEXIÓN COMPLETADOS*\n\nEspera aproximadamente un minuto para que los equipos recuperen la conexión.\n\nAhora comprueba si tus dispositivos ya tienen Internet.\n\n¿Ya puedes navegar?\n\nResponde:\n1️⃣ *SI*, ya tengo Internet.\n2️⃣ *NO*, sigo sin Internet.\n\nSi el problema continúa, podemos solicitar la atención de un técnico. También puedes escribir *ASESOR* o *TECNICO* en cualquier momento.`);
    return true;
  }
  return false;
}

// OFRECER ATENCIÓN DE UN ASESOR O TÉCNICO
async function offerHumanSupport(phone, reason) {
  salesOffers.delete(phone);
  guideOffers.delete(phone);
  guideSessions.delete(phone);
  salesSessions.delete(phone);
  paymentFollowups.delete(phone);

  supportSessions.set(phone, {
    step: "name",
    name: "",
    locality: "",
    reason: String(reason || "El cliente solicita atención personalizada."),
    updatedAt: Date.now()
  });

  await sendWhatsAppMessage(
    phone,
    `👨‍🔧 *ATENCIÓN PERSONALIZADA – PIT COMUNICACIONES*\n\nCon gusto canalizamos tu solicitud. Para que nuestro equipo pueda identificar tu caso, primero indícanos tu *nombre completo*.`
  );
}

async function handleSupportSession(phone, message) {
  const session = supportSessions.get(phone);
  if (!session) return false;
  const answer = String(message || "").trim();
  const normalized = normalize(answer);

  if (normalized === "cancelar") {
    supportSessions.delete(phone);
    await sendWhatsAppMessage(phone, "De acuerdo, hemos detenido la solicitud de atención. Cuando necesites ayuda, escribe ASESOR o TECNICO.");
    return true;
  }

  if (session.step === "name") {
    if (answer.length < 5 || !/[a-záéíóúñ]/i.test(answer) || /^(hola|buenas|asesor|tecnico|si|no)$/i.test(answer)) {
      await sendWhatsAppMessage(phone, "Por favor, escribe tu nombre completo y apellidos para registrar la solicitud.");
      return true;
    }
    session.name = answer;
    session.step = "locality";
    session.updatedAt = Date.now();
    await sendWhatsAppMessage(phone, `Gracias, ${session.name}. 😊\n\nAhora indícame tu *localidad, colonia o ejido*.`);
    return true;
  }

  if (session.step === "locality") {
    if (answer.length < 3) {
      await sendWhatsAppMessage(phone, "Por favor, indícame el nombre de tu localidad, colonia o ejido.");
      return true;
    }
    session.locality = answer;
    session.step = "type";
    session.updatedAt = Date.now();
    await sendWhatsAppMessage(phone, "¿Qué tipo de atención necesitas? Responde *ASESOR* para atención administrativa/ventas o *TECNICO* para una falla de Internet o instalación.");
    return true;
  }

  if (session.step === "type") {
    let supportType = "";
    if (["asesor", "ventas", "administrativo"].includes(normalized)) supportType = "Asesor";
    if (["tecnico", "tecnica", "soporte", "falla", "internet"].includes(normalized)) supportType = "Técnico";
    if (!supportType) {
      await sendWhatsAppMessage(phone, "Por favor responde *ASESOR* o *TECNICO* para indicar qué tipo de atención necesitas.");
      return true;
    }

    const summary = `SOLICITUD DE ATENCIÓN PIT COMUNICACIONES\nNombre: ${session.name}\nTeléfono: ${phone}\nLocalidad: ${session.locality}\nTipo: ${supportType}\nMotivo: ${session.reason}`;
    console.log("NUEVA SOLICITUD DE ATENCIÓN:\\n" + summary);
    supportSessions.delete(phone);
    await sendWhatsAppMessage(phone, `✅ *DATOS DE ATENCIÓN RECIBIDOS*\n\nNombre: ${session.name}\nLocalidad: ${session.locality}\nAtención solicitada: ${supportType}\n\nHemos registrado los datos de tu solicitud para que el equipo de PIT COMUNICACIONES pueda revisarlos. La atención se dará dentro del horario de servicio.\n\nSi necesitas agregar información, puedes responder a este chat.`);
    return true;
  }
  return true;
}

// RESPUESTA DE LA GUÍA Y SOLICITUD DE TÉCNICO
async function handleGuideOffer(phone, message) {
  const offer = guideOffers.get(phone);

  if (!offer) return false;

  const answer = normalize(message);

  if (offer.step === "internet_result") {
    if (
      answer === "1" ||
      answer.includes("si tengo internet") ||
      answer.includes("ya tengo internet") ||
      answer === "si"
    ) {
      guideOffers.delete(phone);

      await sendWhatsAppMessage(
        phone,
        `¡Excelente! 😊 Nos da gusto saber que ya tienes Internet. Si necesitas algo más, aquí estamos. ${getMexicoTimeContext().greeting}.`
      );

      return true;
    }

    if (
      answer === "2" ||
      answer === "no" ||
      answer.includes("sigo sin internet") ||
      answer.includes("no tengo internet")
    ) {
      offer.step = "request_technician";

      await sendWhatsAppMessage(
        phone,
        `Lamentamos que el problema continúe.

¿Deseas que solicitemos la atención de un técnico?

Responde:
1️⃣ Sí, quiero hablar con un técnico.
2️⃣ No, por ahora no.`
      );

      return true;
    }

    return false;
  }

  if (offer.step === "request_technician") {
    if (
      answer === "1" ||
      answer.includes("si") ||
      answer.includes("tecnico") ||
      answer.includes("técnico")
    ) {
      guideOffers.delete(phone);

      await offerHumanSupport(
        phone,
        "El cliente realizó la guía de conexión y continúa sin Internet. Solicita atención de un técnico."
      );

      return true;
    }

    if (answer === "2" || answer === "no") {
      guideOffers.delete(phone);

      await sendWhatsAppMessage(
        phone,
        "Entendido. Cuando necesites ayuda, aquí estaremos. Escribe MENU para ver las opciones."
      );

      return true;
    }

    return false;
  }

  return false;
}

// DETECCIÓN DE SOLICITUD DE ASESOR O TÉCNICO
// DETECCIÓN EXPLÍCITA DE FALLAS DE CONEXIÓN
// Tiene prioridad sobre consultas de pago para evitar falsos positivos
// en frases como "No tengo Internet desde el medio día".
function isConnectionIssueIntent(message) {
  const text = normalize(message);

  // Reconoce expresiones naturales aunque el cliente agregue cuándo comenzó la falla.
  const hasInternet = /\b(internet|conexion|servicio|wifi|senal|senal de internet)\b/.test(text);
  const reportsOutage = /\b(no tengo|no hay|sin|se fue|perdi|se cayo|no funciona|no conecta|no me conecta|estoy sin|me quede sin|llevo.*sin)\b/.test(text);
  const reportsIntermittent = /\b(lento|lentitud|cortes?|intermitente|se corta|se desconecta|falla|fallando|inestable)\b/.test(text);

  return (hasInternet && (reportsOutage || reportsIntermittent)) ||
    /\b(no tengo internet|sin internet|no hay internet|se fue el internet|me quede sin internet)\b/.test(text);
}

// CONSULTAS DE PAGO: exigir al menos un término inequívoco de pago.
// "dia" o "internet" por sí solos nunca deben activar esta respuesta.
function isPaymentQuestion(message) {
  const text = normalize(message);
  if (isConnectionIssueIntent(message)) return false;
  const hasPaymentTerm = /\b(pago|pagos|pagar|pagado|mensualidad|mensualidades|mora|recargo|atraso|comprobante|transferencia|oxxo)\b/.test(text);
  const hasPaymentQuestion = /\b(fecha|fechas|dia|dias|cuando|pago|pagos|pagar|mensualidad|mensualidades|mora|recargo|atraso|suspension|suspender|costo|cuanto|metodo|donde)\b/.test(text);
  return hasPaymentTerm && hasPaymentQuestion;
}

function isHumanSupportRequest(message) {
  const text = normalize(message);

  return (
    /hablar con (un )?(asesor|tecnico|tecnica)/.test(text) ||
    /quiero (un )?(asesor|tecnico|tecnica)/.test(text) ||
    /necesito (un )?(asesor|tecnico|tecnica)/.test(text) ||
    /atencion (de un )?(asesor|tecnico)/.test(text) ||
    /que me atienda/.test(text) ||
    /contactar (a )?(un )?(asesor|tecnico)/.test(text) ||
    /persona real/.test(text) ||
    /agente humano/.test(text)
  );
}

// VENTAS: DETECCIÓN DE INTENCIÓN
function isSalesIntent(message) {
  const text = normalize(message);

  return (
    /contratar/.test(text) ||
    /quiero internet/.test(text) ||
    /poner internet/.test(text) ||
    /instalar internet/.test(text) ||
    /me interesa el plan/.test(text) ||
    /quiero el servicio/.test(text) ||
    /darme de alta/.test(text) ||
    /informacion para contratar/.test(text) ||
    /informes para contratar/.test(text)
  );
}

// VENTAS: INICIAR SOLICITUD
async function startSalesSession(phone) {
  salesOffers.delete(phone);

  salesSessions.set(phone, {
    step: "name",
    name: "",
    locality: "",
    address: "",
    reference: "",
    updatedAt: Date.now()
  });

  await sendWhatsAppMessage(
    phone,
    `🏠 *¡QUÉ BUENO QUE TE INTERESA CONTRATAR!*

Con gusto te ayudamos a solicitar tu instalación.

Para comenzar, ¿me puedes proporcionar tu *nombre completo*?`
  );
}

// VENTAS: VALIDAR DATOS
function isValidName(message) {
  const text = String(message || "").trim();

  return (
    text.length >= 5 &&
    text.length <= 100 &&
    /[a-zA-ZáéíóúÁÉÍÓÚñÑ]/.test(text) &&
    !/^(si|no|ok|menu|menú|hola|buenas|precio|cuanto|cuánto)$/i.test(text)
  );
}

function isValidLocality(message) {
  const text = String(message || "").trim();

  return text.length >= 3 && text.length <= 120;
}

function isValidAddress(message) {
  const text = String(message || "").trim();

  return text.length >= 5 && text.length <= 200;
}

// VENTAS: CAPTURAR INFORMACIÓN
async function handleSalesSession(phone, message) {
  const session = salesSessions.get(phone);

  if (!session) return false;

  const answer = String(message || "").trim();
  const normalizedAnswer = normalize(answer);

  if (normalizedAnswer === "cancelar") {
    salesSessions.delete(phone);

    await sendWhatsAppMessage(
      phone,
      "De acuerdo. Hemos cancelado tu solicitud de contratación. Cuando quieras continuar, escribe MENU."
    );

    return true;
  }

  if (isHumanSupportRequest(answer)) {
    salesSessions.delete(phone);

    await offerHumanSupport(
      phone,
      "El cliente está realizando una solicitud de contratación y solicita atención personalizada."
    );

    return true;
  }

  session.updatedAt = Date.now();

  if (session.step === "name") {
    if (!isValidName(answer)) {
      await sendWhatsAppMessage(
        phone,
        "Por favor, escribe tu nombre y apellidos para registrar correctamente tu solicitud."
      );

      return true;
    }

    session.name = answer;

    if (session.locality) {
      session.step = "address";
      await sendWhatsAppMessage(
        phone,
        `Gracias, ${session.name}. 😊\n\nTengo registrada tu localidad como ${session.locality}. Ahora indícame tu dirección o una ubicación cercana para identificar dónde sería la instalación.`
      );
    } else {
      session.step = "locality";
      await sendWhatsAppMessage(
        phone,
        `Gracias, ${session.name}. 😊

Ahora dime, ¿en qué localidad o colonia deseas contratar el servicio?`
      );
    }

    return true;
  }

  if (session.step === "locality") {
    if (!isValidLocality(answer)) {
      await sendWhatsAppMessage(
        phone,
        "Por favor, indícame el nombre de tu localidad, colonia o ejido."
      );

      return true;
    }

    session.locality = answer;
    session.step = "address";

    await sendWhatsAppMessage(
      phone,
      "Muy bien. Ahora indícame tu dirección o una ubicación cercana para identificar dónde sería la instalación."
    );

    return true;
  }

  if (session.step === "address") {
    if (!isValidAddress(answer)) {
      await sendWhatsAppMessage(
        phone,
        "Por favor, escribe una dirección, calle, colonia o referencia que nos ayude a localizar tu domicilio."
      );

      return true;
    }

    session.address = answer;
    session.step = "reference";

    await sendWhatsAppMessage(
      phone,
      "¿Hay alguna referencia para encontrar tu domicilio? Por ejemplo: cerca de una escuela, tienda, iglesia o parque. Si no tienes referencia, escribe NINGUNA."
    );

    return true;
  }

  if (session.step === "reference") {
    session.reference =
      normalizedAnswer === "ninguna" ? "Sin referencia adicional" : answer;

    session.step = "confirm";

    await sendWhatsAppMessage(
      phone,
      `📋 *RESUMEN DE TU SOLICITUD*

👤 Nombre: ${session.name}
📍 Localidad: ${session.locality}
🏠 Dirección: ${session.address}
📌 Referencia: ${session.reference}

¿Los datos son correctos?

Responde:
1️⃣ Sí, son correctos.
2️⃣ No, quiero corregirlos.`
    );

    return true;
  }

  if (session.step === "confirm") {
    if (answer === "1" || isYes(answer)) {
      const summary = {
        name: session.name,
        locality: session.locality,
        address: session.address,
        reference: session.reference
      };

      salesSessions.delete(phone);
      salesOffers.set(phone, {
        step: "confirmed",
        data: summary,
        updatedAt: Date.now()
      });

      await sendWhatsAppMessage(
        phone,
        `✅ *SOLICITUD REGISTRADA*

Gracias, ${summary.name}.

Hemos recibido tus datos para solicitar el servicio de Internet.

Un asesor de PIT COMUNICACIONES deberá revisar la cobertura y comunicarse contigo para continuar el proceso.

⚠️ Esta solicitud no significa que la instalación ya esté confirmada.

Si necesitas hablar con un asesor, escribe *ASESOR*.`
      );

      return true;
    }

    if (answer === "2" || isNo(answer)) {
      session.step = "name";

      await sendWhatsAppMessage(
        phone,
        "Vamos a corregir tus datos. Por favor, escribe nuevamente tu nombre completo."
      );

      return true;
    }

    await sendWhatsAppMessage(
      phone,
      "Responde 1 si los datos son correctos o 2 si deseas corregirlos."
    );

    return true;
  }

  return true;
}

// VENTAS: CONFIRMAR OFERTA, CONTINUAR CONTRATACIÓN O SOLICITAR ASESOR
// Esta función es síncrona para que el webhook pueda saber inmediatamente
// si el mensaje ya fue atendido. Los envíos de WhatsApp se ejecutan en segundo plano.
function handleSalesOfferAcceptance(phone, message) {
  const offer = salesOffers.get(phone);
  if (!offer) return false;

  const answer = normalize(message);

  if (isHumanSupportRequest(message) || answer === "asesor" || answer === "tecnico" || answer === "técnico") {
    salesOffers.delete(phone);
    offerHumanSupport(
      phone,
      "El cliente respondió a la oferta de contratación y desea hablar con un asesor o técnico."
    ).catch(error => console.error("ERROR SOLICITANDO ASESOR:", error));
    return true;
  }

  // La solicitud ya fue registrada; no volver a iniciar la contratación.
  if (offer.step === "confirmed") {
    if (["menu", "inicio", "principal"].includes(answer)) {
      salesOffers.delete(phone);
      sendWhatsAppMessage(phone, mainMenu()).catch(console.error);
      return true;
    }

    sendWhatsAppMessage(
      phone,
      "Tu solicitud ya fue recibida. Un asesor revisará la cobertura y se comunicará contigo. Si deseas atención personalizada, escribe ASESOR. Para ver el menú, escribe MENU."
    ).catch(console.error);
    return true;
  }

  // La IA ofreció ayudar a contratar. Solo iniciar el registro cuando el cliente acepta.
  if (isYes(message) || /^(contratar|quiero contratar|me interesa|si me interesa)$/.test(answer)) {
    const mentioned = getMentionedLocalities(message);
    let locality = mentioned.length === 1 ? mentioned[0] : "";

    if (!locality && Array.isArray(offer.localities) && offer.localities.length === 1) {
      locality = offer.localities[0];
    }

    salesOffers.delete(phone);
    salesSessions.set(phone, {
      step: "name",
      name: "",
      locality,
      address: "",
      reference: "",
      updatedAt: Date.now()
    });

    const question = locality
      ? `¡Con gusto te ayudamos con la contratación para ${locality}!

Para comenzar, ¿me compartes tu nombre completo?`
      : "¡Con gusto te ayudamos con la contratación! Primero, ¿me compartes tu nombre completo?";

    sendWhatsAppMessage(phone, question).catch(console.error);
    return true;
  }

  if (isNo(message)) {
    salesOffers.delete(phone);
    sendWhatsAppMessage(
      phone,
      "De acuerdo. Si más adelante deseas contratar Internet, escribe CONTRATAR. También puedes escribir MENU para ver las opciones."
    ).catch(console.error);
    return true;
  }

  // Mantener la conversación dentro de la oferta, sin dejar al cliente sin respuesta.
  sendWhatsAppMessage(
    phone,
    "¿Te gustaría iniciar tu solicitud de contratación? Responde SI para continuar, NO para dejarlo para después o ASESOR para recibir atención personalizada."
  ).catch(console.error);
  return true;
}

function getSalesQuestionReply(session, message) {
  const normalized = normalize(message);

  // FECHAS DE PAGO, MORA Y POSIBLE SUSPENSION
  const asksPaymentDates = !isConnectionIssueIntent(message) && isPaymentQuestion(message);

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
  const asksPaymentDates = isPaymentQuestion(message);

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

  const mexicoTime = getMexicoTimeContext();
  const instructions = `Eres el asesor virtual de PIT COMUNICACIONES, proveedor de Internet inalámbrico en La Libertad, Chiapas.

HORA LOCAL DE MÉXICO: ${mexicoTime.time}. SALUDO Y DESPEDIDA ADECUADOS: ${mexicoTime.greeting}.
REGLA DE HORARIO: usa "Buenos días" de 06:00 a 11:59, "Buenas tardes" de 12:00 a 18:59 y "Buenas noches" de 19:00 a 05:59. Aplica esta regla también a despedidas y frases como "que tengas...". Nunca uses "buen día" o "buenas tardes" si la hora local indica noche. No menciones la hora salvo que el cliente pregunte.

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
- Si el cliente hace una pregunta libre durante el diagnóstico, responde su duda de forma breve y amable; no reinicies la guía ni avances de paso por esa pregunta.
- Si no sabes responder una duda técnica con certeza, indícalo y ofrece atención de un técnico.
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

  for (const [phone, session] of paymentFollowups.entries()) {
    if (now - session.updatedAt > SESSION_TTL) paymentFollowups.delete(phone);
  }

  for (const [phone, session] of supportSessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL) supportSessions.delete(phone);
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

// SEGUIMIENTO DESPUÉS DE INFORMACIÓN DE PAGOS
function startPaymentFollowup(phone) {
  paymentFollowups.set(phone, { updatedAt: Date.now() });
}

async function handlePaymentFollowup(phone, message) {
  const answer = normalize(message);
  if (isHumanSupportRequest(message) || ["asesor", "tecnico"].includes(answer)) {
    paymentFollowups.delete(phone);
    await offerHumanSupport(phone, "El cliente solicita ayuda después de consultar la información de pagos.");
    return true;
  }
  await sendWhatsAppMessage(phone, `¡Con gusto! 😊 Estamos para ayudarte.\n\n¿Necesitas algo más?\n\n1️⃣ Reportar un problema de Internet.\n2️⃣ Consultar planes y precios.\n👨‍🔧 Escribe *ASESOR* para hablar con una persona.\n🏠 Escribe *MENU* para regresar al menú principal.\n\nTambién puedes contarme qué necesitas.`);
  return true;
}

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
          paymentFollowups.delete(from);
          supportSessions.delete(from);
          conversations.delete(from);

          sendWhatsAppMessage(from, mainMenu()).catch(console.error);
          continue;
        }

        // CONTINUAR CAPTURA DE DATOS PARA ASESOR O TÉCNICO
        if (supportSessions.has(from)) {
          handleSupportSession(from, text).catch(console.error);
          continue;
        }

        // SOLICITUD DIRECTA DE ASESOR O TÉCNICO
        if (isHumanSupportRequest(text) || ["asesor", "tecnico"].includes(normalized)) {
          offerHumanSupport(from, "El cliente solicita atención personalizada.").catch(console.error);
          continue;
        }

        // FALLAS DE CONEXIÓN: priorizar antes de palabras como "día" o "servicio".
        // Así "No tengo Internet desde el medio día" inicia la guía y no muestra pagos.
        if (!guideSessions.has(from) && !guideOffers.has(from) && isConnectionIssueIntent(text)) {
          paymentFollowups.delete(from);
          startConnectionGuide(from).catch(console.error);
          continue;
        }

        // CONTINUAR DESPUÉS DE MOSTRAR INFORMACIÓN DE PAGOS
        if (paymentFollowups.has(from)) {
          const ack = ["gracias", "muchas gracias", "muy bien", "bien", "ok", "okay", "entendido", "perfecto", "esta bien", "de acuerdo"].includes(normalized);
          if (ack || isHumanSupportRequest(text) || ["asesor", "tecnico"].includes(normalized)) {
            handlePaymentFollowup(from, text).catch(console.error);
            continue;
          }
          paymentFollowups.delete(from);
        }

        // SI EXISTE UNA GUÍA EN CURSO, PRIORIZAR SUS RESPUESTAS.
        // Las preguntas distintas de SI/NO pasan a la IA sin borrar el paso actual.
        if (guideSessions.has(from)) {
          handleConnectionGuide(from, text)
            .then(async handled => {
              if (handled) return;
              const reply = await getAIReply(from, text);
              if (isCustomerPaused(from)) return;
              const current = guideSessions.get(from);
              const stepHints = {
                poe_check: "Cuando estés listo, dime si el cable negro está en POE y el gris en LAN.",
                poe_gray_reseat: "Cuando termines de reconectar el cable gris en LAN, responde SI.",
                router_check: "Cuando confirmes si el cable gris llega al puerto WAN del router, responde SI o NO.",
                router_wan_reseat: "Cuando termines de reconectar el cable en WAN, responde SI."
              };
              const reminder = current ? stepHints[current.step] : "";
              await sendWhatsAppMessage(from, reminder ? `${reply}\n\n${reminder}` : reply);
            })
            .catch(console.error);
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

        // RESULTADO FINAL DE LA GUÍA: procesarlo ANTES de cualquier aceptación genérica.
        // Así un SI al confirmar que volvió Internet no reinicia la guía.
        if (guideOffers.has(from)) {
          const currentOffer = guideOffers.get(from);
          if (currentOffer && typeof currentOffer === "object" && currentOffer.step) {
            handleGuideOffer(from, text)
              .then(async handled => {
                if (handled) return;
                const reply = await getAIReply(from, text);
                if (isCustomerPaused(from)) return;
                const stillOpen = guideOffers.get(from);
                let reminder = "";
                if (stillOpen?.step === "internet_result") {
                  reminder = "Cuando gustes, dime si ya puedes navegar: 1 para SI o 2 para NO.";
                } else if (stillOpen?.step === "request_technician") {
                  reminder = "Cuando gustes, responde 1 para solicitar un técnico o 2 si no necesitas atención por ahora.";
                }
                await sendWhatsAppMessage(from, reminder ? `${reply}\n\n${reminder}` : reply);
              })
              .catch(console.error);
            continue;
          }

          // Oferta previa de guía generada por IA (todavía no iniciada).
          if (isYes(text)) {
            startConnectionGuide(from).catch(console.error);
            continue;
          }
          if (isNo(text)) {
            guideOffers.delete(from);
            sendWhatsAppMessage(from, "De acuerdo. Si necesitas revisar tu conexión, escribe MENU y selecciona la opción 1.").catch(console.error);
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
          if (normalized === "7") {
            offerHumanSupport(from, "El cliente seleccionó la opción de hablar con un técnico.").catch(console.error);
            continue;
          }
          if (normalized === "3" || ["pagos", "pago", "informacion sobre pagos", "informacion de pagos"].includes(normalized)) {
            startPaymentFollowup(from);
          }
          if (normalized === "5") startSalesSession(from);

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
    guideMode: "step-by-step-poe-router-reseat",
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
