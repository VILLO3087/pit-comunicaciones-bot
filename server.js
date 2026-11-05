
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API_VERSION = process.env.GRAPH_API_VERSION || "v25.0";

const businessInfo = {
  business: "PIT COMUNICACIONES",
  plan: {
    name: "Plan Familiar",
    speedMbps: 25,
    monthlyPriceMXN: 350
  },
  installation: [
    { locality: "La Libertad, Chiapas", oneTimeFeeMXN: 600 },
    { locality: "Emiliano Zapata, Tabasco", oneTimeFeeMXN: 800 },
    { locality: "Ejido Morelos", oneTimeFeeMXN: 1200 }
  ],
  paymentMethods: [
    "Efectivo",
    "Transferencia bancaria",
    "Depósito en OXXO"
  ],
  supportHours: {
    mondayToFriday: "07:00–18:00",
    saturday: "07:00–14:00",
    sunday: "Sin servicio técnico"
  }
};

// Menú principal
function mainMenu() {
  return `¡Hola! Bienvenido a PIT COMUNICACIONES.

¿En qué podemos ayudarte?

1. No tengo Internet.
2. Mi Internet está lento.
3. Información sobre pagos.
4. Consultar planes y precios.
5. Contratar Internet.
6. Consultar cobertura y horarios.
7. Hablar con un técnico.

Escribe el número de la opción que necesitas.`;
}

// Enviar mensaje por WhatsApp Cloud API
async function sendWhatsAppMessage(to, message) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("Faltan las variables de WhatsApp en Railway.");
    return;
  }

  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

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
    console.error("Error enviando WhatsApp:", result);
  } else {
    console.log("Mensaje enviado correctamente a:", to);
  }
}

// Respuestas automáticas
function getReply(message) {
  const option = message.trim().toLowerCase();

  if (["hola", "buenas", "inicio", "menú", "menu"].includes(option)) {
    return mainMenu();
  }

  switch (option) {
    case "1":
      return `Vamos a revisar tu conexión.

1. Revisa que los cables del router estén conectados.
2. Desconecta el adaptador PoE y el router de la corriente.
3. Espera 30 segundos y vuelve a conectarlos.
4. Espera de 3 a 5 minutos.

No presiones RESET ni cambies los cables de los puertos POE/LAN.

Si continúa sin Internet, escribe TECNICO.`;

    case "2":
      return `Vamos a revisar la velocidad de tu Internet.

1. Acércate al router.
2. Revisa que los cables estén bien conectados.
3. Desconecta el router durante 30 segundos.
4. Conéctalo nuevamente y espera de 3 a 5 minutos.

Si continúa lento, escribe TECNICO.`;

    case "3":
      return `Información de pagos de PIT COMUNICACIONES.

Puedes pagar mediante:
• Efectivo.
• Transferencia bancaria.
• Depósito en OXXO.

Si realizas un pago, envíanos tu nombre completo y una fotografía del comprobante.

Tu pago quedará pendiente de revisión hasta verificarlo.`;

    case "4":
      return `PLANES DE INTERNET

Plan Familiar:
• Velocidad: 25 Mbps.
• Precio mensual: $350 MXN.

Para consultar otros planes, escribe TECNICO.`;

    case "5":
      return `¡Gracias por tu interés en contratar Internet!

Por favor envíanos:
• Nombre completo.
• Número de teléfono.
• Localidad.
• Dirección o ubicación de tu domicilio.

Nuestro equipo revisará la disponibilidad del servicio.`;

    case "6":
      return `HORARIOS DE ATENCIÓN TÉCNICA

Lunes a viernes: 07:00 a 18:00.
Sábados: 07:00 a 14:00.
Domingos: Sin servicio técnico.

Instalación:
• La Libertad, Chiapas: $600.
• Emiliano Zapata, Tabasco: $800.
• Ejido Morelos: $1,200.

Para otras comunidades debemos verificar cobertura.`;

    case "7":
    case "tecnico":
    case "técnico":
      return `Con gusto te ayudaremos.

Para solicitar atención técnica, envíanos:
• Nombre completo.
• Localidad.
• Número de teléfono.
• Describe brevemente tu problema.

Un técnico deberá revisar tu solicitud.`;

    default:
      return `No logré identificar tu opción.

Escribe MENU para consultar las opciones de PIT COMUNICACIONES.`;
  }
}

// Verificación del webhook de Meta
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

// Recepción de mensajes de WhatsApp
app.post("/webhook", (req, res) => {
  // Confirmar recepción a Meta inmediatamente
  res.sendStatus(200);

  const body = req.body;

  if (body.object !== "whatsapp_business_account") {
    return;
  }

  const entries = body.entry || [];

  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const messages = value.messages || [];

      for (const message of messages) {
        if (message.type !== "text") {
          continue;
        }

        const from = message.from;
        const text = message.text?.body || "";

        console.log("Mensaje recibido de:", from, text);

        const reply = getReply(text);

        sendWhatsAppMessage(from, reply).catch(error => {
          console.error("Error procesando mensaje:", error);
        });
      }
    }
  }
});

// Página principal
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Estado del servidor
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "pit-comunicaciones-api",
    whatsappWebhook: true
  });
});

// Información comercial
app.get("/api/business-info", (_req, res) => {
  res.json(businessInfo);
});

// Prueba de recepción
app.post("/api/test-message", (req, res) => {
  const message =
    typeof req.body.message === "string"
      ? req.body.message.trim()
      : "";

  if (!message) {
    return res.status(400).json({
      error: "Envía un mensaje de prueba en el campo message."
    });
  }

  res.json({
    received: true,
    message
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PIT COMUNICACIONES activo en puerto ${PORT}`);
});
