import express from "express";
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";

const app = express();
app.use(express.json());

let sock = null;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_session");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n=================================");
      console.log("SCAN THIS QR CODE NOW (VALID FOR 60s):");
      console.log("=================================\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`Connection closed: ${statusCode}. Reconnecting: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      } else {
        console.log("Logged out from phone. Delete auth_session folder and restart.");
      }
    } else if (connection === "open") {
      console.log("\n>>> SUCCESS! WHATSAPP CONNECTED PERMANENTLY! <<<\n");
    }
  });
}

startWhatsApp();

app.post("/send-message", async (req, res) => {
  try {
    const { number, message } = req.body;
    if (!number || !message) {
      return res.status(400).json({ error: "number and message are required" });
    }

    if (!sock) {
      return res.status(503).json({ error: "WhatsApp socket not initialized" });
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
  res.send("WhatsApp Service Active");
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
