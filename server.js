const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log incoming requests (excluding frequent status checks)
app.use((req, res, next) => {
  if (req.path !== '/status') {
    log(`${req.method} ${req.path}`);
  }
  next();
});

const PORT = process.env.PORT || 10000;
const WA_SECRET = process.env.WA_SECRET || '';
const CONFIG_FILE = path.join(__dirname, 'automation-config.json');

// Default automation configuration
let automationConfig = {
  enabled: true,
  systemPrompt: 'You are a helpful customer service AI assistant.',
  openRouterApiKey: '',
  model: 'google/gemma-3-27b-it:free'
};

// Load configuration on startup
if (fs.existsSync(CONFIG_FILE)) {
  try {
    automationConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to parse automation-config.json, using defaults:', e.message);
  }
}

// Helper to save configuration
const saveAutomationConfig = () => {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(automationConfig, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to save automation-config.json:', e.message);
    return false;
  }
};

// Cookie parser helper
const parseCookies = (cookieHeader) => {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    if (parts.length === 2) {
      cookies[parts[0].trim()] = parts[1].trim();
    }
  });
  return cookies;
};

// Verify signed token from session cookie
const getAuthenticatedUser = (req) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.wa_session;
  if (!token) return null;

  const parts = token.split('|');
  if (parts.length !== 3) return null;

  const [username, expiry, signature] = parts;
  if (Date.now() > parseInt(expiry, 10)) return null;

  const expectedSignature = crypto
    .createHmac('sha256', process.env.WA_SECRET || 'fallback_secret')
    .update(`${username}|${expiry}`)
    .digest('hex');

  if (signature === expectedSignature && username === (process.env.AUTH_USER || 'admin')) {
    return username;
  }
  return null;
};

// Enforce auth check on API routes (cookie session OR shared secret token)
const authenticateApi = (req, res, next) => {
  if (req.path === '/login' || req.path === '/logout' || req.path === '/api/pair-phone') {
    return next();
  }

  if (getAuthenticatedUser(req)) {
    return next();
  }

  const secret = process.env.WA_SECRET || '';
  const reqSecret = req.headers['x-wa-secret'] ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null) ||
    req.query.secret;

  if (secret && reqSecret === secret) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: Authentication required' });
};

// Enforce auth check on UI pages
const authenticateUi = (req, res, next) => {
  if (getAuthenticatedUser(req)) {
    return next();
  }
  res.redirect('/login');
};

// Validate shared secret or cookie session on all /api/* routes
app.use('/api', authenticateApi);

const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ─── WhatsApp Client ──────────────────────────────────────────────────────────
let client = null;
let qrCodeData = null;
let isReady = false;
let currentPairingCode = null;

const greetedPhones = new Set();
const conversationHistory = new Map();
const MAX_HISTORY = 20;

function addToHistory(phone, role, content) {
  if (!conversationHistory.has(phone)) conversationHistory.set(phone, []);
  const history = conversationHistory.get(phone);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

function clearHistory(phone) {
  conversationHistory.delete(phone);
  greetedPhones.delete(phone);
}

setInterval(() => {
  conversationHistory.clear();
  greetedPhones.clear();
}, 30 * 60 * 1000);

function initWhatsAppClient() {
  if (client) {
    log('Cleaning up existing WhatsApp client...');
    try {
      client.removeAllListeners();
    } catch (e) { }
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.ww-session') }),
    authTimeoutMs: 60000,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,

    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--js-flags="--max-old-space-size=256"',
        '--disable-extensions',
        '--mute-audio',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      ],
      timeout: 60000,
      protocolTimeout: 300000,
    },
  });

  client.on('qr', async (qr) => {
    log('QR received — scan or request pairing code');
    qrCodeData = await qrcode.toDataURL(qr);
    isReady = false;
  });

  client.on('authenticated', () => {
    log('WhatsApp authenticated successfully');
    qrCodeData = null;
    currentPairingCode = null;
  });

  client.on('ready', () => {
    log('WhatsApp connected and ready!');
    qrCodeData = null;
    currentPairingCode = null;
    isReady = true;
  });

  client.on('message', async (msg) => {
    try {
      await forwardToBackend(msg);

      if (automationConfig.enabled && (automationConfig.openRouterApiKey || process.env.OPENROUTER_API_KEY)) {
        const senderPhone = msg.from.split('@')[0];

        const adminPhone = (process.env.ADMIN_PHONE || '').replace(/\D/g, '');
        if (adminPhone && (senderPhone === adminPhone || adminPhone.endsWith(senderPhone) || senderPhone.endsWith(adminPhone))) {
          log(`Skipping AI reply for admin message from ${senderPhone}`);
          return;
        }

        const userText = (msg.body || msg.caption || '').trim();
        const msgLower = userText.toLowerCase();

        if (['stop', 'cancel', 'exit', 'quit', 'reset'].includes(msgLower)) {
          clearHistory(senderPhone);
          try {
            await client.sendMessage(msg.from, `✅ Conversation reset. Feel free to start over anytime! 😊`);
          } catch (e) { }
          return;
        }

        const isFirstMessage = !greetedPhones.has(senderPhone);
        if (isFirstMessage) greetedPhones.add(senderPhone);

        await handleAiAutoreply(msg, isFirstMessage);
      }
    } catch (e) {
      console.error('Failed to handle incoming WhatsApp message:', e.message);
    }
  });

  client.on('auth_failure', (msg) => {
    log('Auth failure: ' + msg);
    isReady = false;
  });

  client.on('disconnected', (reason) => {
    log('WhatsApp disconnected: ' + reason);
    isReady = false;
    _reconnect();
  });
}

function getSystemPrompt() {
  const promptFile = process.env.SYSTEM_PROMPT_FILE || 'ai-context.md';
  try {
    const filePath = path.isAbsolute(promptFile) ? promptFile : path.join(__dirname, promptFile);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8').trim();
    }
  } catch (err) { }

  if (process.env.SYSTEM_PROMPT) return process.env.SYSTEM_PROMPT;
  if (automationConfig.systemPrompt) return automationConfig.systemPrompt;

  return 'You are a helpful customer service AI assistant.';
}

async function handleAiAutoreply(msg, isFirstMessage = false) {
  const apiKey = automationConfig.openRouterApiKey || process.env.OPENROUTER_API_KEY;
  const FREE_MODELS = [
    automationConfig.model && automationConfig.model !== 'openrouter/auto' ? automationConfig.model : null,
    'openai/gpt-oss-120b',
    'poolside/laguna-m.1',
    'nvidia/nemotron-3-super',
    'google/gemma-3-27b-it:free',
    'qwen/qwen3-8b:free',
    'mistralai/mistral-7b-instruct:free'
  ].filter(Boolean);

  const basePrompt = getSystemPrompt();
  const senderPhone = msg.from.split('@')[0];
  const userText = (msg.body || msg.caption || '').trim();

  if (!userText) return;

  if (!apiKey) {
    log(`[AI Autoreply] No OpenRouter API key configured. Notifying customer ${senderPhone}.`);
    try {
      await client.sendMessage(msg.from, `⚠️ AI assistant is not configured yet.\n\nPlease insert a valid OpenRouter API key in the *Settings* to enable automated responses.`);
    } catch (err) {
      log(`[AI Autoreply] Failed to send no-key notice: ${err.message}`);
    }
    return;
  }

  const greetingInstruction = isFirstMessage
    ? `\n\nThis is the customer's FIRST message. You may greet them briefly and naturally.`
    : `\n\nIMPORTANT: This is NOT the customer's first message. Do NOT greet them. Go straight to the point.`;

  const bookingInstruction = `

BOOKING RULES — VERY IMPORTANT:
- When a customer wants to book/appointment/schedule, ask for ALL required details in ONE SINGLE message:
  Name, Phone Number, Service/Request, and Preferred Date & Time.
- Do NOT ask for one field at a time.
- When confirmed, output: [BOOKING_CONFIRMED: name="...", phone="...", service="...", datetime="..."]
- If customer wants to cancel, output: [CANCEL]`;

  const systemPrompt = basePrompt + greetingInstruction + bookingInstruction;

  addToHistory(senderPhone, 'user', userText);
  const history = conversationHistory.get(senderPhone) || [];

  let replyText = '';
  let usedModel = '';
  for (const model of FREE_MODELS) {
    log(`[AI Autoreply] Trying model ${model} for ${senderPhone}...`);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'X-Title': 'WhatsApp CRM Service'
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...history
          ]
        })
      });

      if (res.ok) {
        const aiData = await res.json();
        const text = aiData?.choices?.[0]?.message?.content;
        if (text) {
          replyText = text;
          usedModel = model;
          break;
        }
      }
    } catch (err) {
      log(`[AI Autoreply] Model ${model} threw: ${err.message}`);
    }
  }

  if (!replyText) {
    log(`[AI Autoreply] All models failed for ${senderPhone}.`);
    return;
  }

  try {
    if (replyText.includes('[CANCEL]')) {
      clearHistory(senderPhone);
      const cleanReply = replyText.replace('[CANCEL]', '').trim() || `No problem! Conversation cancelled. Type anything to start again. 😊`;
      await client.sendMessage(msg.from, cleanReply);
      return;
    }

    const bookingTagRegex = /\[BOOKING_CONFIRMED:\s*name="([^"]*)",\s*phone="([^"]*)",\s*service="([^"]*)",\s*datetime="([^"]*)"\]/i;
    const bookingMatch = replyText.match(bookingTagRegex);
    if (bookingMatch) {
      const [, bName, bPhone, bService, bDatetime] = bookingMatch;
      const cleanReply = replyText.replace(bookingTagRegex, '').replace(/\n{3,}/g, '\n\n').trim();

      const isLid = (msg.from || '').includes('@lid');
      const waLinkPhone = isLid ? bPhone.replace(/\D/g, '') : senderPhone;

      const adminPhone = (process.env.ADMIN_PHONE || '').replace(/\D/g, '');
      if (adminPhone && client) {
        const adminJid = `${adminPhone}@c.us`;
        const adminMsg = `📅 *New Booking Request!*\n─────────────────\n👤 *Name:* ${bName}\n📞 *Phone:* ${bPhone}\n🛠️ *Service:* ${bService}\n📆 *Date/Time:* ${bDatetime}\n─────────────────\n💬 *Customer WA:* wa.me/${waLinkPhone}`;
        try {
          await client.sendMessage(adminJid, adminMsg);
        } catch (e) { }
      }

      await client.sendMessage(msg.from, cleanReply || `✅ Your booking is confirmed! We'll contact you shortly. 😊`);
      clearHistory(senderPhone);
      return;
    }

    addToHistory(senderPhone, 'assistant', replyText);
    await client.sendMessage(msg.from, replyText);

    await forwardToBackend({
      from: (client.info?.wid?._serialized) || 'system@c.us',
      body: replyText,
      type: 'chat',
      hasMedia: false
    });
  } catch (err) {
    log(`[AI Autoreply] Error processing reply: ${err.message}`);
  }
}

function _reconnect() {
  log('Reconnecting in 5 s...');
  setTimeout(() => {
    const oldClient = client;
    client = null;
    if (oldClient) {
      oldClient.destroy().catch(() => { }).finally(() => {
        _initWithRetry(0);
      });
    } else {
      _initWithRetry(0);
    }
  }, 5000);
}

let initAttempt = 0;
function _initWithRetry(attempt) {
  initAttempt = attempt;
  if (attempt > 8) {
    log('Init failed after 8 retries.');
    return;
  }

  log(`Initializing WhatsApp client (attempt ${attempt + 1}/9)...`);

  if (!client) {
    initWhatsAppClient();
  }

  client.initialize().catch(async (err) => {
    const msg = err.message || err.toString();
    log(`Init error details: ${msg}`);

    const oldClient = client;
    client = null;
    if (oldClient) {
      try {
        await oldClient.destroy();
      } catch (e) { }
    }

    setTimeout(() => _initWithRetry(attempt + 1), 5000);
  });
}

// ─── Authentication Routes ────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (getAuthenticatedUser(req)) {
    return res.redirect('/client');
  }
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const expectedUser = process.env.AUTH_USER || 'admin';
  const expectedPass = process.env.AUTH_PASSWORD || 'password';

  if (username === expectedUser && password === expectedPass) {
    const expiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const payload = `${username}|${expiry}`;
    const signature = crypto
      .createHmac('sha256', process.env.WA_SECRET || 'fallback_secret')
      .update(payload)
      .digest('hex');
    const token = `${payload}|${signature}`;

    res.setHeader('Set-Cookie', `wa_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
    return res.json({ success: true });
  }

  return res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'wa_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
  res.json({ success: true });
});

// ─── Web UI ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (getAuthenticatedUser(req)) {
    return res.redirect('/client');
  }
  res.redirect('/login');
});

app.get('/client', authenticateUi, (req, res) => {
  res.sendFile(path.join(__dirname, 'whatsapp-client.html'));
});
app.get('/chat', authenticateUi, (req, res) => {
  res.sendFile(path.join(__dirname, 'whatsapp-client.html'));
});

// ─── Phone Number Pairing API ────────────────────────────────────────────────
app.post('/api/pair-phone', async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }

  if (!client) {
    return res.status(503).json({ error: 'WhatsApp client is still starting up. Please wait 10 seconds.' });
  }

  try {
    const cleanedNumber = phone.toString().replace(/\D/g, '');
    const fullNumber = cleanedNumber.length === 10 ? '91' + cleanedNumber : cleanedNumber;

    log(`[Pairing] Requesting 8-digit pairing code for +${fullNumber}...`);
    const code = await client.requestPairingCode(fullNumber);
    currentPairingCode = code;
    log(`[Pairing] Successfully generated pairing code: ${code}`);

    res.json({
      success: true,
      code: code,
      phone: fullNumber,
      message: 'Enter this code in WhatsApp -> Linked Devices -> Link with phone number'
    });
  } catch (err) {
    log(`[Pairing] Failed to generate code: ${err.message}`);
    res.status(500).json({ error: err.message || 'Failed to request pairing code' });
  }
});

// ─── Direct Pairing Form Page ────────────────────────────────────────────────
app.get('/pair', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>WhatsApp Phone Pairing</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background-color: #f0f2f5; }
        .card { background: white; padding: 2.5rem; border-radius: 16px; box-shadow: 0 10px 25px rgba(0,0,0,0.08); text-align: center; max-width: 420px; width: 90%; }
        h2 { margin-top: 0; color: #1e293b; }
        p { color: #64748b; font-size: 0.95rem; line-height: 1.5; }
        input { width: 100%; box-sizing: border-box; padding: 12px 16px; border: 2px solid #e2e8f0; border-radius: 8px; font-size: 1.05rem; margin: 15px 0; outline: none; transition: border-color 0.2s; }
        input:focus { border-color: #25d366; }
        button { width: 100%; background: #25d366; color: white; border: none; padding: 14px; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #1eb956; }
        .code-box { display: none; margin-top: 20px; padding: 15px; background: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 8px; }
        .code-text { font-size: 2rem; letter-spacing: 4px; font-weight: 700; color: #0f172a; margin: 10px 0; font-family: monospace; }
        .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 0.8rem; font-weight: 600; margin-bottom: 12px; }
        .badge-ready { background: #dcfce7; color: #16a34a; }
        .badge-wait { background: #fef3c7; color: #d97706; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="badge ${isReady ? 'badge-ready' : 'badge-wait'}">
          ${isReady ? '✓ WhatsApp Connected' : 'Status: Waiting for Connection'}
        </div>
        <h2>Link with Phone Number</h2>
        <p>Enter your 10-digit WhatsApp number to receive an 8-digit linking code.</p>
        
        <input type="text" id="phone" placeholder="e.g. 9301530783" />
        <button id="btn" onclick="getCode()">Get Pairing Code</button>

        <div id="result" class="code-box">
          <p style="margin: 0; color: #475569; font-weight: 500;">Enter this code on your phone:</p>
          <div class="code-text" id="displayCode">----</div>
          <p style="font-size: 0.85rem; color: #64748b; margin-bottom: 0;">Open WhatsApp &gt; Linked Devices &gt; Link with phone number instead</p>
        </div>
      </div>

      <script>
        async function getCode() {
          const phoneInput = document.getElementById('phone');
          const btn = document.getElementById('btn');
          const result = document.getElementById('result');
          const displayCode = document.getElementById('displayCode');

          if (!phoneInput.value.trim()) {
            alert('Please enter a phone number');
            return;
          }

          btn.disabled = true;
          btn.innerText = 'Requesting Code...';

          try {
            const res = await fetch('/api/pair-phone', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone: phoneInput.value.trim() })
            });

            const data = await res.json();
            if (data.success && data.code) {
              displayCode.innerText = data.code;
              result.style.display = 'block';
              btn.innerText = 'Code Received!';
            } else {
              alert('Error: ' + (data.error || 'Failed to get code'));
              btn.disabled = false;
              btn.innerText = 'Get Pairing Code';
            }
          } catch (e) {
            alert('Connection failed: ' + e.message);
            btn.disabled = false;
            btn.innerText = 'Get Pairing Code';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    ready: isReady,
    qr: qrCodeData,
    pairingCode: currentPairingCode,
    waSecret: WA_SECRET,
    username: process.env.AUTH_USER || 'admin'
  });
});

app.get('/api/automation/config', authenticateApi, (req, res) => {
  res.json({
    ...automationConfig,
    systemPrompt: getSystemPrompt()
  });
});

app.post('/api/automation/config', authenticateApi, (req, res) => {
  const { enabled, systemPrompt, openRouterApiKey, model } = req.body;
  if (enabled !== undefined) automationConfig.enabled = !!enabled;
  if (systemPrompt !== undefined) automationConfig.systemPrompt = systemPrompt;
  if (openRouterApiKey !== undefined) automationConfig.openRouterApiKey = openRouterApiKey;
  if (model !== undefined) automationConfig.model = model;

  const success = saveAutomationConfig();
  if (success) {
    res.json({ success: true, config: automationConfig });
  } else {
    res.status(500).json({ error: 'Failed to save configuration file' });
  }
});

app.get('/api/chats', async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp client is not ready. Link your phone first.', ready: false });
  }
  try {
    const chats = await client.getChats();
    chats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const chatList = await Promise.all(chats.slice(0, 40).map(async (chat) => {
      let lastMsg = null;
      if (chat.lastMessage) {
        lastMsg = {
          body: chat.lastMessage.body,
          fromMe: chat.lastMessage.fromMe,
          timestamp: chat.lastMessage.timestamp,
          type: chat.lastMessage.type
        };
      }
      return {
        id: chat.id._serialized,
        name: chat.name || chat.id.user,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount,
        timestamp: chat.timestamp,
        lastMessage: lastMsg
      };
    }));
    res.json(chatList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chats/:jid/messages', async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp client is not ready.' });
  }
  try {
    const chat = await client.getChatById(req.params.jid);
    const messages = await chat.fetchMessages({ limit: 50 });
    res.json(messages.map(msg => ({
      id: msg.id.id,
      body: msg.body,
      from: msg.from,
      to: msg.to,
      fromMe: msg.fromMe,
      timestamp: msg.timestamp,
      type: msg.type,
      hasMedia: msg.hasMedia
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chats/:jid/messages', async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp client is not ready.' });
  }
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message content is required' });
  try {
    const sentMsg = await client.sendMessage(req.params.jid, message);
    res.json({
      success: true,
      message: {
        id: sentMsg.id.id,
        body: sentMsg.body,
        from: sentMsg.from,
        to: sentMsg.to,
        fromMe: sentMsg.fromMe,
        timestamp: sentMsg.timestamp,
        type: sentMsg.type
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-message', async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp client is not ready.' });
  }
  const { phone, message, countryCode, imageUrl, mediaUrl, mediaBase64, mediaMimeType, filename } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  const cc2 = (countryCode || '91').replace(/\D/g, '');
  try {
    const cleaned = phone.replace(/\D/g, '');
    const withCountry = cleaned.startsWith(cc2) ? cleaned : cc2 + cleaned;

    let targetJid = `${withCountry}@c.us`;
    try {
      const numberId = await client.getNumberId(withCountry);
      if (numberId) targetJid = numberId._serialized;
    } catch (err) { }

    const { MessageMedia } = require('whatsapp-web.js');
    let mediaToSend = null;
    const urlToUse = imageUrl || mediaUrl;

    if (mediaBase64 && mediaMimeType) {
      mediaToSend = new MessageMedia(mediaMimeType, mediaBase64, filename || 'file');
    } else if (urlToUse) {
      try {
        const response = await fetch(urlToUse);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const mime = response.headers.get('content-type') || 'image/jpeg';
          mediaToSend = new MessageMedia(mime, buffer.toString('base64'), filename || 'file');
        }
      } catch (e) { }
    }

    if (mediaToSend) {
      await client.sendMessage(targetJid, mediaToSend, { caption: message || '' });
    } else {
      if (!message) return res.status(400).json({ error: 'message required if no media' });
      await client.sendMessage(targetJid, message);
    }
    res.json({ success: true });
  } catch (err) {
    log('Send error: ' + err.message);
    if (err.message && err.message.includes('detached Frame')) {
      isReady = false;
      _reconnect();
      return res.status(503).json({ error: 'WhatsApp session expired — reconnecting, try again in 10 s' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/broadcast', async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp client is not ready.' });
  }
  const { contacts, message, template, delay, interval } = req.body;
  if (!contacts || !Array.isArray(contacts)) return res.status(400).json({ error: 'contacts array is required' });

  const msgText = message || template || '';
  if (!msgText) return res.status(400).json({ error: 'message template content is required' });

  const delaySec = parseInt(delay || interval || 5, 10);
  res.json({ success: true, message: `Started background broadcast to ${contacts.length} contacts.` });

  (async () => {
    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      let phone = typeof contact === 'string' || typeof contact === 'number' ? String(contact) : contact?.phone || contact?.number || '';
      if (!phone) continue;

      let msgToSend = msgText;
      if (contact && typeof contact === 'object') {
        for (const key in contact) {
          msgToSend = msgToSend.replace(new RegExp(`{${key}}`, 'gi'), contact[key]);
        }
      }

      try {
        const cleaned = phone.replace(/\D/g, '');
        const cc2 = '91';
        const withCountry = cleaned.length <= 10 ? cc2 + cleaned : cleaned;
        let targetJid = `${withCountry}@c.us`;

        try {
          const numberId = await client.getNumberId(withCountry);
          if (numberId) targetJid = numberId._serialized;
        } catch (e) { }

        await client.sendMessage(targetJid, msgToSend);
      } catch (err) { }

      if (i < contacts.length - 1) {
        await new Promise(r => setTimeout(r, delaySec * 1000));
      }
    }
  })();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function forwardToBackend(msg) {
  const backendUrl = process.env.BACKEND_URL;
  if (!backendUrl) return;

  const fromJid = msg.from || (client?.info?.wid?._serialized) || 'system@c.us';
  const senderPhone = fromJid.split('@')[0];

  try {
    await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wa-secret': process.env.WA_SECRET || ''
      },
      body: JSON.stringify({
        from: senderPhone,
        cnumber: senderPhone,
        body: msg.body || msg.caption || '',
        hasMedia: !!msg.hasMedia,
        type: msg.type || 'chat'
      })
    });
  } catch (e) { }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFile(path.join(LOGS_DIR, 'service.log'), line + '\n', () => { });
}

function startKeepAlive() {
  const url = process.env.PUBLIC_URL || (process.env.SPACE_HOST ? `https://${process.env.SPACE_HOST}` : null);
  if (!url) {
    log('Keep-alive: Neither PUBLIC_URL nor SPACE_HOST is defined. Self-ping keep-alive is disabled.');
    return;
  }

  const intervalMinutes = parseFloat(process.env.KEEP_ALIVE_INTERVAL_MINUTES) || 10;
  const intervalMs = intervalMinutes * 60 * 1000;

  log(`Keep-alive: Starting self-ping to ${url} every ${intervalMinutes} minutes.`);
  const sendPing = () => {
    try {
      const clientModule = url.startsWith('https') ? https : http;
      clientModule.get(url, { timeout: 10000 }, (res) => {
        log(`Keep-alive: Ping response: ${res.statusCode}`);
      }).on('error', (err) => {
        log(`Keep-alive error: ${err.message}`);
      });
    } catch (err) { }
  };

  setTimeout(sendPing, 10000);
  setInterval(sendPing, intervalMs);
}

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`WhatsApp service running on port ${PORT}`);
  startKeepAlive();
  _initWithRetry(0);
});