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
  #refreshInterval;
  #sendPresenceUpdateInterval;
  #timeout;
  #attempts;
  #offline;
  #refreshMs;

  #status = {
    attempt: 0,
    connected: false,
    disconnected: false,
    reconnecting: false,
  };

  #toMilliseconds = (hrs, min, sec) => (hrs * 60 * 60 + min * 60 + sec) * 1000;

  constructor({
    path,
    timeout = 1e3,
    attempts = Infinity,
    offline = true,
    refreshMs,
  }) {
    super();
    this.#path = path;
    this.#timeout = timeout;
    this.#attempts = attempts;
    this.#offline = offline;
    this.#refreshMs = refreshMs || this.#toMilliseconds(6, 0, 0);
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
      shouldIgnoreJid: () => true, // 🔥 NO escuchar nada
      markOnlineOnConnect: !this.#offline,
      logger: require("pino")({ level: "silent" }),
      generateHighQualityLinkPreview: true,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      defaultQueryTimeoutMs: undefined,
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

  disconnect = (reconnect) => {
    if (this.#status.disconnected) return;

    this.#status.connected = false;
    this.#status.disconnected = !reconnect;
    this.#status.reconnecting = !!reconnect;

    return this.#conn.end();
  };

  restart = () => {
    this.emit("restart");
    return this.disconnect(true);
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

  #reconnect = () => {
    if (this.#status.attempt++ > this.#attempts || this.#status.disconnected) {
      this.#status.reconnecting = false;
      this.#status.disconnected = true;
      return;
    }

    setTimeout(this.connect, this.#timeout);
  };

  #onConnectionUpdate = (event) => {
    if (event.qr) this.emit("qr", event.qr);
    if (event.connection === "open") this.#onConnected();
    else if (event.connection === "close") this.#onDisconnected(event);
  };

  #onConnected = () => {
    this.#status.attempt = 0;
    this.#status.connected = true;
    this.#status.disconnected = false;
    this.#status.reconnecting = false;

    this.#refreshInterval = setInterval(
      () => this.restart(),
      this.#refreshMs
    );

    if (this.#offline) this.setSendPresenceUpdateInterval("unavailable");

    this.emit("ready");
  };

  #onDisconnected = ({ lastDisconnect }) => {
    this.#status.connected = false;

    clearInterval(this.#refreshInterval);
    this.setSendPresenceUpdateInterval();

    const statusCode = lastDisconnect?.error?.output?.statusCode;

    if (statusCode === DisconnectReason.loggedOut) {
      this.#status.reconnecting = false;
      this.#status.disconnected = true;
      this.emit("logout");
      return;
    }

    this.emit("disconnected", statusCode);
    this.#reconnect();
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

  // 🚫 NO SE TOCA
  sendMessage = async (phone, msg, options) => {
    phone = phone.toString();
    if (this.#status.disconnected || !this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }

    const id = this.#toId(phone);
    // ✅ normalizar payload para Baileys
    let payload = msg;

    // si viene string/numero/etc -> convertir a { text: "..." }
    if (payload == null || typeof payload !== "object") {
      payload = { text: String(payload ?? "") };
    } else {
      // si viene { text: <no-string> } -> forzar string
      if ("text" in payload && typeof payload.text !== "string") {
        payload = { ...payload, text: String(payload.text) };
      }
    }

    // log (siempre string)
    const logText =
      typeof payload.text === "string"
        ? payload.text
        : JSON.stringify(payload);

    console.log(`[WHATSAPP SEND] to=${id} text=${logText}`);

    const [result] = await this.#conn.onWhatsApp(id);

    if (
      result ||
      phone.endsWith("@s.whatsapp.net") ||
      phone.endsWith("@g.us") ||
      phone.endsWith("@broadcast")
    ) {
      return await this.#conn.sendMessage(id, payload, options);
    }

    throw new WhatsappNumberNotFoundError(phone);
  };

  sendPresenceUpdate = async (type, id) => {
    if (this.#status.disconnected || !this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }

    await this.#conn.sendPresenceUpdate(type, id);
  };
}

class WhatsappNumberNotFoundError extends Error {
  constructor(phone = "", ...args) {
    super(phone, ...args);
    this.name = "WhatsappNumberNotFoundError";
    this.message = `Send message failed. Number ${phone} is not on Whatsapp.`;
    this.code = 404;
  }
}

class WhatsappDisconnectedError extends Error {
  constructor(message = "", ...args) {
    super(message, ...args);
    this.name = "WhatsappDisconnectedError";
    this.code = 401;
    this.message = `Send message failed. Whatsapp disconnected error.`;
  }
}

module.exports = { WhatsappClient, MessageType };
