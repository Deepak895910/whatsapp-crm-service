const nodeCrypto = require('crypto');
if (!global.crypto) {
  global.crypto = nodeCrypto.webcrypto || nodeCrypto;
}

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

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

let sock = null;
let qrCodeData = null;
let isReady = false;
let isConnecting = false;

// Homepage redirect to Scan Page
app.get('/', (req, res) => {
  res.redirect('/scan');
});

// JSON Status Endpoint
app.get('/status', (req, res) => {
  res.json({
    ready: isReady,
    qr: qrCodeData,
    waSecret: WA_SECRET
  });
});

// Live QR Code Scan UI
app.get('/scan', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>WhatsApp QR Connect</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0b141a; color: #e9edef; }
        .card { background: #111b21; padding: 32px; border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); width: 100%; max-width: 380px; text-align: center; border: 1px solid #222d34; }
        h2 { margin-top: 0; font-size: 22px; color: #00a884; }
        .qr-box { background: white; padding: 16px; border-radius: 12px; display: inline-block; margin: 16px 0; min-width: 250px; min-height: 250px; }
        img { width: 250px; height: 250px; display: block; }
        .status-badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; margin-bottom: 12px; }
        .badge-loading { background: #3b4a54; color: #aebac1; }
        .badge-ready { background: #00a884; color: #111b21; }
        .instructions { font-size: 14px; color: #8696a0; line-height: 1.6; text-align: left; margin-top: 14px; background: #1f2c34; padding: 14px; border-radius: 8px; }
        .instructions b { color: #e9edef; }
        button { background: #00a884; color: #111b21; border: none; padding: 10px 18px; border-radius: 8px; font-weight: 700; cursor: pointer; margin-top: 12px; }
        button:hover { background: #06cf9c; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>WhatsApp Link</h2>
        <div id="badge" class="status-badge badge-loading">Loading QR...</div>
        
        <div class="qr-box" id="qrContainer">
          <p style="color:#667781; padding-top: 100px;">Generating QR Code...</p>
        </div>

        <div class="instructions">
          1. Mobile phone me <b>WhatsApp</b> kholein<br>
          2. Menu (3 dots ya Settings) ➔ <b>Linked Devices</b><br>
          3. <b>Link a device</b> par tap karein<br>
          4. Is QR code ko apne camera se <b>Scan karein</b>
        </div>

        <button onclick="resetSession()">Reset & New QR</button>
      </div>

      <script>
        async function checkStatus() {
          try {
            const res = await fetch('/status');
            const data = await res.json();
            const badge = document.getElementById('badge');
            const container = document.getElementById('qrContainer');

            if (data.ready) {
              badge.className = 'status-badge badge-ready';
              badge.innerText = 'Connected & Active';
              container.innerHTML = '<div style="color:#00a884; font-weight:bold; padding-top:100px; font-size:18px;">✅ WhatsApp Connected!</div>';
            } else if (data.qr) {
              badge.className = 'status-badge badge-loading';
              badge.innerText = 'Scan QR Code Now';
              container.innerHTML = '<img src="' + data.qr + '" alt="Scan QR" />';
            }
          } catch(e) {}
        }

        async function resetSession() {
          if (confirm('Kya aap naya QR generate karna chahte hain?')) {
            await fetch('/api/reset-session', { method: 'POST' });
            location.reload();
          }
        }

        setInterval(checkStatus, 2500);
        checkStatus();
      </script>
    </body>
    </html>
  `);
});

// Reset Session Endpoint
app.post('/api/reset-session', async (req, res) => {
  try {
    isReady = false;
    qrCodeData = null;
    if (sock) {
      try { sock.end(); } catch (e) {}
    }
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    setTimeout(startBaileys, 1000);
    res.json({ success: true, message: 'Session reset complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send Message Endpoint (Next.js backend compatibility)
app.post('/api/send-message', async (req, res) => {
  const reqSecret = req.headers['x-wa-secret'] || req.query.secret;
  if (WA_SECRET && reqSecret !== WA_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: Invalid secret' });
  }

  if (!isReady || !sock) {
    return res.status(503).json({ error: 'WhatsApp is not connected yet' });
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
    return res.json({ success: true });
  } catch (err) {
    console.error('Send Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Baileys Connection ───────────────────────────────────────────────────────
async function startBaileys() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    let version = [2, 3000, 1015901307];
    try {
      const vData = await fetchLatestBaileysVersion();
      version = vData.version;
    } catch (e) {}

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Mac OS', 'Chrome', '122.0.0.0'],
      syncFullHistory: false,
      connectTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrcode.toDataURL(qr).then((url) => {
          qrCodeData = url;
        }).catch(() => {});
        isReady = false;
      }

      if (connection === 'close') {
        isReady = false;
        qrCodeData = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[Baileys] Disconnected (${statusCode}). Reconnecting: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => {
            isConnecting = false;
            startBaileys();
          }, 4000);
        } else {
          try {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          } catch (e) {}
          setTimeout(() => {
            isConnecting = false;
            startBaileys();
          }, 2000);
        }
      } else if (connection === 'open') {
        console.log('[Baileys] WhatsApp Connected & Active!');
        isReady = true;
        qrCodeData = null;
      }
    });

    // Message receiver (optional Next.js forwarder)
    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const senderJid = msg.key.remoteJid;
      const senderPhone = senderJid.split('@')[0];
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

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
        } catch (err) {}
      }
    });

  } catch (err) {
    console.error('Socket error:', err.message);
  } finally {
    isConnecting = false;
  }
}

// Keep-Alive Ping
setInterval(() => {
  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl) {
    const mod = publicUrl.startsWith('https') ? https : http;
    mod.get(`${publicUrl}/status`, () => {}).on('error', () => {});
  }
}, 10 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server actively running on port ${PORT}`);
  startBaileys();
});