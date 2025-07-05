const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const LOCAL_NODE_URL = "http://frigate.local:3000/sendMessage";

// Home Assistant - usando el token inyectado por el supervisor
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_API_URL = "http://supervisor/core/api";

const sendNotificationHA = async (title, message) => {
  try {
    await axios.post(
      `${HA_API_URL}/services/persistent_notification/create`,
      {
        title,
        message,
        notification_id: "alerta_whatsapp"
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPERVISOR_TOKEN}`
        }
      }
    );
    console.log("✅ Notificación enviada a Home Assistant");
  } catch (err) {
    console.log("⚠️ Error al enviar notificación a HA:", err.message);
  }
};

const logError = (msg) => {
  console.error(msg);
};

const notifyServiceDown = async (finalErrorMessage) => {
  logError(finalErrorMessage);
  await sendNotificationHA("❌ WhatsApp Proxy", finalErrorMessage);
};

app.post("/sendMessage", async (req, res) => {
  const { to } = req.body;

  if (!to || to.trim() === "") {
    logError("❌ No se especificó teléfono destino");
    return res.status(400).send({ error: "No se especificó teléfono destino" });
  }

  let retries = 6;
  const delays = [20000, 20000, 20000, 120000, 120000, 120000]; // ms

  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      console.log("Proxy recibiendo:", req.body, `Intento ${i + 1}`);
      const r = await axios.post(LOCAL_NODE_URL, req.body);
      console.log("Resultado post:", r.status + " " + JSON.stringify(r.data));
      return res.status(r.status).send(r.data);
    } catch (err) {
      lastError = err;
      logError(`Proxy error (intento ${i + 1}): ${err.message}`);
      if (i < retries - 1) {
        const wait = delays[i] || 120000;
        console.log(`Esperando ${wait / 1000}s antes del retry...`);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }

  const finalMessage = `❌ WhatsApp Proxy: todos los retries fallaron.\nÚltimo error: ${lastError?.message || "desconocido"}`;
  await notifyServiceDown(finalMessage);

  if (lastError && lastError.response) {
    res.status(lastError.response.status).send(lastError.response.data);
  } else {
    res.status(500).send("Error en el proxy: " + (lastError?.message || "desconocido"));
  }
});

app.listen(3000, () => {
  console.log("WhatsApp Proxy Addon corriendo en puerto 3000");
  notifyServiceDown("Anda?");
});
