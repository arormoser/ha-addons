const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const LOCAL_NODE_URL = "http://frigate.local:3000/sendMessage"; // Cambia esto por la IP de tu server Node

app.post("/sendMessage", async (req, res) => {
  try {
    // Opcional: loguea el request
    console.log("Proxy recibiendo:", req.body);

    // Reenvía a tu Node
    const r = await axios.post(LOCAL_NODE_URL, req.body);

    // Devuelve el resultado a HA
    res.status(r.status).send(r.data);
  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(500).send("Error en el proxy: " + err.message);
  }
});

app.listen(3000, () => {
  console.log("WhatsApp Proxy Addon corriendo en puerto 3000");
});
