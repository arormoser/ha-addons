const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const LOCAL_NODE_URL = "http://frigate.local:3000/sendMessage"; // Cambia esto por la IP de tu server Node

app.post("/sendMessage", async (req, res) => {
  const { to } = req.body;

  if (!to || to.trim() === "") {
    console.error("❌ No se especificó teléfono destino");
    return res.status(400).send({ error: "No se especificó teléfono destino" });
  }

  try {
    console.log("Proxy recibiendo:", req.body);

    const r = await axios.post(LOCAL_NODE_URL, req.body);

    console.log("Resultado post:", r.status + " " + r.data);
    res.status(r.status).send(r.data);
  } catch (err) {
    console.error("Proxy error:", err.message);
    if (err.response) {
      console.error("Response data:", err.response.data);
      console.error("Response status:", err.response.status);
      console.error("Response headers:", err.response.headers);
    } else if (err.request) {
      console.error("No response received:", err.request);
    } else {
      console.error("Error en configuración:", err.config);
    }
    res.status(500).send("Error en el proxy: " + err.message);
  }
});

app.listen(3000, () => {
  console.log("WhatsApp Proxy Addon corriendo en puerto 3000");
});
