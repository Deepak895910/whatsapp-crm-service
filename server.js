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
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || '89599301';
const SESSION_DIR = path.join(__dirname, 'baileys_auth');

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

let sock = null;
let qrCodeData = null;
let isReady = false;
let isConnecting = false;

// ─── Basic Auth Middleware (Browser Login Popup Lock) ─────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp Secure Area"');
    return res.status(401).send('Authentication required');
  }

  const base64Credentials = authHeader.split(' ')[1] || '';
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
  const [user, pass] = credentials.split(':');

  if (user === AUTH_USER && pass === AUTH_PASS) {
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp Secure Area"');
  return res.status(401).send('Invalid username or password');
}

// ─── Public Routes ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/scan');
});

app.get('/status', (req, res) => {
  res.json({
    ready: isReady,
    qr: qrCodeData,
    waSecret: WA_SECRET
  });
});

// ─── Protected Routes (Scan & Test Panel with Lock) ────────────────────────────
app.get('/scan', requireAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>WhatsApp Engine Panel</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0b141a; color: #e9edef; }
        .card { background: #111b21; padding: 28px; border-radius: 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); width: 100%; max-width: 420px; text-align: center; border: 1px solid #222d34; }
        h2 { margin-top: 0; font-size: 20px; color: #00a884; }
        .status-badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; margin-bottom: 14px; }
        .badge-loading { background: #3b4a54; color: #aebac1; }
        .badge-ready { background: #00a884; color: #111b21; }
        .qr-box { background: white; padding: 12px; border-radius: 12px; display: inline-block; margin: 12px 0; }
        img { width: 220px; height: 220px; display: block; }
        .test-box { margin-top: 20px; padding-top: 18px; border-top: 1px solid #222d34; text-align: left; }
        label { font-size: 12px; color: #8696a0; display: block; margin-bottom: 4px; }
        input { width: 100%; padding: 10px; margin-bottom: 12px; border-radius: 6px; border: 1px solid #2a3942; background: #202c33; color: white; box-sizing: border-box; font-size: 14px; }
        button { width: 100%; background: #00a884; color: #111b21; border: none; padding: 12px; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 15px; }
        button:hover { background: #06cf9c; }
        #resStatus { margin-top: 10px; font-size: 13px; font-weight: bold; text-align: center; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>WhatsApp Automation Server</h2>
        <div id="badge" class="status-badge badge-loading">Checking connection...</div>
        
        <div id="qrSection">
          <div class="qr-box" id="qrContainer">
            <p style="color:#667781; padding: 60px 0;">Loading QR...</p>
          </div>
        </div>

        <div class="test-box">
          <label>Target Phone Number</label>
          <input type="text" id="testPhone" value="8959102057" />

          <label>Message Content</label>
          <input type="text" id="testMsg" value="Namaste! WhatsApp Automation Active & Running!" />

          <button id="sendBtn" onclick="sendTestMsg()">Send Test Message</button>
          <div id="resStatus"></div>
        </div>
      </div>

      <script>
        async function checkStatus() {
          try {
            const res = await fetch('/status');
            const data = await res.json();
            const badge = document.getElementById('badge');
            const qrSec = document.getElementById('qrSection');
            const container = document.getElementById('qrContainer');

            if (data.ready) {
              badge.className = 'status-badge badge-ready';
              badge.innerText = 'Connected & Active';
              qrSec.style.display = 'none';
            } else {
              badge.className = 'status-badge badge-loading';
              badge.innerText = 'Waiting for QR Scan';
              qrSec.style.display = 'block';
              if (data.qr) {
                container.innerHTML = '<img src="' + data.qr + '" alt="QR" />';
              }
            }
          } catch(e) {}
        }

        async function sendTestMsg() {
          const btn = document.getElementById('sendBtn');
          const resBox = document.getElementById('resStatus');
          const phone = document.getElementById('testPhone').value.trim();
          const message = document.getElementById('testMsg').value.trim();

          btn.disabled = true;
          btn.innerText = 'Sending...';
          resBox.innerText = '';

          try {
            const res = await fetch('/api/send-message?secret=' + '${WA_SECRET}', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone, message })
            });

            const data = await res.json();
            if (data.success) {
              resBox.style.color = '#00a884';
              resBox.innerText = '✅ Message Successfully Delivered!';
            } else {
              resBox.style.color = '#ff3b30';
              resBox.innerText = 'Error: ' + (data.error || 'Failed');
            }
          } catch(err) {
            resBox.style.color = '#ff3b30';
            resBox.innerText = 'Error: ' + err.message;
          } finally {
            btn.disabled = false;
            btn.innerText = 'Send Test Message';
          }
        }

        setInterval(checkStatus, 3000);
        checkStatus();
      </script>
    </body>
    </html>
  `);
});

// ─── Send Message API (Protected by Secret Key) ───────────────────────────────
app.post('/api/send-message', async (req, res) => {
  const reqSecret = req.headers['x-wa-secret'] || req.query.secret;
  if (WA_SECRET && reqSecret !== WA_SECRET) {
    return res.status(401).json({ error: 'Unauthorized: Invalid secret' });
  }

  if (!isReady || !sock) {
    return res.status(503).json({ error: 'WhatsApp is not connected' });
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

// ─── Baileys Connection Setup ─────────────────────────────────────────────────
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

  } catch (err) {
    console.error('Socket error:', err.message);
  } finally {
    isConnecting = false;
  }
}

// ─── Self Keep-Alive Ping (For Render Inactivity Prevention) ──────────────────
setInterval(() => {
  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl) {
    https.get(`${publicUrl}/status`, () => {}).on('error', () => {});
  }
}, 10 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  startBaileys();
});