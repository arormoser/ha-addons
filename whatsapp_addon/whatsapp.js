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
    attempt: 0,
    connected: false,
    disconnected: false,
    reconnecting: false,
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
      markOnlineOnConnect: !this.#offline,
      logger: require("pino")({ level: "silent" }),
      generateHighQualityLinkPreview: true,
      browser: ["Ubuntu", "Chrome", "20.04"],
      defaultQueryTimeoutMs: undefined,
    });

    // 🔴 CRITICAL: exit process on invalid crypto session
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
    return this.#conn?.end();
  };

  #toId = (phone) => {
    phone = phone.toString();
    if (!phone) throw new Error("Invalid phone");

    return `${phone.replace("+", "")}${
      !phone.endsWith("@s.whatsapp.net") &&
      !phone.endsWith("@g.us") &&
      !phone.endsWith("@broadcast")
        ? "@s.whatsapp.net"
        : ""
    }`;
  };

  #onConnectionUpdate = (event) => {
    if (event.qr) this.emit("qr", event.qr);
    if (event.connection === "open") this.#onConnected();
    else if (event.connection === "close") this.#onDisconnected(event);
  };

  #onConnected = () => {
    this.#status.connected = true;
    this.#status.disconnected = false;
    this.#status.reconnecting = false;

    if (this.#offline) this.setSendPresenceUpdateInterval("unavailable");

    // ✅ SAFE messages handler (no out-of-order corruption)
    this.#conn.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;

        delete msg.message.messageContextInfo;
        const messageType = Object.keys(msg.message)[0];

        this.emit("msg", { type: messageType, ...msg });
      }
    });

    this.#conn.ev.on("presence.update", (presence) => {
      this.emit("presence_update", presence);
    });

    this.emit("ready");
  };

  #onDisconnected = ({ lastDisconnect }) => {
    this.#status.connected = false;
    clearInterval(this.#sendPresenceUpdateInterval);

    const statusCode = lastDisconnect?.error?.output?.statusCode;

    if (statusCode === DisconnectReason.loggedOut) {
      this.emit("logout");
      return;
    }

    // ❗ DO NOT reconnect here – let HA restart clean
    this.emit("disconnected", statusCode);
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
