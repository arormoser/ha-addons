const EventEmitter = require("eventemitter2");
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const MessageType = {
  text: "conversation",
  location: "locationMessage",
  liveLocation: "liveLocationMessage",
  image: "imageMessage",
  video: "videoMessage",
  document: "documentMessage",
  contact: "contactMessage",
};

const logger = require("log4js").getLogger();
logger.level = "info";

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
    if (event.qr) this.#onQr(event.qr);
    if (event.connection === "open") this.#onConnected(event);
    else if (event.connection === "close") this.#onDisconnected(event);
  };

  #onQr = (qr) => {
    this.emit("qr", qr);
  };

  #onConnected = (event) => {
    this.#status.attempt = 0;
    this.#status.connected = true;
    this.#status.disconnected = false;
    this.#status.reconnecting = false;

    this.#refreshInterval = setInterval(() => this.restart(), this.#refreshMs);
    if (this.#offline) this.setSendPresenceUpdateInterval("unavailable");

    this.#conn.ev.on("messages.upsert", async ({ messages }) => {
      console.log('MENSAJE CRUDO', JSON.stringify(event, null, 2)); // LOGUEA TODO
      const msg = messages[0];

      if (msg.hasOwnProperty("message") && !msg.key.fromMe) {
        delete msg.message.messageContextInfo;
        const messageType = Object.keys(msg.message)[0];

        // Aca normalizá para que SIEMPRE tenga msg.payload.text
        let payloadText = "";
        if (msg.message?.conversation) {
          payloadText = msg.message.conversation;
        } else if (msg.message?.extendedTextMessage?.text) {
          payloadText = msg.message.extendedTextMessage.text;
        } else if (msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text) {
          payloadText = msg.message.ephemeralMessage.message.extendedTextMessage.text;
        } else {
          payloadText = ""; // Ponelo vacio si no hay texto
        }

        this.emit("msg", {
          type: messageType,
          payload: { text: payloadText },
          ...msg
        });
      }
    });

    this.#conn.ev.on("presence.update", (presence) => {
      this.emit("presence_update", presence);
    });

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

    if (status) {
      try {
        this.sendPresenceUpdate(status, id);
      } catch (err) {
        clearInterval(this.#sendPresenceUpdateInterval);
      }

      this.#sendPresenceUpdateInterval = setInterval(() => {
        try {
          this.sendPresenceUpdate(status, id);
        } catch (err) {
          clearInterval(this.#sendPresenceUpdateInterval);
        }
      }, 10000);
    }
  };

  sendMessage = async (phone, msg, options) => {
    logger.info("Entro a sendMessage whatsapp.js 1");
    logger.info("Enviando mensaje con params:", phone, msg, options);
    phone = phone.toString();
    if (this.#status.disconnected || !this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }

    const id = this.#toId(phone);

    const [result] = await this.#conn.onWhatsApp(id);

    if (
      result ||
      phone.endsWith("@s.whatsapp.net") ||
      phone.endsWith("@g.us") ||
      phone.endsWith("@broadcast")
    ) {
      try {
        logger.info("Entro a sendMessage whatsapp.js 2");
        return await this.#conn.sendMessage(id, msg, options);
      } catch (err) {
        throw new WhatsappError(err.output.payload.statusCode);
      }
    }
    logger.info("Entro a sendMessage whatsapp.js 3");

    throw new WhatsappNumberNotFoundError(phone);
  };

  waitForMessage(from, callback) {
    this.once("msg", (msg) => {
      if (msg.key.remoteJid === this.#toId(from)) callback(msg);
    });
  }

  sendPresenceUpdate = async (type, id) => {
    if (this.#status.disconnected || !this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }

    try {
      await this.#conn.sendPresenceUpdate(type, id);
    } catch (err) {
      throw new WhatsappError(err.output.payload.statusCode);
    }
  };

  presenceSubscribe = async (phone) => {
    if (this.#status.disconnected || !this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }

    const id = this.#toId(phone);

    const [result] = await this.#conn.onWhatsApp(id);

    if (result) {
      try {
        await this.#conn.presenceSubscribe(id);
      } catch (err) {
        throw new WhatsappError(err.output.payload.statusCode);
      }
    } else {
      throw new WhatsappNumberNotFoundError(phone);
    }
  };

  updateProfileStatus = async (status) => {
    if (this.#status.disconnected || !this.#status.connected) {
      throw new WhatsappDisconnectedError();
    }

    try {
      await this.#conn.updateProfileStatus(status);
    } catch (err) {
      throw new WhatsappError(err.output.payload.statusCode);
    }
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

class WhatsappError extends Error {
  #errors = {
    428: "Connection Closed",
    408: "Connection Lost",
    440: "Connection Replaced",
    408: "Timed Out",
    401: "Logged Out",
    500: "Bad Session",
    515: "Restart Required",
    411: "Multidevice Mismatch",
  };

  constructor(message = "", ...args) {
    super(message, ...args);
    this.name = "WhatsappError";
    this.code = Number(this.message);
    this.message = `Send message failed. Whatsapp error ${this.message}: ${
      this.#errors[this.code]
    }`;
  }
}

module.exports = { WhatsappClient, MessageType };
