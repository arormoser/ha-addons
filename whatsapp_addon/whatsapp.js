const EventEmitter = require("eventemitter2");

const makeWASocket = require("./Baileys").default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("./Baileys");

class WhatsappClient extends EventEmitter {
  #conn;
  #path;
  #offline;
  #keepAliveInterval;

  #status = {
    connected: false,
    disconnected: false,
  };

  constructor({ path, offline = true }) {
    super();
    this.#path = path;
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
      shouldIgnoreJid: () => true,
      markOnlineOnConnect: false,
      logger: require("pino")({ level: "silent" }),
      browser: ["Chrome", "Windows", "120.0.0.0"],
    });

    this.#conn.ev.on("creds.update", saveCreds);
    this.#conn.ev.on("connection.update", this.#onConnectionUpdate);
  };

  #onConnectionUpdate = (event) => {
    if (event.qr) this.emit("qr", event.qr);

    if (event.connection === "open") {
      this.#status.connected = true;
      this.#status.disconnected = false;

      this.#startKeepAlive();
      this.emit("ready");
    }

    if (event.connection === "close") {
      this.#status.connected = false;
      clearInterval(this.#keepAliveInterval);

      const code = event.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        this.emit("logout");
        return;
      }

      this.#status.disconnected = true;
      this.emit("disconnected", code);
    }
  };

  #startKeepAlive = () => {
    clearInterval(this.#keepAliveInterval);

    this.#keepAliveInterval = setInterval(() => {
      try {
        if (this.#conn?.ws?.readyState === 1) {
          this.#conn.ws.ping();
        }
      } catch (_) {}
    }, 5 * 60 * 1000); // cada 5 minutos
  };

  #toId = (phone) => {
    phone = phone.toString();
    return phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
  };

  sendMessage = async (phone, msg, options) => {
    if (!this.#status.connected) {
      // 🔄 reconexion lazy
      await this.connect();
      await new Promise(r => setTimeout(r, 1500));
    }

    const id = this.#toId(phone);
    return await this.#conn.sendMessage(id, msg, options);
  };
}

module.exports = { WhatsappClient };
