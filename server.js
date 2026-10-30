const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const https = require('https');
const http = require('http');
const pino = require('pino');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const WA_SECRET = process.env.WA_SECRET || '89599301';
const SESSION_DIR = path.join(__dirname, 'baileys_auth');

let sock = null;
let qrCodeData = null;
let isReady = false;
let latestPairingCode = null;

// Auth check middleware
const authenticateApi = (req, res, next) => {
  const reqSecret = req.headers['x-wa-secret'] ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null) ||
    req.query.secret;

  if (WA_SECRET && reqSecret === WA_SECRET) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized: Valid x-wa-secret header required' });
};

// ─── Initialize Baileys Socket ────────────────────────────────────────────────
async function startBaileys() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr);
      isReady = false;
      console.log('[Baileys] QR code ready');
    }

    if (connection === 'close') {
      isReady = false;
      qrCodeData = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[Baileys] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(startBaileys, 5000);
      } else {
        console.log('[Baileys] Logged out. Clearing session folder...');
        try {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        } catch (e) {}
        setTimeout(startBaileys, 3000);
      }
    } else if (connection === 'open') {
      console.log('[Baileys] WhatsApp connected and ready!');
      isReady = true;
      qrCodeData = null;
      latestPairingCode = null;
    }
  });

  // Message listener (Backend forward)
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const senderJid = msg.key.remoteJid;
    const senderPhone = senderJid.split('@')[0];
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    console.log(`[Message from ${senderPhone}]: ${text}`);

    const backendUrl = process.env.BACKEND_URL;
    if (backendUrl) {
      try {
        await fetch(backendUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-wa-secret': WA_SECRET
          },
          body: JSON.stringify({
            from: senderPhone,
            cnumber: senderPhone,
            body: text
          })
        });
      } catch (err) {
        console.error('Failed to forward message:', err.message);
      }
    }
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Status
app.get('/status', (req, res) => {
  res.json({
    ready: isReady,
    qr: qrCodeData,
    pairingCode: latestPairingCode,
    waSecret: WA_SECRET
  });
});

// Pairing Web Page
app.get('/pair', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>WhatsApp Phone Pairing</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f0f2f5; }
        .card { background: white; padding: 28px; border-radius: 12px; box-shadow: 0 4px 14px rgba(0,0,0,0.1); width: 100%; max-width: 380px; text-align: center; }
        h2 { margin-top: 0; color: #111b21; }
        input { width: 100%; padding: 12px; margin: 12px 0; border: 1px solid #ccc; border-radius: 8px; font-size: 16px; box-sizing: border-box; text-align: center; }
        button { width: 100%; padding: 12px; background: #25d366; border: none; color: white; font-size: 16px; font-weight: bold; border-radius: 8px; cursor: pointer; }
        button:hover { background: #20ba59; }
        #codeBox { display: none; margin-top: 20px; padding: 14px; background: #e7fce8; border: 2px dashed #25d366; border-radius: 8px; font-size: 26px; font-weight: bold; letter-spacing: 4px; color: #075e54; }
        .instructions { font-size: 13px; color: #667781; margin-top: 14px; line-height: 1.4; text-align: left; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Link with Phone Number</h2>
        <input type="text" id="phone" placeholder="Enter 10-digit number" value="9301530783" />
        <button onclick="getCode()">Get Pairing Code</button>
        <div id="codeBox"></div>
        <div class="instructions">
          1. WhatsApp kholein ➔ <b>Linked Devices</b><br>
          2. <b>Link a device</b> dabayein<br>
          3. Niche <b>Link with phone number instead</b> select karein<br>
          4. Upar aaya hua 8-digit code dalein
        </div>
      </div>
      <script>
        async function getCode() {
          const phone = document.getElementById('phone').value.trim();
          if(!phone) return alert('Phone number enter karein');
          const btn = document.querySelector('button');
          btn.innerText = 'Requesting code...';
          btn.disabled = true;

          try {
            const res = await fetch('/api/pair-phone', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone })
            });
            const data = await res.json();
            if(data.code) {
              const box = document.getElementById('codeBox');
              box.innerText = data.code;
              box.style.display = 'block';
              btn.innerText = 'Code Received!';
            } else {
              alert(data.error || 'Failed to get code');
              btn.innerText = 'Get Pairing Code';
              btn.disabled = false;
            }
          } catch(e) {
            alert('Request error: ' + e.message);
            btn.innerText = 'Get Pairing Code';
            btn.disabled = false;
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Pairing API Endpoint
app.post('/api/pair-phone', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    if (!sock) return res.status(503).json({ error: 'Socket not initialized' });

    let cleaned = phone.toString().replace(/\D/g, '');
    if (cleaned.length === 10) cleaned = '91' + cleaned;

    console.log(`[Baileys] Generating pairing code for ${cleaned}...`);
    const code = await sock.requestPairingCode(cleaned);
    latestPairingCode = code;

    res.json({ success: true, code });
  } catch (err) {
    console.error('Pairing Code Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Send Message Endpoint (Directly used by Next.js app)
app.post('/api/send-message', authenticateApi, async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp is not ready' });
  }

  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message are required' });
  }

  try {
    let cleaned = phone.toString().replace(/\D/g, '');
    if (cleaned.length === 10) cleaned = '91' + cleaned;
    const jid = `${cleaned}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error('Send Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Self Keep-Alive Ping
setInterval(() => {
  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl) {
    const mod = publicUrl.startsWith('https') ? https : http;
    mod.get(`${publicUrl}/status`, () => {}).on('error', () => {});
  }
}, 10 * 60 * 1000);

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Baileys Service running on port ${PORT}`);
  startBaileys();
});