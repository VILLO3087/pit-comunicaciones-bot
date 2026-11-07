// PIT COMUNICACIONES – Bot de WhatsApp
// Versión V8.2 (revisión completa)
// V8.1: "¿Y las mensualidades?" responde el precio mensual; la IA saluda una sola vez.
// V8.2: preguntas sin signos ("Pero la mensualidad que costo tiene") ya no se guardan como dirección.
//
// Cambios principales respecto a la versión anterior:
// - Se agregan funciones que se llamaban pero no existían
//   (startSales, getMentionedLocalities, getInstallationFee). Antes provocaban
//   errores y el bot se quedaba sin responder.
// - Detección de fallas ("no tengo Internet desde el medio día") ANTES que pagos.
// - La regla de pagos ya no se activa con "día", "cuándo", "corte" o "internet".
// - SÍ / NO se interpretan solo según la pregunta que el bot hizo.
// - Despedidas ("No, es todo, gracias") se reconocen en cualquier momento.
// - La IA recibe la hora de Ciudad de México y no puede decir "buen día" de noche.
// - Un solo flujo de contratación (antes había dos que se pisaban).
// - Los mensajes de un mismo cliente se procesan en orden (cola por cliente).
// - Se ignoran mensajes duplicados que Meta reenvía.

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
// OPCIONAL: número (con 52...) que recibe aviso de cada solicitud de técnico o contratación.
const NOTIFY_PHONE = process.env.NOTIFY_PHONE || "";
const TIME_ZONE = "America/Mexico_City";

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
const processedMessages = new Map();
const phoneQueues = new Map();

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
      await fs.promises.writeFile(tempFile, JSON.stringify(snapshot, null, 2), "utf8");
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
      if (typeof pauseUntil === "number" && Number.isFinite(pauseUntil) && pauseUntil > now) {
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
    { locality: "La Libertad, Chiapas", key: "libertad", feeMXN: 600 },
    { locality: "Emiliano Zapata, Tabasco", key: "zapata", feeMXN: 800 },
    { locality: "Ejido Morelos", key: "morelos", feeMXN: 1200 }
  ],
  paymentMethods: ["Efectivo", "Transferencia bancaria", "Depósito en OXXO"],
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

// =====================================================================
// UTILIDADES DE TEXTO
// =====================================================================
function normalize(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Normaliza y quita signos, emojis y espacios repetidos.
function clean(text) {
  return normalize(text)
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Confirmaciones estrictas para preguntas generales (contratación, ofertas).
function isYes(text) {
  return /^(si|sip|ok|okay|de acuerdo|correcto|claro|claro que si|adelante|continuar|si por favor|si esta bien|si claro|si gracias)$/.test(clean(text));
}

function isNo(text) {
  return /^(no|nop|negativo|no gracias|no por ahora|por ahora no|aun no|todavia no|no muchas gracias)$/.test(clean(text));
}

// Respuestas a un paso de la guía ("¿Ya lo hiciste?", "¿Están así?").
// No incluye "ok" porque muchos clientes lo usan como "entendido, ahora lo hago".
function getStepAnswer(text) {
  const v = clean(text);
  if (/^(si|sip|simon|1|listo|hecho|ya|ya lo hice|ya quedo|ya esta|ya estan|ya lo conecte|ya los conecte|ya termine|si ya|si ya lo hice|si ya esta|si ya estan|si listo|si estan|si esta|si asi esta|si asi estan|asi esta|asi estan|si estan asi|si esta asi|estan bien|esta bien|correcto|si correcto|si gracias|listo gracias|ya gracias|ok listo|ok ya|ok ya lo hice|si ya lo conecte|si ya quedo|ya lo desconecte y conecte|si ya termine)$/.test(v)) return "yes";
  if (/^(no|nop|2|no estan|no esta|no estan asi|no esta asi|todavia no|aun no|no lo he hecho|no estan bien|esta mal|estan mal|estan al reves|esta al reves|no lo encuentro|no los encuentro)$/.test(v)) return "no";
  return null;
}

// El cliente dice explícitamente que ya regresó el Internet.
function saysInternetIsBack(text) {
  const v = clean(text);
  if (/\b(sigo sin|todavia no|aun no|no tengo|no hay|no puedo|no funciona|no jala|no sirve)\b/.test(v)) return false;
  return /\b(ya tengo internet|si tengo internet|ya tengo senal|ya hay internet|ya regreso|ya volvio|ya puedo navegar|si puedo navegar|ya navega|ya funciona|ya jala|ya sirve|ya quedo|ya se arreglo|ya se soluciono|ya conecta|ya me conecte|ya agarro)\b/.test(v);
}

// Resultado de "¿Ya puedes navegar? 1 SÍ / 2 NO".
function getInternetResultAnswer(text) {
  const v = clean(text);
  if (/^(2|no|nop|no nada|nada|sigue igual|igual|sigo igual|todavia no|aun no)$/.test(v)) return "no";
  if (/\b(sigo sin|sigue sin|todavia no|aun no|no tengo|no hay|no puedo navegar|no funciona|no jala|no sirve|sigue fallando|continua la falla|sigue igual|sigo igual)\b/.test(v)) return "no";
  if (/^(1|si|sip|claro|correcto|si gracias|si ya|ya)$/.test(v)) return "yes";
  if (saysInternetIsBack(v)) return "yes";
  return null;
}

// Despedidas y agradecimientos: "No, es todo, gracias", "Ok gracias", "Gracias buenas noches".
const CLOSING_WORDS = new Set([
  "no", "es", "todo", "seria", "eso", "nada", "mas", "por", "ahora", "gracias", "muchas", "mil",
  "ok", "okay", "vale", "listo", "muy", "amable", "bye", "adios", "hasta", "luego", "pronto",
  "bendiciones", "saludos", "sale", "perfecto", "excelente", "bien", "de", "acuerdo", "entendido",
  "buenas", "buenos", "noches", "tardes", "dias", "buen", "dia", "igualmente", "que", "tenga",
  "tengas", "usted", "tambien", "le", "te", "agradezco", "ya", "y", "e", "muchisimas", "mucho",
  "gusto", "un", "una", "feliz", "noche", "tarde", "lo", "dios", "bendiga", "gracia"
]);

function isClosing(text) {
  const v = clean(text);
  if (!v) return false;
  const words = v.split(" ");
  if (!words.every(word => CLOSING_WORDS.has(word))) return false;
  return /\b(gracias|gracia|es todo|seria todo|nada mas|adios|bye|hasta luego|hasta pronto|bendiciones|igualmente|agradezco|muy amable|dios te bendiga|dios le bendiga)\b/.test(v);
}

// "No, es todo" / "Adiós" (despedida fuerte) frente a un simple "gracias".
function isStrongClosing(text) {
  return isClosing(text) && /\b(es todo|seria todo|nada mas|adios|bye|hasta luego|hasta pronto|no gracias)\b/.test(clean(text));
}

// Reporte de falla: tiene prioridad sobre pagos.
function isOutageReport(text) {
  const v = clean(text);
  if (saysInternetIsBack(v)) return false;
  return (
    /\b(no tengo|no tenemos|sin|no hay|no me llega|no llega|no me (funciona|jala|sirve|agarra|conecta|carga)|se (me )?(fue|cayo|corto|quito|desconecto)|no (funciona|jala|sirve|agarra|conecta|carga|navega|abre))\b.*\b(internet|servicio|senal|conexion|wifi|wi fi|red|modem|antena|router)\b/.test(v) ||
    /\b(internet|servicio|senal|conexion|wifi|wi fi|red|modem|router)\b.*\b(no (funciona|sirve|jala|agarra|conecta|carga|hay|navega|abre|llega)|se (fue|cayo|corto|quito)|caido|cayo|fallando|falla|no tiene)\b/.test(v) ||
    /^(no tengo internet|sin internet|no hay internet|sin servicio|no tengo servicio|no tengo senal|sin senal)$/.test(v) ||
    /\b(foco rojo|luz roja)\b/.test(v)
  );
}

function isSlowReport(text) {
  const v = clean(text);
  return /\b(lento|lenta|lentitud|muy lento|se traba|se pone lento|intermitente|se corta a cada rato|va lento|anda lento|esta lento)\b/.test(v);
}

// Pregunta de pagos: exige palabras realmente relacionadas con pagos.
// Ya NO se activa con "día", "cuándo", "corte", "servicio" ni "internet" por sí solos.
function isPaymentQuestion(text) {
  const v = clean(text);
  return /\b(pago|pagos|pagar|pague|pagarle|mensualidad|mensualidades|mora|recargo|recargos|adeudo|atraso|atrasado|vencimiento|vence|cuenta para depositar|numero de cuenta|transferencia|deposito|oxxo|comprobante|corte por falta de pago|suspension por falta de pago|me suspendieron)\b/.test(v);
}

// "¿Y las mensualidades?", "¿Cuánto es la mensualidad?": pregunta de PRECIO, no de fechas.
function isMonthlyPriceQuestion(text) {
  const v = clean(text);
  if (!/\b(mensualidad|mensualidades|mensual|al mes|por mes|cada mes|renta mensual)\b/.test(v)) return false;
  return !/\b(fecha|fechas|dia|dias|cuando|donde|pagar|pago|pagos|pague|mora|recargo|recargos|atraso|vence|vencimiento|oxxo|transferencia|deposito|comprobante|debo|adeudo)\b/.test(v);
}

function isPriceQuestion(text) {
  const v = clean(text);
  return /\b(cuanto (cuesta|es|sale|cobran|vale)|precio|precios|costo|costos|planes|plan familiar|velocidad|cuantos megas|cuantos mbps|megas)\b/.test(v);
}

function isSalesIntent(message) {
  const text = clean(message);
  return (
    /\bcontratar\b/.test(text) ||
    /\bquiero (el )?internet\b/.test(text) ||
    /\b(poner|instalar|instalen|pongan) (el )?internet\b/.test(text) ||
    /\bme interesa (el plan|el servicio|contratar)\b/.test(text) ||
    /\bquiero el servicio\b/.test(text) ||
    /\bdarme de alta\b/.test(text) ||
    /\b(informacion|informes) para contratar\b/.test(text) ||
    /\bnueva instalacion\b/.test(text)
  );
}

function isHumanSupportRequest(message) {
  const text = clean(message);
  return (
    /^(asesor|tecnico|tecnica|asesor de ventas|ventas|7)$/.test(text) ||
    /hablar con (un |una )?(asesor|asesora|tecnico|tecnica|persona|humano)/.test(text) ||
    /(quiero|necesito|ocupo|mandeme|manden|envien) (un |una |al |a un )?(asesor|asesora|tecnico|tecnica)/.test(text) ||
    /atencion (de un )?(asesor|tecnico)/.test(text) ||
    /que me atienda/.test(text) ||
    /contactar (a )?(un )?(asesor|tecnico)/.test(text) ||
    /persona real/.test(text) ||
    /agente humano/.test(text)
  );
}

function looksLikeQuestion(text) {
  const normalized = clean(text).replace(/^(pero|oye|oiga|y|ah|ok|okay|disculpe|disculpa|una pregunta|pregunta)\s+/, "");
  return (
    /[?¿]/.test(text) ||
    /^(que|cual|cuales|cuanto|cuanta|cuantos|como|cuando|donde|por que|porque|y las|y la|y el|y los|aceptan|tienen|manejan|cuesta|costo|precio|mensualidad|mensualidades|plan|velocidad|puedo|se puede|hay|las|la|el|los)\b.*\b(cuesta|costo|precio|cobran|sale|cuanto|que|cual|como|cuando)\b/.test(normalized) ||
    /^(que|cual|cuales|cuanto|cuanta|cuantos|como|cuando|por que|porque|aceptan|tienen|manejan|cuesta|puedo|se puede)\b/.test(normalized) ||
    /\b(cuanto (cuesta|es|sale|cobran|vale|seria)|que (costo|precio) tiene|cual es el (costo|precio)|que cuesta|cuanto me (sale|cobran))\b/.test(normalized)
  );
}

// LOCALIDADES E INSTALACIÓN (antes se llamaban pero no existían)
function getMentionedLocalities(text) {
  const v = clean(text);
  return businessInfo.installation
    .filter(item => new RegExp(`\\b${item.key}\\b`).test(v))
    .map(item => item.locality);
}

function getInstallationFee(locality) {
  const v = clean(locality);
  const match = businessInfo.installation.find(item => new RegExp(`\\b${item.key}\\b`).test(v));
  return match ? match.feeMXN : null;
}

// HORA DE CIUDAD DE MÉXICO
function getMexicoHour(date = new Date()) {
  const parts = new Intl.DateTimeFormat("es-MX", { timeZone: TIME_ZONE, hour: "numeric", hourCycle: "h23" }).formatToParts(date);
  return Number(parts.find(part => part.type === "hour").value) % 24;
}

function getTimeGreeting(date = new Date()) {
  const hour = getMexicoHour(date);
  if (hour >= 5 && hour < 12) return "buenos días";
  if (hour >= 12 && hour < 19) return "buenas tardes";
  return "buenas noches";
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function getMexicoDateText(date = new Date()) {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

// Si la IA escribe un saludo que no corresponde a la hora, se corrige.
function fixGreetings(text) {
  const correct = getTimeGreeting();
  return String(text || "").replace(/\b(buen(?:os)? d[ií]as?|buenas tardes|buenas noches)\b/gi, match => {
    if (/^\s*buen d[ií]a\s*$/i.test(match) || normalize(match) !== correct) {
      return match.charAt(0) === match.charAt(0).toUpperCase() ? capitalize(correct) : correct;
    }
    return match;
  });
}

// SALUDAR UNA SOLA VEZ: después del primer saludo, la IA ya no repite "buenas noches".
const lastGreetings = new Map();
const GREETING_WINDOW = 6 * 60 * 60 * 1000;

function markGreeted(phone) {
  lastGreetings.set(phone, Date.now());
}

function wasGreetedRecently(phone) {
  const at = lastGreetings.get(phone);
  return Boolean(at && Date.now() - at < GREETING_WINDOW);
}

function startsWithGreeting(text) {
  return /^\s*[¡!]?\s*(hola|buen(os|as)?\s+(d[ií]as?|tardes|noches))\b/i.test(String(text || ""));
}

// Quita "Buenas noches," / "¡Hola, buenas noches!" del inicio de la respuesta.
function stripLeadingGreeting(text) {
  const stripped = String(text || "")
    .replace(/^\s*[¡!]?\s*(hola\s*[,!.]?\s*)?(buen(os|as)?\s+(d[ií]as?|tardes|noches)\s*)?[,.!]*\s*/i, "")
    .trim();
  return stripped ? capitalize(stripped) : String(text || "").trim();
}

function farewellMessage() {
  return `¡Con gusto! 😊 Gracias por comunicarte con *PIT COMUNICACIONES*. Si necesitas algo más, escribe *MENU*. ¡Que tengas ${getTimeGreeting()}!`;
}

// MEMORIA
function getConversation(phone) {
  const session = conversations.get(phone);

  if (!session || Date.now() - session.updatedAt > SESSION_TTL) {
    const fresh = { messages: [], updatedAt: Date.now() };
    conversations.set(phone, fresh);
    return fresh;
  }

  session.updatedAt = Date.now();
  return session;
}

function sessionTextForSales(phone, currentMessage) {
  const session = getConversation(phone);
  return [...session.messages.map(item => item.content || ""), currentMessage || ""].join(" ");
}

function saveConversation(phone, role, content) {
  if (typeof content !== "string" || !content) return;
  const session = getConversation(phone);
  session.messages.push({ role, content });
  session.messages = session.messages.slice(-MEMORY_LIMIT);
  session.updatedAt = Date.now();
}

function clearFlows(phone) {
  guideSessions.delete(phone);
  guideOffers.delete(phone);
  salesSessions.delete(phone);
  salesOffers.delete(phone);
  paymentFollowups.delete(phone);
  supportSessions.delete(phone);
}

// MENÚ
function mainMenu() {
  return `📡 *PIT COMUNICACIONES*

¡Hola, ${getTimeGreeting()}! 👋 Bienvenido.

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

const SLOW_REPLY = `🐢 *INTERNET LENTO – PIT COMUNICACIONES*\n\nVamos a revisar tu conexión.\n\n1️⃣ Reinicia tu módem o router desconectándolo durante 30 segundos.\n2️⃣ Conéctalo nuevamente y espera a que encienda por completo.\n3️⃣ Comprueba si mejora la conexión.\n\nSi el problema continúa, escribe *ASESOR* para solicitar ayuda de un técnico.`;

const PAYMENT_REPLY = `💳 *INFORMACIÓN DE PAGOS – PIT COMUNICACIONES*\n\n📅 Puedes realizar tu pago del día *15 al 20 de cada mes*.\n⚠️ A partir del día 21 se aplica un cargo adicional de *$30 MXN* por mora.\n🚫 El servicio puede ser suspendido por falta de pago.\n\nAceptamos efectivo, transferencia bancaria y depósito en OXXO.\n\nAl realizar tu pago, envía tu comprobante y nombre completo para verificarlo. No se confirma ningún pago hasta que sea revisado.\n\nSi necesitas apoyo, escribe *ASESOR*.`;

const MONTHLY_REPLY = `💰 *MENSUALIDAD – PIT COMUNICACIONES*\n\nLa mensualidad del *Plan Familiar* es de *$350 MXN*.\n\n📥 25 Mbps de descarga.\n📤 10 Mbps de subida.\n♾️ Navegación sin límite.\n\nLa mensualidad es la misma en todas las localidades; lo que cambia es el costo de instalación. Se paga del día 15 al 20 de cada mes.\n\n¿Te interesa contratar? Escribe *CONTRATAR*.`;

const PLAN_REPLY = `🚀 *PLAN FAMILIAR PIT COMUNICACIONES*\n\n📥 25 Mbps de descarga.\n📤 10 Mbps de subida.\n💰 *$350 MXN al mes.*\n♾️ Navegación sin límite.\n\n¿Te interesa contratar? Escribe *CONTRATAR*. Para hablar con ventas, escribe *ASESOR*.`;

const COVERAGE_REPLY = `📍 *COBERTURA Y HORARIOS – PIT COMUNICACIONES*\n\nTenemos servicio en La Libertad (Chiapas), Emiliano Zapata (Tabasco), Ejido Morelos y algunas comunidades cercanas. La cobertura debe confirmarse según tu localidad y domicilio.\n\n🕒 Atención técnica:\nLunes a viernes: 7:00 a 18:00.\nSábado: 7:00 a 14:00.\nDomingo: sin atención técnica.\n\nDinos tu localidad o escribe *ASESOR* para solicitar que revisemos la cobertura.`;

// Respuestas fijas del menú (opciones 2, 3, 4, 6 y saludos).
function getMenuReply(message) {
  const option = clean(message);

  if (["2", "internet lento", "mi internet esta lento", "mi internet va lento"].includes(option)) return SLOW_REPLY;
  if (["3", "pagos", "pago", "informacion sobre pagos", "informacion de pagos"].includes(option)) return PAYMENT_REPLY;
  if (["4", "planes", "precios", "planes y precios", "precio", "plan"].includes(option)) return PLAN_REPLY;
  if (["6", "cobertura", "horarios", "cobertura y horarios", "zonas de cobertura"].includes(option)) return COVERAGE_REPLY;
  if (/^(hola|holi|ola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|hola buenas|hola buenos dias|hola buenas tardes|hola buenas noches|menu|inicio|principal|que tal|hola que tal)$/.test(option)) return mainMenu();

  return null;
}

// =====================================================================
// ENVÍO A WHATSAPP
// =====================================================================
async function callWhatsApp(payload) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Faltan variables de WhatsApp.");
    return false;
  }

  try {
    const response = await fetch(`https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("ERROR ENVIANDO A WHATSAPP:", JSON.stringify(result));
      return false;
    }
    return true;
  } catch (error) {
    console.error("ERROR DE RED CON WHATSAPP:", error);
    return false;
  }
}

async function sendWhatsAppMessage(to, message) {
  if (typeof message !== "string" || !message.trim()) return false;
  const ok = await callWhatsApp({ to, type: "text", text: { body: message.slice(0, 4000) } });
  if (ok) console.log("Texto enviado a:", to);
  return ok;
}

async function sendWhatsAppImage(to, imageUrl, caption) {
  const ok = await callWhatsApp({ to, type: "image", image: { link: imageUrl, caption } });
  if (ok) console.log("Imagen enviada a:", to);
  return ok;
}

// Responde y guarda en la memoria de la conversación.
async function reply(phone, userText, message) {
  saveConversation(phone, "user", userText);
  saveConversation(phone, "assistant", message);
  return sendWhatsAppMessage(phone, message);
}

async function notifyTeam(summary) {
  console.log(summary);
  if (!NOTIFY_PHONE) return;
  const ok = await sendWhatsAppMessage(NOTIFY_PHONE, summary);
  if (!ok) console.error("No se pudo avisar a NOTIFY_PHONE (puede requerir que ese número haya escrito al bot en las últimas 24 h).");
}

// =====================================================================
// GUÍA DE CONEXIÓN PASO A PASO
// =====================================================================
const STEP_PROMPTS = {
  poe_check: "¿El cable negro está en el puerto *POE* y el cable gris en el puerto *LAN*? Responde *SI* o *NO*.",
  poe_black_reseat: "Cuando hayas desconectado y vuelto a conectar el cable negro en el mismo puerto *POE*, responde *SI*.",
  poe_gray_reseat: "Cuando hayas desconectado y vuelto a conectar el cable gris en el mismo puerto *LAN*, responde *SI*.",
  router_check: "¿El cable gris que viene del PoE está conectado en el puerto *WAN* del router? Responde *SI* o *NO*.",
  router_wan_reseat: "Cuando hayas desconectado y vuelto a conectar el cable gris en el mismo puerto *WAN*, responde *SI*."
};

const GUIDE_HELP = "Si necesitas ayuda, escribe *TECNICO*. Para detener la guía, escribe *CANCELAR*.";

async function startConnectionGuide(phone) {
  clearFlows(phone);
  guideSessions.set(phone, { step: "poe_check", updatedAt: Date.now() });

  await sendWhatsAppMessage(phone, `📡 *VAMOS A REVISAR TU CONEXIÓN*

Lamentamos la falla. Te ayudaré paso a paso; esperaré tu respuesta antes de continuar.

Primero revisaremos el adaptador PoE. Observa la fotografía y por ahora no desconectes nada.`);

  await sendWhatsAppImage(phone, POE_IMAGE_URL, `🔌 *PASO 1. VERIFICAR LOS PUERTOS DEL ADAPTADOR PoE*

Identifica los dos cables:

⚫ *Cable negro:* es el que viene de la antena y debe estar conectado en el puerto que dice *POE*.

⚪ *Cable gris:* debe estar conectado en el puerto que dice *LAN*.

Verifica que estén conectados exactamente así.

¿El cable negro está en POE y el cable gris en LAN?

Responde *SI* o *NO*.`);
}

async function finishWithInternetBack(phone) {
  clearFlows(phone);
  await sendWhatsAppMessage(phone, `¡Excelente! 😊 Nos da gusto que tu servicio haya quedado funcionando. Si necesitas algo más, escribe *MENU*. ¡Que tengas ${getTimeGreeting()}!`);
}

async function handleConnectionGuide(phone, message) {
  const session = guideSessions.get(phone);
  if (!session) return false;
  session.updatedAt = Date.now();

  // El cliente avisa que ya regresó el Internet a mitad de la guía.
  if (saysInternetIsBack(message)) {
    await finishWithInternetBack(phone);
    return true;
  }

  // "No, es todo, gracias" / "Adiós": terminar sin abrir reporte.
  if (isStrongClosing(message)) {
    guideSessions.delete(phone);
    await sendWhatsAppMessage(phone, `De acuerdo, detenemos la guía. ${farewellMessage()}`);
    return true;
  }

  const answer = getStepAnswer(message);

  if (!answer) {
    // Simple "gracias" u "ok": no avanzar, solo recordar el paso.
    if (isClosing(message) || /^(ok|okay|va|vale|sale|entendido|enterado|esta bien|bueno|deja veo|dejame ver|ahorita|un momento|espera|permiteme)$/.test(clean(message))) {
      await sendWhatsAppMessage(phone, `Con gusto, aquí te espero. 😊\n\n${STEP_PROMPTS[session.step]}`);
      return true;
    }
    // Pregunta o comentario diferente: la IA responde y se conserva el paso.
    const aiReply = await getAIReply(phone, message, { context: `El cliente está en la guía de conexión, paso "${session.step}". La pregunta pendiente es: ${STEP_PROMPTS[session.step]} No avances pasos ni des otros pasos técnicos.` });
    await sendWhatsAppMessage(phone, `${aiReply}\n\n${STEP_PROMPTS[session.step]}\n\n${GUIDE_HELP}`);
    return true;
  }

  if (session.step === "poe_check") {
    if (answer === "no") {
      await sendWhatsAppMessage(phone, `Revisa la conexión del adaptador PoE:\n\n⚫ El cable negro que viene de la antena debe ir en *POE*.\n⚪ El cable gris que va hacia el router debe ir en *LAN*.\n\nSi alguno está en un puerto incorrecto, colócalo en el puerto indicado. No manipules el cable instalado en el exterior ni la antena.\n\nCuando ambos estén correctamente conectados, responde *SI*.`);
      return true;
    }
    session.step = "poe_black_reseat";
    await sendWhatsAppMessage(phone, `✅ Gracias. Confirmamos que los cables están en los puertos correctos.\n\n*PASO 2. DESCONECTAR Y CONECTAR EL CABLE NEGRO*\n\n1. Identifica el cable negro que viene de la antena y llega al adaptador PoE.\n2. Desconecta únicamente el extremo del cable negro que está conectado al puerto *POE* del adaptador.\n3. Espera aproximadamente 10 segundos.\n4. Vuelve a conectar ese mismo extremo en el puerto *POE*.\n\nCuando termines, responde *SI*. Si necesitas ayuda, escribe *TECNICO*.`);
    return true;
  }

  if (session.step === "poe_black_reseat") {
    if (answer === "no") {
      await sendWhatsAppMessage(phone, "No hay problema. Identifica el cable negro que viene de la antena y llega al adaptador PoE. Desconecta únicamente el extremo que está conectado al puerto POE, espera 10 segundos y vuelve a conectar ese mismo extremo en el puerto POE. Cuando termines, responde *SI*.");
      return true;
    }
    session.step = "poe_gray_reseat";
    await sendWhatsAppMessage(phone, `✅ Muy bien.\n\n*PASO 3. DESCONECTAR Y CONECTAR EL CABLE GRIS DEL PoE*\n\n1. Ubica el cable gris conectado en el puerto *LAN* del adaptador PoE.\n2. Desconéctalo del puerto *LAN*.\n3. Espera aproximadamente 10 segundos.\n4. Vuelve a conectarlo en el mismo puerto *LAN*.\n\nNo lo conectes en POE ni en otro puerto.\n\nCuando termines, responde *SI*.`);
    return true;
  }

  if (session.step === "poe_gray_reseat") {
    if (answer === "no") {
      await sendWhatsAppMessage(phone, "No hay problema. Desconecta el cable gris del puerto LAN, espera 10 segundos y vuelve a conectarlo en el mismo puerto LAN. Cuando termines, responde *SI*.");
      return true;
    }
    session.step = "router_check";
    await sendWhatsAppMessage(phone, `✅ Listo. Ahora revisaremos el router.\n\n*PASO 4. VERIFICAR EL PUERTO WAN DEL ROUTER*\n\nEl cable gris que viene del puerto *LAN* del adaptador PoE debe llegar al puerto *WAN* del router.\n\n⚠️ Debe estar conectado en *WAN* o *Internet*, no en uno de los puertos *LAN*. Si está conectado en otro puerto, el router podría no recibir Internet correctamente.\n\nObserva la imagen y verifica la conexión.\n\n¿El cable gris que viene del PoE está conectado en el puerto *WAN* del router?\n\nResponde *SI* o *NO*.`);
    await sendWhatsAppImage(phone, ROUTER_IMAGE_URL, "📶 Identifica el puerto marcado como WAN o Internet en tu router. No presiones RESET ni cambies otros cables.");
    return true;
  }

  if (session.step === "router_check") {
    if (answer === "no") {
      await sendWhatsAppMessage(phone, `Revisa el cable gris que viene del adaptador PoE y asegúrate de que llegue al puerto *WAN* o *Internet* del router.\n\nSi está conectado en un puerto LAN, con cuidado colócalo en el puerto WAN. No presiones RESET ni desconectes otros cables.\n\nCuando esté conectado en WAN, responde *SI*.`);
      return true;
    }
    session.step = "router_wan_reseat";
    await sendWhatsAppMessage(phone, `✅ Correcto.\n\n*PASO 5. DESCONECTAR Y CONECTAR EL CABLE DEL PUERTO WAN*\n\n1. Ubica el cable gris que viene del adaptador PoE y está conectado en *WAN*.\n2. Desconéctalo del puerto *WAN* del router.\n3. Espera aproximadamente 10 segundos.\n4. Vuelve a conectarlo en el mismo puerto *WAN*.\n\nNo lo conectes en un puerto LAN y no presiones RESET.\n\nCuando termines, responde *SI*.`);
    return true;
  }

  if (session.step === "router_wan_reseat") {
    if (answer === "no") {
      await sendWhatsAppMessage(phone, "Está bien. Desconecta el cable gris del puerto WAN, espera 10 segundos y vuelve a conectarlo en ese mismo puerto WAN. Cuando termines, responde *SI*.");
      return true;
    }
    guideSessions.delete(phone);
    guideOffers.set(phone, { step: "internet_result", updatedAt: Date.now() });
    await sendWhatsAppMessage(phone, `✅ *PASOS DE CONEXIÓN COMPLETADOS*\n\nEspera aproximadamente un minuto para que los equipos recuperen la conexión.\n\nAhora comprueba si tus dispositivos ya tienen Internet.\n\n¿Ya puedes navegar?\n\nResponde:\n1️⃣ *SI*, ya tengo Internet.\n2️⃣ *NO*, sigo sin Internet.`);
    return true;
  }

  guideSessions.delete(phone);
  return false;
}

// Oferta de guía hecha por la IA, resultado final de la guía y solicitud de técnico.
async function handleGuideOffer(phone, message) {
  const offer = guideOffers.get(phone);
  if (!offer) return false;
  offer.updatedAt = Date.now();

  if (offer.step === "accept_guide") {
    if (isYes(message) || /^(si por favor|enviala|mandala|si enviala|si mandala|si envia la guia|claro que si|va|sale|si quiero)$/.test(clean(message))) {
      await startConnectionGuide(phone);
      return true;
    }
    if (isNo(message) || isClosing(message)) {
      guideOffers.delete(phone);
      await sendWhatsAppMessage(phone, isClosing(message) ? farewellMessage() : "De acuerdo. Si después deseas revisar tu conexión, aquí estaremos. También puedes escribir *MENU* para ver las opciones.");
      return true;
    }
    // Otro tema: la oferta se descarta y el mensaje se procesa normalmente.
    guideOffers.delete(phone);
    return false;
  }

  if (offer.step === "internet_result") {
    const result = getInternetResultAnswer(message);
    if (result === "yes") {
      await finishWithInternetBack(phone);
      return true;
    }
    if (result === "no") {
      offer.step = "request_technician";
      await sendWhatsAppMessage(phone, "Lamentamos que el problema continúe.\n\n¿Deseas que solicitemos la atención de un técnico?\n\nResponde:\n1️⃣ Sí, quiero un técnico.\n2️⃣ No, por ahora no.");
      return true;
    }
    if (isClosing(message)) {
      guideOffers.delete(phone);
      await sendWhatsAppMessage(phone, farewellMessage());
      return true;
    }
    const aiReply = await getAIReply(phone, message, { context: "El cliente terminó la guía de conexión. Falta que diga si ya tiene Internet. No des más pasos técnicos." });
    await sendWhatsAppMessage(phone, `${aiReply}\n\nPara indicarme el resultado de la revisión, responde *1* si ya tienes Internet o *2* si sigues sin servicio.`);
    return true;
  }

  if (offer.step === "request_technician") {
    const v = clean(message);
    if (isYes(message) || /^(1|si quiero|si quiero un tecnico|quiero un tecnico|necesito un tecnico|tecnico|si por favor|si mandenlo|si manden al tecnico|por favor)$/.test(v)) {
      await offerHumanSupport(phone, "El cliente realizó la guía de conexión y continúa sin Internet. Solicita atención de un técnico.");
      return true;
    }
    if (isNo(message) || v === "2" || isClosing(message)) {
      guideOffers.delete(phone);
      await sendWhatsAppMessage(phone, isClosing(message) ? farewellMessage() : "Entendido. Cuando necesites ayuda, aquí estaremos. Escribe *MENU* para ver las opciones.");
      return true;
    }
    const aiReply = await getAIReply(phone, message, { context: "El cliente sigue sin Internet después de la guía. Se le preguntó si quiere un técnico. No des pasos técnicos." });
    await sendWhatsAppMessage(phone, `${aiReply}\n\nResponde *1* para solicitar un técnico o *2* si no necesitas atención por ahora.`);
    return true;
  }

  guideOffers.delete(phone);
  return false;
}

// =====================================================================
// ATENCIÓN DE ASESOR O TÉCNICO
// =====================================================================
async function offerHumanSupport(phone, reason) {
  clearFlows(phone);

  supportSessions.set(phone, {
    step: "name",
    name: "",
    locality: "",
    reason: String(reason || "El cliente solicita atención personalizada."),
    updatedAt: Date.now()
  });

  await sendWhatsAppMessage(phone, `👨‍🔧 *ATENCIÓN PERSONALIZADA – PIT COMUNICACIONES*\n\nCon gusto canalizamos tu solicitud. Para que nuestro equipo pueda identificar tu caso, primero indícanos tu *nombre completo*.\n\nPara cancelar, escribe *CANCELAR*.`);
}

async function handleSupportSession(phone, message) {
  const session = supportSessions.get(phone);
  if (!session) return false;
  const answer = String(message || "").trim();
  const normalized = clean(answer);
  session.updatedAt = Date.now();

  if (session.step === "name") {
    if (isStrongClosing(answer) || isNo(answer)) {
      supportSessions.delete(phone);
      await sendWhatsAppMessage(phone, `De acuerdo, no registramos la solicitud. ${farewellMessage()}`);
      return true;
    }
    if (!isValidName(answer)) {
      await sendWhatsAppMessage(phone, "Por favor, escribe tu nombre completo y apellidos para registrar la solicitud.");
      return true;
    }
    session.name = answer;
    session.step = "locality";
    await sendWhatsAppMessage(phone, `Gracias, ${session.name}. 😊\n\nAhora indícame tu *localidad, colonia o ejido*.`);
    return true;
  }

  if (session.step === "locality") {
    if (!isValidLocality(answer)) {
      await sendWhatsAppMessage(phone, "Por favor, indícame el nombre de tu localidad, colonia o ejido.");
      return true;
    }
    session.locality = answer;
    session.step = "type";
    await sendWhatsAppMessage(phone, "¿Qué tipo de atención necesitas? Responde *ASESOR* para atención administrativa/ventas o *TECNICO* para una falla de Internet o instalación.");
    return true;
  }

  if (session.step === "type") {
    let supportType = "";
    if (/\b(asesor|asesora|ventas|administrativo|administrativa|pago|pagos)\b/.test(normalized)) supportType = "Asesor";
    if (/\b(tecnico|tecnica|soporte|falla|internet|instalacion)\b/.test(normalized)) supportType = "Técnico";
    if (!supportType) {
      await sendWhatsAppMessage(phone, "Por favor responde *ASESOR* o *TECNICO* para indicar qué tipo de atención necesitas.");
      return true;
    }

    supportSessions.delete(phone);
    await notifyTeam(`🔔 SOLICITUD DE ATENCIÓN PIT COMUNICACIONES\nNombre: ${session.name}\nTeléfono: ${phone}\nLocalidad: ${session.locality}\nTipo: ${supportType}\nMotivo: ${session.reason}`);
    await sendWhatsAppMessage(phone, `✅ *DATOS DE ATENCIÓN RECIBIDOS*\n\nNombre: ${session.name}\nLocalidad: ${session.locality}\nAtención solicitada: ${supportType}\n\nHemos registrado tu solicitud para que el equipo de PIT COMUNICACIONES la revise. La atención se dará dentro del horario de servicio (lunes a viernes 7:00 a 18:00, sábado 7:00 a 14:00).\n\nSi necesitas agregar información, puedes responder a este chat.`);
    return true;
  }

  supportSessions.delete(phone);
  return false;
}

// =====================================================================
// CONTRATACIÓN (un solo flujo)
// =====================================================================
function isValidName(message) {
  const text = String(message || "").trim();
  return (
    text.length >= 5 &&
    text.length <= 100 &&
    /[a-zA-ZáéíóúÁÉÍÓÚñÑ]/.test(text) &&
    !/\d{3,}/.test(text) &&
    !looksLikeQuestion(text) &&
    !isClosing(text) &&
    !/^(si|no|ok|menu|menú|hola|buenas|precio|cuanto|cuánto|asesor|tecnico|técnico)$/i.test(text)
  );
}

function isValidLocality(message) {
  const text = String(message || "").trim();
  return text.length >= 3 && text.length <= 120 && !looksLikeQuestion(text);
}

function isValidAddress(message) {
  const text = String(message || "").trim();
  return text.length >= 5 && text.length <= 200 && !looksLikeQuestion(text);
}

async function startSalesSession(phone, locality = "") {
  clearFlows(phone);
  salesSessions.set(phone, {
    step: "name",
    name: "",
    locality,
    address: "",
    reference: "",
    updatedAt: Date.now()
  });

  const intro = locality
    ? `🏠 *¡QUÉ BUENO QUE TE INTERESA CONTRATAR!*\n\nCon gusto te ayudamos con la solicitud para ${locality}.`
    : "🏠 *¡QUÉ BUENO QUE TE INTERESA CONTRATAR!*\n\nCon gusto te ayudamos a solicitar tu instalación.";

  await sendWhatsAppMessage(phone, `${intro}\n\nPara comenzar, ¿me puedes proporcionar tu *nombre completo*?\n\nPara cancelar, escribe *CANCELAR*.`);
}

// Nombre que usaba el código anterior.
const startSales = startSalesSession;

function salesPendingPrompt(session) {
  if (session.step === "name") return "Para continuar con tu contratación, todavía necesito tu *nombre completo y apellidos*.";
  if (session.step === "locality") return "Para continuar con tu solicitud, dime en qué *localidad o colonia* deseas el servicio.";
  if (session.step === "address") return "Para continuar con tu contratación, todavía necesito tu *dirección, calle o una referencia de ubicación*.";
  if (session.step === "reference") return "Para continuar, indícame una referencia de tu domicilio o escribe *NINGUNA*.";
  if (session.step === "confirm") return "Responde *1* si los datos son correctos o *2* si deseas corregirlos.";
  return "Seguimos con tu solicitud de contratación.";
}

function getSalesQuestionReply(session, message) {
  const normalized = clean(message);

  const asksOtherPlans = /\b(otro|otra|otros|otras|mas|diferente|diferentes)\b.*\b(plan|planes|paquete|paquetes|opcion|opciones)\b|\b(plan|planes|paquete|paquetes)\b.*\b(otro|otra|diferente|diferentes|adicional|adicionales|distinto|distintos|mas)\b/.test(normalized);
  if (asksOtherPlans) {
    return `¡Claro! 😊\n\nPara conocer si contamos con otros planes o paquetes, te recomendamos hablar con un *asesor de ventas de PIT COMUNICACIONES*.\n\n${salesPendingPrompt(session)}`;
  }

  if (/\b(instalacion|instalar|instalan)\b/.test(normalized)) {
    const fee = session.locality ? getInstallationFee(session.locality) : null;
    const feeText = fee !== null
      ? `La instalación en ${session.locality} cuesta $${fee} MXN.`
      : "Instalación: La Libertad $600, Emiliano Zapata $800 y Ejido Morelos $1,200 MXN. En otras comunidades, un técnico debe confirmar cobertura y precio.";
    return `${feeText}\n\n${salesPendingPrompt(session)}`;
  }

  if (isPriceQuestion(normalized) || isMonthlyPriceQuestion(normalized)) {
    return `📡 *PLAN FAMILIAR PIT COMUNICACIONES*\n\n📥 25 Mbps de bajada.\n📤 10 Mbps de subida.\n💰 *$350 MXN mensuales.*\n♾️ Sin límite de navegación.\n\n${salesPendingPrompt(session)}`;
  }

  if (isPaymentQuestion(normalized)) {
    return `💳 Los pagos se realizan del día *15 al 20 de cada mes*. A partir del día 21 se cobran *$30 MXN* por mora y el servicio puede suspenderse. Aceptamos efectivo, transferencia y depósito en OXXO.\n\n${salesPendingPrompt(session)}`;
  }

  return null;
}

async function handleSalesSession(phone, message) {
  const session = salesSessions.get(phone);
  if (!session) return false;

  const answer = String(message || "").trim();
  const normalizedAnswer = clean(answer);
  session.updatedAt = Date.now();

  // Despedida durante la contratación.
  if (isStrongClosing(answer) || (session.step === "name" && isNo(answer))) {
    salesSessions.delete(phone);
    await sendWhatsAppMessage(phone, `De acuerdo, dejamos la solicitud pendiente. Cuando quieras continuar, escribe *CONTRATAR*. ${farewellMessage()}`);
    return true;
  }

  // Preguntas durante la contratación: responder y conservar el paso.
  const asksPriceOrMonthly = isPriceQuestion(answer) || isMonthlyPriceQuestion(answer) || /\bmensualidad(es)?\b/.test(normalizedAnswer);
  if (session.step !== "confirm" && (looksLikeQuestion(answer) || asksPriceOrMonthly)) {
    const fixed = getSalesQuestionReply(session, answer);
    if (fixed) {
      await reply(phone, answer, fixed);
      return true;
    }
    const aiReply = await getAIReply(phone, answer, { context: `El cliente está llenando una solicitud de contratación (paso "${session.step}"). Responde su duda brevemente y NO pidas datos tú.` });
    await sendWhatsAppMessage(phone, `${aiReply}\n\n${salesPendingPrompt(session)}`);
    return true;
  }

  if (session.step === "name") {
    if (!isValidName(answer)) {
      await sendWhatsAppMessage(phone, "Por favor, escribe tu nombre y apellidos para registrar correctamente tu solicitud.");
      return true;
    }
    session.name = answer;

    if (session.locality) {
      session.step = "address";
      await sendWhatsAppMessage(phone, `Gracias, ${session.name}. 😊\n\nTengo registrada tu localidad como *${session.locality}*. Ahora indícame tu dirección o una ubicación cercana para identificar dónde sería la instalación.`);
    } else {
      session.step = "locality";
      await sendWhatsAppMessage(phone, `Gracias, ${session.name}. 😊\n\nAhora dime, ¿en qué *localidad o colonia* deseas contratar el servicio?`);
    }
    return true;
  }

  if (session.step === "locality") {
    if (!isValidLocality(answer)) {
      await sendWhatsAppMessage(phone, "Por favor, indícame el nombre de tu localidad, colonia o ejido.");
      return true;
    }
    session.locality = answer;
    session.step = "address";
    const fee = getInstallationFee(answer);
    const feeText = fee !== null
      ? `El costo de instalación en tu localidad es de *$${fee} MXN*.`
      : "Un técnico deberá confirmar la cobertura y el costo de instalación en tu localidad.";
    await sendWhatsAppMessage(phone, `${feeText}\n\nAhora indícame tu dirección o una ubicación cercana para identificar dónde sería la instalación.`);
    return true;
  }

  if (session.step === "address") {
    if (!isValidAddress(answer)) {
      await sendWhatsAppMessage(phone, "Por favor, escribe una dirección, calle, colonia o referencia que nos ayude a localizar tu domicilio.");
      return true;
    }
    session.address = answer;
    session.step = "reference";
    await sendWhatsAppMessage(phone, "¿Hay alguna referencia para encontrar tu domicilio? Por ejemplo: cerca de una escuela, tienda, iglesia o parque. Si no tienes referencia, escribe *NINGUNA*.");
    return true;
  }

  if (session.step === "reference") {
    session.reference = /^(ninguna|ninguno|no|no hay|sin referencia|no tengo)$/.test(normalizedAnswer) ? "Sin referencia adicional" : answer;
    session.step = "confirm";
    await sendWhatsAppMessage(phone, `📋 *RESUMEN DE TU SOLICITUD*\n\n👤 Nombre: ${session.name}\n📍 Localidad: ${session.locality}\n🏠 Dirección: ${session.address}\n📌 Referencia: ${session.reference}\n\n¿Los datos son correctos?\n\nResponde:\n1️⃣ Sí, son correctos.\n2️⃣ No, quiero corregirlos.`);
    return true;
  }

  if (session.step === "confirm") {
    if (normalizedAnswer === "1" || isYes(answer) || /^(si son correctos|son correctos|si estan bien|estan bien|todo bien|si todo bien)$/.test(normalizedAnswer)) {
      const fee = getInstallationFee(session.locality);
      salesSessions.delete(phone);
      salesOffers.set(phone, { step: "confirmed", updatedAt: Date.now() });

      await notifyTeam(`🔔 SOLICITUD DE CONTRATACIÓN PIT COMUNICACIONES\nNombre: ${session.name}\nTeléfono: ${phone}\nLocalidad: ${session.locality}\nDirección: ${session.address}\nReferencia: ${session.reference}\nPlan: Familiar 25/10 Mbps, $350 MXN\nInstalación: ${fee !== null ? "$" + fee + " MXN" : "por confirmar"}\nEstado: Pendiente de revisión.`);

      await sendWhatsAppMessage(phone, `✅ *SOLICITUD REGISTRADA*\n\nGracias, ${session.name}.\n\nHemos recibido tus datos para solicitar el servicio de Internet.\n\nUn asesor de PIT COMUNICACIONES revisará la cobertura y se comunicará contigo para continuar el proceso.\n\n⚠️ Esta solicitud no significa que la instalación ya esté confirmada.\n\nSi necesitas hablar con un asesor, escribe *ASESOR*.`);
      return true;
    }

    if (normalizedAnswer === "2" || isNo(answer) || /\b(corregir|cambiar|esta mal|estan mal)\b/.test(normalizedAnswer)) {
      session.step = "name";
      session.locality = "";
      await sendWhatsAppMessage(phone, "Vamos a corregir tus datos. Por favor, escribe nuevamente tu *nombre completo*.");
      return true;
    }

    await sendWhatsAppMessage(phone, "Responde *1* si los datos son correctos o *2* si deseas corregirlos.");
    return true;
  }

  salesSessions.delete(phone);
  return false;
}

// La IA ofreció ayudar a contratar, o la solicitud ya se registró.
// Si el mensaje no responde a esa oferta, se devuelve false y el mensaje
// se procesa normalmente (antes el cliente quedaba atrapado aquí).
async function handleSalesOfferAcceptance(phone, message) {
  const offer = salesOffers.get(phone);
  if (!offer) return false;

  if (offer.step === "confirmed") {
    if (/\b(mi solicitud|ya mande|ya envie|cuando vienen|cuando instalan|cuando me instalan|cuando llegan)\b/.test(clean(message))) {
      await sendWhatsAppMessage(phone, "Tu solicitud ya fue recibida. Un asesor revisará la cobertura y se comunicará contigo. Si deseas atención personalizada, escribe *ASESOR*. Para ver el menú, escribe *MENU*.");
      return true;
    }
    salesOffers.delete(phone);
    return false;
  }

  if (isYes(message) || /^(contratar|quiero contratar|me interesa|si me interesa|si quiero|si quiero contratar)$/.test(clean(message))) {
    const mentioned = getMentionedLocalities(message);
    let locality = mentioned.length === 1 ? mentioned[0] : "";
    if (!locality && Array.isArray(offer.localities) && offer.localities.length === 1) locality = offer.localities[0];
    await startSalesSession(phone, locality);
    return true;
  }

  if (isNo(message)) {
    salesOffers.delete(phone);
    await sendWhatsAppMessage(phone, "De acuerdo. Si más adelante deseas contratar Internet, escribe *CONTRATAR*. También puedes escribir *MENU* para ver las opciones.");
    return true;
  }

  salesOffers.delete(phone);
  return false;
}

// =====================================================================
// INTELIGENCIA ARTIFICIAL
// =====================================================================
async function getAIReply(phone, message, options = {}) {
  if (!OPENAI_API_KEY) {
    return "Por el momento no puedo responder esa consulta. Escribe *MENU* para ver las opciones o *TECNICO* para solicitar atención.";
  }

  const session = getConversation(phone);
  const greeting = getTimeGreeting();
  const alreadyGreeted = wasGreetedRecently(phone);
  const greetingRule = alreadyGreeted
    ? `NO SALUDES: el cliente ya fue saludado en esta conversación. No empieces con "Hola", "Buenas noches" ni otro saludo; responde directo. Solo si el cliente se despide puedes desearle "${greeting}".`
    : `Puedes saludar solo al inicio con "${greeting}". Nunca uses "buen día" ni otro saludo diferente.`;

  const instructions = `Eres el asesor virtual de PIT COMUNICACIONES, proveedor de Internet inalámbrico en La Libertad (Chiapas), Emiliano Zapata (Tabasco), Ejido Morelos y comunidades cercanas.

FECHA Y HORA ACTUAL EN CIUDAD DE MÉXICO: ${getMexicoDateText()}.
SALUDO CORRECTO EN ESTE MOMENTO: "${greeting}". ${greetingRule}

INFORMACIÓN OFICIAL:
${JSON.stringify(businessInfo)}

REGLAS:
- Responde en español mexicano, de forma amable, natural y breve (máximo 3 o 4 líneas).
- El Plan Familiar cuesta $350 MXN al mes: 25 Mbps de bajada y 10 Mbps de subida, sin límite de navegación. Los dispositivos comparten la velocidad.
- No inventes planes, precios, promociones, cobertura ni fechas.
- Instalación: La Libertad $600, Emiliano Zapata $800, Ejido Morelos $1,200. En otras localidades un técnico debe confirmar cobertura y costo.
- Pagos: del día 15 al 20 de cada mes. Desde el día 21 se cobran $30 MXN de mora y el servicio puede suspenderse. Solo menciona pagos si el cliente pregunta por pagos.
- Si el cliente dice que no tiene Internet o que falla su servicio, NO hables de pagos: ofrece una guía rápida para revisar los cables.
- Si el cliente dice que ya tiene Internet o se despide, agradece y despídete en una sola línea, sin hacer más preguntas.
- Métodos de pago: efectivo, transferencia y depósito OXXO. No confirmes instalaciones ni pagos.
- Nunca solicites contraseñas, códigos ni datos de tarjetas.
- Nunca indiques presionar RESET, intercambiar cables POE/LAN ni manipular antena o cableado exterior.
- No pidas tú los datos del cliente; el sistema los pide paso a paso.
- Si no tienes certeza, dilo y sugiere escribir TECNICO o ASESOR.
- No respondas consultas ajenas a PIT COMUNICACIONES.${options.context ? `\n\nCONTEXTO ACTUAL: ${options.context}` : ""}`;

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
        input: [...session.messages, { role: "user", content: message }],
        max_output_tokens: 300,
        store: false
      }),
      signal: AbortSignal.timeout(25000)
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("ERROR OPENAI:", result);
      return "En este momento tengo dificultades para responder. Escribe *MENU* o *TECNICO*.";
    }

    const answer = (result.output || [])
      .filter(item => item.type === "message")
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text)
      .join("\n")
      .trim();

    if (!answer) return "No pude preparar una respuesta. Escribe *MENU* para ver las opciones.";

    let fixedAnswer = fixGreetings(answer).slice(0, 3500);
    if (alreadyGreeted) {
      fixedAnswer = stripLeadingGreeting(fixedAnswer);
    } else if (startsWithGreeting(fixedAnswer)) {
      markGreeted(phone);
    }
    saveConversation(phone, "user", message);
    saveConversation(phone, "assistant", fixedAnswer);
    return fixedAnswer;
  } catch (error) {
    console.error("ERROR CONSULTANDO OPENAI:", error);
    return "En este momento no puedo responder esa consulta. Inténtalo nuevamente o escribe *TECNICO*.";
  }
}

// =====================================================================
// PAUSA MANUAL (cuando tú contestas desde el celular)
// =====================================================================
function pauseCustomer(phone) {
  if (!phone) return;
  const pauseUntil = Date.now() + MANUAL_PAUSE_DURATION;
  manualPauses.set(phone, pauseUntil);
  persistManualPauses();
  console.log(`PAUSA MANUAL para ${phone} hasta ${new Date(pauseUntil).toISOString()}`);
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

function processManualMessageEchoes(change) {
  if (change.field !== "smb_message_echoes") return;
  const echoes = change.value?.message_echoes || [];

  for (const echo of echoes) {
    const recipient = Array.isArray(echo.to) ? echo.to[0] : echo.to;
    if (!recipient) {
      console.log("ECHO SIN DESTINATARIO:", JSON.stringify(echo));
      continue;
    }
    if (echo.id && processedEchoes.has(echo.id)) continue;
    if (echo.id) processedEchoes.set(echo.id, Date.now());
    pauseCustomer(recipient);
  }
}

// LIMPIEZA PERIÓDICA
function cleanupSessions() {
  const now = Date.now();
  let pausesChanged = false;

  for (const [phone, pauseUntil] of manualPauses.entries()) {
    if (now >= pauseUntil) {
      manualPauses.delete(phone);
      pausesChanged = true;
    }
  }
  if (pausesChanged) persistManualPauses();

  for (const [phone, at] of lastGreetings.entries()) {
    if (now - at > GREETING_WINDOW) lastGreetings.delete(phone);
  }

  for (const map of [processedEchoes, processedMessages]) {
    for (const [id, timestamp] of map.entries()) {
      if (now - timestamp > 60 * 60 * 1000) map.delete(id);
    }
  }

  for (const map of [guideSessions, guideOffers, paymentFollowups, supportSessions, salesSessions, salesOffers]) {
    for (const [phone, session] of map.entries()) {
      if (now - session.updatedAt > SESSION_TTL) map.delete(phone);
    }
  }
}

// SEGUIMIENTO DESPUÉS DE INFORMACIÓN DE PAGOS
function startPaymentFollowup(phone) {
  paymentFollowups.set(phone, { updatedAt: Date.now() });
}

// =====================================================================
// PROCESAMIENTO DE CADA MENSAJE (orden de prioridad)
// =====================================================================
async function processMessage(from, text) {
  if (isCustomerPaused(from)) {
    console.log(`BOT EN PAUSA: ${from}`);
    return;
  }

  const normalized = clean(text);

  // 1. Menú y cancelar siempre funcionan.
  if (["menu", "inicio", "menu principal"].includes(normalized)) {
    clearFlows(from);
    conversations.delete(from);
    markGreeted(from);
    await sendWhatsAppMessage(from, mainMenu());
    return;
  }

  if (["cancelar", "cancela", "salir"].includes(normalized)) {
    const hadFlow = [guideSessions, guideOffers, salesSessions, supportSessions, salesOffers].some(map => map.has(from));
    clearFlows(from);
    await sendWhatsAppMessage(from, hadFlow
      ? "De acuerdo, hemos detenido el proceso. Si necesitas ayuda, escribe *MENU*."
      : "No hay ningún proceso activo. Escribe *MENU* para ver las opciones.");
    return;
  }

  // 2. Captura de datos para técnico/asesor.
  if (supportSessions.has(from)) {
    if (await handleSupportSession(from, text)) return;
  }

  // 3. Solicitud directa de técnico o asesor (también opción 7).
  if (isHumanSupportRequest(text)) {
    await offerHumanSupport(from, normalized === "7"
      ? "El cliente seleccionó la opción de hablar con un técnico."
      : `El cliente solicita atención personalizada. Mensaje: "${text}"`);
    return;
  }

  // 4. Guía de conexión en curso.
  if (guideSessions.has(from)) {
    if (await handleConnectionGuide(from, text)) return;
  }

  // 5. Contratación en curso.
  if (salesSessions.has(from)) {
    if (await handleSalesSession(from, text)) return;
  }

  // 6. Respuestas que dependen de la última pregunta del bot.
  if (guideOffers.has(from)) {
    if (await handleGuideOffer(from, text)) return;
  }

  if (salesOffers.has(from)) {
    if (await handleSalesOfferAcceptance(from, text)) return;
  }

  if (paymentFollowups.has(from)) {
    paymentFollowups.delete(from);
    if (isClosing(text) && !isStrongClosing(text)) {
      await sendWhatsAppMessage(from, `¡Con gusto! 😊\n\n¿Necesitas algo más?\n\n1️⃣ Reportar un problema de Internet.\n4️⃣ Consultar planes y precios.\n👨‍🔧 Escribe *ASESOR* para hablar con una persona.\n🏠 Escribe *MENU* para regresar al menú principal.`);
      return;
    }
  }

  // 7. Fallas: tienen prioridad sobre pagos y sobre la IA.
  if (normalized === "1" || isOutageReport(text)) {
    await startConnectionGuide(from);
    return;
  }

  if (normalized === "2" || isSlowReport(text)) {
    await reply(from, text, SLOW_REPLY);
    return;
  }

  // 8. Contratación.
  if (normalized === "5" || isSalesIntent(text)) {
    const mentioned = getMentionedLocalities(text);
    await startSalesSession(from, mentioned.length === 1 ? mentioned[0] : "");
    return;
  }

  // 9. Despedidas y agradecimientos.
  if (isClosing(text)) {
    await sendWhatsAppMessage(from, farewellMessage());
    return;
  }

  // 10. Opciones fijas y saludos.
  const fixedReply = getMenuReply(text);
  if (fixedReply) {
    if (fixedReply === PAYMENT_REPLY) startPaymentFollowup(from);
    if (fixedReply.includes("MENÚ DE ATENCIÓN")) markGreeted(from);
    await reply(from, text, fixedReply);
    return;
  }

  // 10.5 Precio de la mensualidad (antes se confundía con fechas de pago).
  if (isMonthlyPriceQuestion(text)) {
    await reply(from, text, MONTHLY_REPLY);
    return;
  }

  // 11. Preguntas de pagos (palabras de pago reales, no "día" ni "internet").
  if (isPaymentQuestion(text) && !isPriceQuestion(text)) {
    startPaymentFollowup(from);
    await reply(from, text, PAYMENT_REPLY);
    return;
  }

  // 12. Todo lo demás: IA.
  const aiReply = await getAIReply(from, text);

  if (isCustomerPaused(from)) {
    console.log(`RESPUESTA CANCELADA POR PAUSA: ${from}`);
    return;
  }

  const replyText = normalize(aiReply);

  // Solo se guarda la oferta si la IA realmente PREGUNTA si quiere contratar.
  if (/(te gustaria|deseas|quieres|te interesa) (contratar|iniciar (tu|la) solicitud)|(te ayudo|ayudarte) con la contratacion/.test(replyText)) {
    salesOffers.set(from, {
      step: "offer",
      localities: getMentionedLocalities(sessionTextForSales(from, text)),
      updatedAt: Date.now()
    });
  }

  if (/guia rapida|guia para revisar|revisar los cables|revisar las conexiones|guia visual|guia de conexion/.test(replyText)) {
    guideOffers.set(from, { step: "accept_guide", updatedAt: Date.now() });
  }

  await sendWhatsAppMessage(from, aiReply);
}

// Cola por cliente: los mensajes de un mismo número se atienden en orden.
function enqueueMessage(from, text) {
  const previous = phoneQueues.get(from) || Promise.resolve();
  const next = previous
    .then(() => processMessageWithMedia(from, text))
    .catch(error => console.error("ERROR PROCESANDO MENSAJE:", error))
    .finally(() => {
      if (phoneQueues.get(from) === next) phoneQueues.delete(from);
    });
  phoneQueues.set(from, next);
  return next;
}

// =====================================================================
// RUTAS
// =====================================================================
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

app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === "smb_message_echoes") {
          processManualMessageEchoes(change);
          continue;
        }
        if (change.field !== "messages") continue;

        for (const message of change.value?.messages || []) {
          // Meta puede reenviar el mismo mensaje: se atiende una sola vez.
          if (message.id) {
            if (processedMessages.has(message.id)) continue;
            processedMessages.set(message.id, Date.now());
          }

          const from = message.from;
          let text = "";
          if (message.type === "text") text = message.text?.body || "";
          if (message.type === "button") text = message.button?.text || "";
          if (message.type === "interactive") {
            text = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || "";
          }
          text = text.trim();

          if (!from) continue;

          if (!text) {
            // Audio, foto, sticker, etc.
            if (!isCustomerPaused(from) && ["audio", "image", "video", "sticker", "document"].includes(message.type)) {
              enqueueMessage(from, "__media__");
            }
            continue;
          }

          console.log("MENSAJE RECIBIDO:", from, text);
          enqueueMessage(from, text);
        }
      }
    }
  } catch (error) {
    console.error("ERROR EN WEBHOOK:", error);
  }
});

// Mensajes que no son texto (audios, fotos): respuesta breve sin romper el flujo.
async function processMessageWithMedia(from, text) {
  if (text !== "__media__") return processMessage(from, text);
  if (isCustomerPaused(from)) return;
  const busy = [guideSessions, salesSessions, supportSessions].some(map => map.has(from));
  await sendWhatsAppMessage(from, busy
    ? "Recibí tu archivo. 😊 Por ahora solo puedo leer mensajes de texto; por favor responde con texto para continuar."
    : "Recibí tu archivo. 😊 Por ahora solo puedo leer mensajes de texto. Si enviaste un comprobante de pago, escríbenos también tu *nombre completo* para que lo revise un asesor. Escribe *MENU* para ver las opciones.");
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "pit-comunicaciones-api",
    version: "V8.2",
    whatsappWebhook: true,
    aiConfigured: Boolean(OPENAI_API_KEY),
    aiModel: OPENAI_MODEL,
    mexicoTime: getMexicoDateText(),
    greeting: getTimeGreeting(),
    notifyPhoneConfigured: Boolean(NOTIFY_PHONE),
    manualCustomerPause: "30 minutes",
    manualPauseStoragePath: DATA_DIR,
    activeManualPauses: manualPauses.size,
    guideMode: "step-by-step-poe-router-reseat"
  });
});

app.get("/api/business-info", (_req, res) => {
  res.json(businessInfo);
});

// =====================================================================
// INICIO
// =====================================================================
if (require.main === module) {
  setInterval(cleanupSessions, 60 * 1000);

  loadManualPauses()
    .then(() => {
      app.listen(PORT, "0.0.0.0", () => {
        console.log(`PIT COMUNICACIONES V8.2 activo en puerto ${PORT}`);
        console.log(`Archivo de pausas: ${PAUSES_FILE}`);
        console.log(`Hora de México: ${getMexicoDateText()} (${getTimeGreeting()})`);
      });
    })
    .catch(error => {
      console.error("ERROR INICIANDO ALMACENAMIENTO:", error);
      process.exit(1);
    });
}

module.exports = {
  app,
  processMessage: processMessageWithMedia,
  enqueueMessage,
  clean,
  isYes,
  isNo,
  isClosing,
  isStrongClosing,
  isOutageReport,
  isPaymentQuestion,
  isSalesIntent,
  getStepAnswer,
  getInternetResultAnswer,
  saysInternetIsBack,
  getTimeGreeting,
  fixGreetings,
  sessions: { guideSessions, guideOffers, salesSessions, salesOffers, supportSessions, paymentFollowups }
};
