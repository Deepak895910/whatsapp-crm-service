import crypto from "crypto";
if (!globalThis.crypto) {
  globalThis.crypto = crypto;
}

import express from "express";
import baileysPkg from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import fs from "fs";

const makeWASocket = baileysPkg.default || baileysPkg;
const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = baileysPkg;

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Enable CORS for Next.js frontend calls
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

const SESSION_DIR = "./auth_session";
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

let sock = null;
let isConnected = false;
let currentQR = null;

async function startWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["Library CRM", "Chrome", "120.0.0"],
      syncFullHistory: false,
      shouldIgnoreJid: (jid) => jid.endsWith("@broadcast"),
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        console.log("New QR Generated");
      }

      if (connection === "close") {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`Connection closed: ${statusCode}`);
        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(startWhatsApp, 3000);
        }
      } else if (connection === "open") {
        isConnected = true;
        currentQR = null;
        console.log(">>> WhatsApp CRM Service is connected and ready! <<<");
      }
    });
  } catch (err) {
    console.error("WhatsApp Init Error:", err.message);
    setTimeout(startWhatsApp, 5000);
  }
}

startWhatsApp();

// Browser QR viewer
app.get("/qr", async (req, res) => {
  if (isConnected) {
    return res.send("<h2>WhatsApp is already connected!</h2>");
  }
  if (!currentQR) {
    return res.send("<h2>QR Code is generating... please refresh in 5 seconds.</h2>");
  }
  try {
    const qrImage = await qrcode.toDataURL(currentQR);
    res.send(`
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;">
        <h2>Scan this QR Code from WhatsApp</h2>
        <img src="${qrImage}" style="width:300px;height:300px;border:1px solid #ccc;padding:10px;border-radius:8px;" />
        <p>WhatsApp Settings -> Linked Devices -> Link a Device</p>
      </div>
    `);
  } catch (err) {
    res.status(500).send("Error rendering QR");
  }
});

// Universal handler for both /send-message and /api/send-message (with PDF Base64 support)
const handleSendMessage = async (req, res) => {
  try {
    const rawNumber = req.body.phone || req.body.number;
    const { message, fileBase64, fileName } = req.body;

    if (!rawNumber || (!message && !fileBase64)) {
      return res.status(400).json({ error: "phone/number and message/file are required" });
    }

    if (!sock || !isConnected) {
      return res.status(503).json({ error: "WhatsApp is not connected yet" });
    }

    const cleanNumber = String(rawNumber).replace(/[^0-9]/g, "");
    const fullNumber = cleanNumber.startsWith("91") ? cleanNumber : `91${cleanNumber}`;
    const jid = `${fullNumber}@s.whatsapp.net`;

    if (fileBase64) {
      const buffer = Buffer.from(fileBase64, "base64");
      await sock.sendMessage(jid, {
        document: buffer,
        mimetype: "application/pdf",
        fileName: fileName || "Fee_Receipt.pdf",
        caption: message || ""
      });
    } else {
      await sock.sendMessage(jid, { text: message });
    }

    return res.json({ success: true, message: "Sent successfully" });
  } catch (error) {
    console.error("Failed to send message:", error);
    return res.status(500).json({ error: error.message });
  }
};

app.post("/send-message", handleSendMessage);
app.post("/api/send-message", handleSendMessage);

app.get("/", (req, res) => {
  res.json({
    status: "online",
    whatsappConnected: isConnected,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
