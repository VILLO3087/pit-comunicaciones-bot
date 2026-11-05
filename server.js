const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Servir archivos del panel web
app.use(express.static(__dirname));

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
  },
  menu: [
    "No tengo Internet",
    "Mi Internet está lento",
    "Información sobre pagos",
    "Consultar planes y precios",
    "Contratar Internet",
    "Consultar cobertura y horarios",
    "Hablar con un técnico"
  ]
};

// Mostrar el panel principal
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Estado del servidor
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "pit-comunicaciones-api"
  });
});

// Información comercial
app.get("/api/business-info", (_req, res) => {
  res.json(businessInfo);
});

// Prueba de recepción de mensajes
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
    note: "Mensaje recibido. Aún no hay IA ni conexión con WhatsApp.",
    message
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `PIT COMUNICACIONES activo en puerto ${PORT}`
  );
});
