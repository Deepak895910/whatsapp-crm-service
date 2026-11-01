import express from "express";
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";
import fs from "fs";

const app = express();
app.use(express.json());

const SESSION_DIR = "./auth_session";
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

let sock = null;
let isConnected = false;

async function startWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ["Library CRM", "Chrome", "1.0.0"],
      syncFullHistory: false,
      shouldIgnoreJid: (jid) => jid.endsWith("@broadcast"),
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "close") {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`Connection closed with status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
        
        if (shouldReconnect) {
          setTimeout(startWhatsApp, 5000);
        }
      } else if (connection === "open") {
        isConnected = true;
        console.log("WhatsApp CRM Service is connected and ready!");
      }
    });
  } catch (err) {
    console.error("WhatsApp Init Error:", err.message);
    setTimeout(startWhatsApp, 5000);
  }
}

// Start WhatsApp in background
startWhatsApp();

app.post("/send-message", async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!number || !message) {
      return res.status(400).json({ error: "number and message are required" });
    }

    if (!sock || !isConnected) {
      return res.status(503).json({ error: "WhatsApp is not connected yet" });
    }

    const cleanNumber = number.replace(/[^0-9]/g, "");
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: message });
    return res.json({ success: true, message: "Sent successfully" });
  } catch (error) {
    console.error("Failed to send message:", error);
    return res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => {
  res.json({
    status: "online",
    whatsappConnected: isConnected,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
