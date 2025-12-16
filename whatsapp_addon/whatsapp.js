const EventEmitter = require("eventemitter2");

const makeWASocket = require("./Baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("./Baileys");

const MessageType = {
  text: "conversation",
  location: "locationMessage",
  liveLocation: "liveLocationMessage",
  image: "imageMessage",
  video: "videoMessage",
  document: "documentMessage",
  contact: "contactMessage",
};

class WhatsappClient extends EventEmitter {
  #conn;
  #path;
  #sendPresenceUpdateInterval;
  #timeout;
  #attempts;
  #offline;

  #status = {
    connected: false,
    disconnected: false,
  };

  constructor({
    path,
    timeout = 1e3,
    attempts = Infinity,
    offline = true,
  }) {
    super();
    this.#path = path;
    this.#timeout = timeout;
    this.#attempts = attempts;
    this.#offline = offline;
    this.connect();
  }

  connect = async () => {
    if (this.#status.connected) return;

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(this.#path);

    this.#conn = makeWASocket({
      version,
      auth: state,
      syncFullHistory: false,
      shouldIgnoreJid: () => true, // 🔥 CLAVE: ignora TODO lo entrante
      markOnlineOnConnect: false,
      logger: require("pino")({ level: "silent" }),
      generateHighQualityLinkPreview: true,
      browser: ["Chrome", "Windows", "120.0.0.0"],
      defaultQueryTimeoutMs: undefined,
    });

    // 🔴 Cortar proceso ante sesion criptografica invalida
    this.#conn.ev.on("connection.update", ({ lastDisconnect }) => {
      const code = lastDisconnect?.error?.output?.statusCode;
      if ([500, 515, 411].includes(code)) {
        console.error("Fatal WhatsApp session error, exiting:", code);
        process.exit(1);
      }
    });

    this.#conn.ev.on("creds.update", (state) => {
      if (state.me) {
        this.emit("pair", {
          phone: state.me.id.split(":")[0],
          name: state.me.name,
        });
      }
      saveCreds(state);
    });

    this.#conn.ev.on("connection.update", this.#onConnectionUpdate);
  };

  disconnect = () => {
    this.#status.connected = false;
    this.#status.disconnected = true;
    clearInterval(this.#sendPresenceUpdateInterval);
    return this.#conn?.end();
  };

  #toId = (phone) => {
    phone = phone.toString();
    if (!phone) throw new Error("Invalid phone");

    return `${phone.replace("+", "")}${
      phone.endsWith("@s.whatsapp.net") ||
      phone.endsWith("@g.us") ||
      phone.endsWith("@broadcast")
        ? ""
        : "@s.whatsapp.net"
    }`;
  };

  #onConnectionUpdate = (event) => {
    if (event.qr) this.emit("qr", event.qr);

    if (event.connection === "open") {
      this.#status.connected = true;
      this.#status.disconnected = false;

      if (this.#offline) {
        this.setSendPresenceUpdateInterval("unavailable");
      }

      this.emit("ready");
    }

    if (event.connection === "close") {
      this.#status.connected = false;
      clearInterval(this.#sendPresenceUpdateInterval);

      const statusCode = event.lastDisconnect?.error?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        this.emit("logout");
        return;
      }

      // ❗ NO reconectar aca: HA reinicia el addon limpio
      this.emit("disconnected", statusCode);
    }
  };

  setSendPresenceUpdateInterval = (status, id) => {
    clearInterval(this.#sendPresenceUpdateInterval);
    if (!status) return;

    this.#sendPresenceUpdateInterval = setInterval(() => {
      try {
        this.sendPresenceUpdate(status, id);
      } catch (_) {}
    }, 10000);
  };

  sendMessage = async (phone, msg, options) => {
    if (!this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }

    const id = this.#toId(phone);

    // 👇 GRUPOS: enviar directo
    if (id.endsWith("@g.us")) {
      return await this.#conn.sendMessage(id, msg, options);
    }

    // 👇 NUMEROS: validar existencia
    const [result] = await this.#conn.onWhatsApp(id);

    if (result) {
      return await this.#conn.sendMessage(id, msg, options);
    }

    throw new WhatsappNumberNotFoundError(phone);
  };

  sendPresenceUpdate = async (type, id) => {
    if (!this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }
    await this.#conn.sendPresenceUpdate(type, id);
  };
}

class WhatsappNumberNotFoundError extends Error {
  constructor(phone = "") {
    super();
    this.name = "WhatsappNumberNotFoundError";
    this.code = 404;
    this.message = `Send message failed. Number ${phone} is not on Whatsapp.`;
  }
}

class WhatsappDisconnectedError extends Error {
  constructor() {
    super();
    this.name = "WhatsappDisconnectedError";
    this.code = 401;
    this.message = `Send message failed. Whatsapp disconnected.`;
  }
}

module.exports = { WhatsappClient, MessageType };
