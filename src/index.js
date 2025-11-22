import express from 'express';
import dotenv from 'dotenv';
import whatsappPkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = whatsappPkg;
import qrcode from 'qrcode-terminal';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { AIService } from './services/ai.js';
import { MultiAIService } from './services/multi-ai.js';
import { MegaService } from './services/mega.js';
import { OCRService } from './services/ocr.js';
import { ConversationManager } from './services/conversation.js';
import { UserManager } from './services/user-manager.js';
import { AuthService } from './services/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static('public')); // ✅ Serve static files

let whatsappClient = null;
let isReady = false;
let currentQR = null;

// ✅ SPAM KONFIGURATION
let maxSpamLimit = 500; // Default: 500, Max: 100000

// Services
const aiService = new AIService();
const multiAI = new MultiAIService();
const megaService = new MegaService();
const ocrService = new OCRService();
const conversationManager = new ConversationManager();
const userManager = new UserManager();
const authService = new AuthService();

// Puppeteer Config - Optimiert für Windows UND Render.com
async function getPuppeteerConfig() {
    const isProduction = process.env.NODE_ENV === 'production';
    const isWindows = os.platform() === 'win32';

    if (isProduction) {
        try {
            const chromium = await import('@sparticuz/chromium');
            const executablePath = await chromium.default.executablePath();

            console.log('🚀 Production Mode: Nutze @sparticuz/chromium');

            return {
                executablePath,
                headless: true,
                args: [
                    ...chromium.default.args,
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--single-process',
                    '--no-zygote',
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process'
                ],
                ignoreHTTPSErrors: true,
                timeout: 60000
            };
        } catch (error) {
            console.error('❌ Chromium setup failed:', error);
            throw error;
        }
    }

    console.log('💻 Development Mode: Nutze lokales Chrome/Chromium');

    return {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ],
        defaultViewport: null,
        timeout: 0
    };
}

// WhatsApp Client initialisieren
async function initializeWhatsApp() {
    console.log('🔄 Initialisiere WhatsApp Client...');

    try {
        const puppeteerConfig = await getPuppeteerConfig();
        const sessionPath = path.join(os.tmpdir(), 'whatsapp-session');

        whatsappClient = new Client({
            authStrategy: new LocalAuth({
                clientId: 'wh-ha-bot',
                dataPath: sessionPath
            }),
            puppeteer: puppeteerConfig,
            qrMaxRetries: 5,
            restartOnAuthFail: true,
            takeoverOnConflict: true,
            takeoverTimeoutMs: 60000
        });

        whatsappClient.on('qr', (qr) => {
            console.log('\n' + '='.repeat(60));
            console.log('📱 WHATSAPP QR CODE - JETZT SCANNEN!');
            console.log('='.repeat(60));
            qrcode.generate(qr, { small: true });
            console.log('💡 WhatsApp öffnen → Menü → Verknüpfte Geräte → Gerät verknüpfen');
            console.log('🔗 QR Code auch unter: http://localhost:' + PORT + '/qr');
            console.log('='.repeat(60) + '\n');
            currentQR = qr;
            setTimeout(() => { currentQR = null; }, 60000);
        });

        whatsappClient.on('ready', () => {
            console.log('\n✅ WhatsApp Bot ist bereit und verbunden!');
            console.log('📊 Dashboard: http://localhost:' + PORT + '/dashboard\n');
            isReady = true;
        });

        whatsappClient.on('message', async (message) => {
            try {
                await handleMessage(message);
            } catch (error) {
                console.error('❌ Fehler beim Verarbeiten der Nachricht:', error);
            }
        });

        whatsappClient.on('authenticated', () => {
            console.log('🔐 WhatsApp authentifiziert');
        });

        whatsappClient.on('auth_failure', (msg) => {
            console.error('❌ Authentifizierung fehlgeschlagen:', msg);
        });

        whatsappClient.on('disconnected', (reason) => {
            console.log('📱 WhatsApp getrennt:', reason);
            isReady = false;
            setTimeout(initializeWhatsApp, 10000);
        });

        whatsappClient.on('loading_screen', (percent, message) => {
            console.log('⏳ Lade WhatsApp Web:', percent + '%', message);
        });

        await whatsappClient.initialize();

    } catch (error) {
        console.error('❌ WhatsApp Initialisierung fehlgeschlagen:', error);
        console.log('🔄 Versuche in 15 Sekunden erneut...');
        setTimeout(initializeWhatsApp, 15000);
    }
}

// Hauptfunktion: Nachrichten verarbeiten
async function handleMessage(message) {
    if (message.from === 'status@broadcast') return;
    if (message.fromMe) return;

    const chat = await message.getChat();
    const chatId = chat.id._serialized;

    // ✅ Telefonnummer extrahieren (z.B. "+491234567890@c.us" → "+491234567890")
    const phoneNumber = chat.id.user ? `+${chat.id.user.replace('@c.us', '')}` : null;

    // ✅ User-Einstellungen laden (falls User registriert ist)
    const userSettings = userManager.getUserSettings(phoneNumber) || {};

    console.log(`📨 Nachricht von ${chat.name || chat.id.user} (${phoneNumber || 'Unbekannt'}): ${message.body}`);

    // ✅ CHECK: ReactOnCommand - nur auf Befehle reagieren?
    if (userSettings.reactOnCommand) {
        const prefix = userSettings.commandPrefix || '!';
        if (!message.body.startsWith(prefix)) {
            console.log(`⏭️ Nachricht ignoriert (User reagiert nur auf "${prefix}" Befehle)`);
            return;
        }
        // Entferne Prefix für Weiterverarbeitung
        message.body = message.body.substring(prefix.length).trim();
    }

    // ✅ SPAM FUNKTION mit User-spezifischem Limit
    if (message.body.startsWith('?spam ')) {
        const spamMatch = message.body.match(/^\?spam\s+(.+?)\s+(\d+)$/);

        if (!spamMatch) {
            console.log('❌ Ungültiges Spam-Format');
            return;
        }

        const spamText = spamMatch[1];
        let spamCount = parseInt(spamMatch[2]);

        // ✅ User-spezifisches Spam-Limit
        const userSpamLimit = userSettings.spamLimit || maxSpamLimit;
        if (spamCount > userSpamLimit) {
            console.log(`⚠️ Maximum für ${chat.name}: ${userSpamLimit} Nachrichten! Setze auf ${userSpamLimit}...`);
            spamCount = userSpamLimit;
        }

        if (spamCount < 1) {
            console.log('❌ Anzahl muss mindestens 1 sein!');
            return;
        }

        console.log(`🚀 SPAM AKTIVIERT: "${spamText}" x${spamCount} Nachrichten - MAXIMALE GESCHWINDIGKEIT!`);

        const startTime = Date.now();
        let sentCount = 0;
        let errorCount = 0;

        try {
            // 🔥🔥🔥 ABSOLUTE MAXIMALE GESCHWINDIGKEIT: ALLE Nachrichten SOFORT!
            console.log('⚡ Starte alle Nachrichten gleichzeitig...');

            const promises = [];

            // Erstelle ALLE Promises auf einmal - kein Batch-Limit!
            for (let i = 0; i < spamCount; i++) {
                promises.push(
                    chat.sendMessage(spamText)
                        .then(() => { sentCount++; })
                        .catch(() => { errorCount++; })
                );
            }

            // Sende ALLE gleichzeitig - keine Wartezeit!
            await Promise.allSettled(promises);

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            const messagesPerSecond = (sentCount / parseFloat(duration)).toFixed(1);

            console.log(`✅ Spam abgeschlossen: ${sentCount}/${spamCount} Nachrichten in ${duration}s (${messagesPerSecond} msg/s)`);
            if (errorCount > 0) {
                console.log(`⚠️ Fehler: ${errorCount} Nachrichten konnten nicht gesendet werden`);
            }

        } catch (error) {
            console.error('❌ Spam Fehler:', error);
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`⚠️ Spam gestoppt nach ${duration}s - ${sentCount}/${spamCount} gesendet - Fehler: ${error.message}`);
        }

        return;
    }

    // Check für Reset-Befehl
    if (message.body.toLowerCase().includes('vergiss') &&
        (message.body.toLowerCase().includes('nachricht') ||
         message.body.toLowerCase().includes('chat') ||
         message.body.toLowerCase().includes('gespräch'))) {
        conversationManager.clearChat(chatId);
        await message.reply('✅ Alle Nachrichten in diesem Chat wurden vergessen. Wir können von vorne anfangen!');
        return;
    }

    // ✅ NEU: Check für Präfix (. oder /)
    let userMessage = message.body;
    let forceMode = null; // null = auto, 'simple' = nur Gemini, 'multi' = Multi-AI

    if (userMessage.startsWith('.')) {
        forceMode = 'simple';
        userMessage = userMessage.substring(1).trim();
        console.log('⚡ SIMPLE MODE erzwungen (nur Gemini)');
        conversationManager.incrementSimpleForced();
    } else if (userMessage.startsWith('/')) {
        forceMode = 'multi';
        userMessage = userMessage.substring(1).trim();
        console.log('🧠 MULTI-AI MODE erzwungen');
        conversationManager.incrementMultiForced();
    }

    await chat.sendStateTyping();

    try {
        let hasImage = false;
        let imageText = '';
        let imageBuffer = null;

        if (message.hasMedia) {
            try {
                const media = await message.downloadMedia();
                if (media && (media.mimetype.startsWith('image/'))) {
                    hasImage = true;
                    imageBuffer = Buffer.from(media.data, 'base64');

                    console.log('🔤 Führe OCR durch...');
                    imageText = await ocrService.performOCR(imageBuffer);
                    conversationManager.incrementOCRProcessed();

                    if (imageText.trim()) {
                        userMessage = `[Bild enthält Text: ${imageText}]\n\n${userMessage || 'Was siehst du auf diesem Bild?'}`;
                    }
                }
            } catch (error) {
                console.error('⚠️ Fehler beim Bild-Processing:', error);
            }
        }

        if (isMegaRequest(userMessage)) {
            await handleMegaRequest(chat, message, userMessage);
            return;
        }

        conversationManager.addMessage(chatId, 'user', userMessage);

        const isSchoolTopic = isSchoolRelated(userMessage);

        // ✅ KI-Antwort generieren mit forceMode
        const history = conversationManager.getHistory(chatId);

        // ✅ NEU: Bei Bild → OCR-Text für Multi-AI System bereitstellen
        // (Gemini bekommt Bild direkt, DeepSeek/Llama bekommen OCR-Text)
        const ocrTextForMultiAI = (hasImage && imageText) ? imageText : null;

        const response = await multiAI.generateResponse(
            userMessage,
            history,
            isSchoolTopic,
            hasImage ? imageBuffer : null,
            forceMode, // ✅ NEU: Übergebe forceMode
            ocrTextForMultiAI // ✅ NEU: OCR-Text für Multi-AI
        );

        conversationManager.addMessage(chatId, 'assistant', response);

        await chat.clearState();

        if (response.length > 4000) {
            const chunks = splitMessage(response, 4000);
            for (const chunk of chunks) {
                await message.reply(chunk);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } else {
            await message.reply(response);
        }

    } catch (error) {
        console.error('❌ Fehler:', error);
        await chat.clearState();
        await message.reply('⚠️ Ein Fehler ist aufgetreten. Versuche es bitte nochmal.');
    }
}

function isMegaRequest(text) {
    const lowerText = text.toLowerCase();
    return (
        (lowerText.includes('mega') || lowerText.includes('cloud') || lowerText.includes('datei')) &&
        (lowerText.includes('buch') || lowerText.includes('seite') || lowerText.includes('lösung'))
    ) || (
        lowerText.match(/(?:deutsch|mathe|english|französisch|latein|physik|chemie|geschichte|religion|ethik).*seite.*\d+/i)
    );
}

async function handleMegaRequest(chat, message, text) {
    await chat.sendStateTyping();
    conversationManager.incrementMegaRequests();

    try {
        const match = text.match(/(deutsch|mathe|english|französisch|latein|physik|chemie|geschichte|religion|ethik).*?seite.*?(\d+)/i);

        if (!match) {
            await chat.clearState();
            await message.reply('⚠️ Ich konnte kein Fach oder keine Seitenzahl erkennen. Beispiel: "Gib mir das English Buch Seite 17"');
            return;
        }

        const fach = match[1].toLowerCase();
        const seite = match[2];

        console.log(`📚 MEGA-Anfrage: ${fach} Seite ${seite}`);

        await megaService.connect();

        const file = await megaService.findFile(fach, seite);

        const buffer = await file.downloadBuffer();

        const media = new MessageMedia(
            'image/jpeg',
            buffer.toString('base64'),
            `${fach}_seite_${seite}.jpg`
        );

        await chat.clearState();

        await message.reply(media, undefined, { caption: `📚 ${fach.charAt(0).toUpperCase() + fach.slice(1)} - Seite ${seite}` });

        console.log('🔤 Analysiere Seite...');
        const pageText = await ocrService.performOCR(buffer);
        conversationManager.incrementOCRProcessed();

        if (pageText.trim()) {
            const solution = await aiService.generateSolution(fach, seite, pageText);

            if (solution.length > 4000) {
                const chunks = splitMessage(solution, 4000);
                for (const chunk of chunks) {
                    await message.reply(chunk);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } else {
                await message.reply(solution);
            }
        }

    } catch (error) {
        console.error('❌ MEGA-Fehler:', error);
        await chat.clearState();
        await message.reply(`⚠️ Fehler beim Abrufen der Datei: ${error.message}`);
    }
}

function isSchoolRelated(text) {
    const schoolKeywords = [
        'hausaufgaben', 'aufgabe', 'übung', 'lernen', 'schule',
        'test', 'klassenarbeit', 'prüfung', 'klausur',
        'mathe', 'deutsch', 'english', 'französisch', 'latein',
        'physik', 'chemie', 'biologie', 'geschichte', 'erdkunde',
        'religion', 'ethik', 'formel', 'gleichung', 'lösung',
        'seite', 'buch', 'arbeitsblatt', 'vokabeln', 'grammatik'
    ];

    const lowerText = text.toLowerCase();
    return schoolKeywords.some(keyword => lowerText.includes(keyword));
}

function splitMessage(text, maxLength) {
    const chunks = [];
    let currentChunk = '';

    const lines = text.split('\n');

    for (const line of lines) {
        if ((currentChunk + line + '\n').length > maxLength) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = line + '\n';
        } else {
            currentChunk += line + '\n';
        }
    }

    if (currentChunk) chunks.push(currentChunk.trim());

    return chunks;
}

// Express Routes
app.get('/', (req, res) => {
    res.json({
        status: '✅ WhatsApp Hausaufgaben Bot läuft',
        ready: isReady,
        uptime: process.uptime(),
        version: '1.0.0',
        platform: os.platform(),
        node: process.version
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        whatsapp: isReady ? 'connected' : 'disconnected',
        memory: process.memoryUsage(),
        stats: conversationManager.getStats()
    });
});

app.get('/qr', async (req, res) => {
    if (!currentQR) {
        res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp QR Code</title>
    <style>
        body { font-family: Arial; text-align: center; padding: 50px; background: #f5f5f5; }
        .container { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
        h1 { color: #25D366; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📱 WhatsApp QR Code</h1>
        <p>Kein QR Code verfügbar - Bot ist bereits verbunden oder wird initialisiert.</p>
        <p>Status: ${isReady ? '✅ Verbunden' : '🔄 Initialisiere...'}</p>
        <script>setTimeout(() => location.reload(), 5000);</script>
    </div>
</body>
</html>
        `);
        return;
    }

    const QRCode = await import('qrcode');
    const qrDataURL = await QRCode.toDataURL(currentQR, { width: 256 });

    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp QR Code</title>
    <style>
        body { font-family: Arial; text-align: center; padding: 20px; background: linear-gradient(135deg, #667eea, #764ba2); }
        .container { max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 20px 40px rgba(0,0,0,0.2); }
        .qr { margin: 20px 0; }
        .timer { color: #dc3545; font-weight: bold; margin: 20px 0; }
        h1 { color: #25D366; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📱 WhatsApp QR Code</h1>
        <div class="qr">
            <img src="${qrDataURL}" alt="QR Code" style="max-width: 100%;">
        </div>
        <div class="timer">⏱️ Code läuft in <span id="countdown">60</span>s ab</div>
        <ol style="text-align: left;">
            <li>WhatsApp öffnen</li>
            <li>Menü → "Verknüpfte Geräte"</li>
            <li>"Gerät verknüpfen"</li>
            <li>QR Code scannen</li>
        </ol>
    </div>
    <script>
        let countdown = 60;
        setInterval(() => {
            countdown--;
            document.getElementById('countdown').textContent = countdown;
            if (countdown <= 0) location.reload();
        }, 1000);
    </script>
</body>
</html>
    `);
});

app.get('/api/stats', (req, res) => {
    const stats = conversationManager.getStats();
    const mem = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    res.json({
        whatsapp: {
            connected: isReady,
            ready: isReady
        },
        conversation: stats,
        system: {
            uptime: process.uptime(),
            platform: process.platform,
            nodeVersion: process.version,
            memory: {
                used: Math.round(mem.heapUsed / 1024 / 1024),
                total: Math.round(mem.heapTotal / 1024 / 1024),
                rss: Math.round(mem.rss / 1024 / 1024),
                external: Math.round(mem.external / 1024 / 1024)
            },
            cpu: {
                user: Math.round(cpuUsage.user / 1000),
                system: Math.round(cpuUsage.system / 1000)
            }
        },
        ai: {
            totalKeys: aiService.apiKeys.length,
            currentKeyIndex: aiService.currentKeyIndex,
            currentModel: aiService.getActiveModel(),
            usingFallback: aiService.usingFallback,
            quotaExceededCount: aiService.quotaExceededCount,
            hoursUntilReset: aiService.getTimeUntilResetHours()
        },
        multiAI: multiAI.getStats(),
        spam: {
            maxLimit: maxSpamLimit
        }
    });
});

// ✅ API Route: Spam Limit ändern
app.post('/api/spam/limit', express.json(), (req, res) => {
    const { limit } = req.body;

    if (!limit || isNaN(limit)) {
        return res.status(400).json({ error: 'Ungültiges Limit' });
    }

    const newLimit = parseInt(limit);

    if (newLimit < 1 || newLimit > 100000) {
        return res.status(400).json({ error: 'Limit muss zwischen 1 und 100.000 liegen' });
    }

    maxSpamLimit = newLimit;
    console.log(`✅ Spam Limit geändert: ${maxSpamLimit}`);

    res.json({
        success: true,
        maxLimit: maxSpamLimit,
        message: `Spam Limit auf ${maxSpamLimit} gesetzt`
    });
});

// ========== USER MANAGEMENT & AUTH API ==========

// ✅ Middleware: Session Check
function requireAuth(req, res, next) {
    const sessionId = req.headers['x-session-id'];
    const session = authService.validateSession(sessionId);

    if (!session) {
        return res.status(401).json({ error: 'Nicht authentifiziert' });
    }

    req.session = session;
    next();
}

// ✅ Middleware: Admin Only
function requireAdmin(req, res, next) {
    if (req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Admin-Rechte erforderlich' });
    }
    next();
}

// ✅ LOGIN
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
    }

    // Check Admin Login
    const adminLogin = userManager.loginAdmin(username, password);
    if (adminLogin.success) {
        const sessionId = authService.createSession(adminLogin.user.username, 'admin');
        return res.json({
            success: true,
            sessionId,
            user: adminLogin.user
        });
    }

    // Check User Login
    const userLogin = userManager.loginUser(username, password);
    if (userLogin.success) {
        const sessionId = authService.createSession(userLogin.user.username, 'user', userLogin.user.phone);
        return res.json({
            success: true,
            sessionId,
            user: userLogin.user
        });
    }

    return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
});

// ✅ LOGOUT
app.post('/api/logout', requireAuth, (req, res) => {
    const sessionId = req.headers['x-session-id'];
    authService.destroySession(sessionId);
    res.json({ success: true, message: 'Erfolgreich abgemeldet' });
});

// ✅ SESSION CHECK
app.get('/api/session', requireAuth, (req, res) => {
    res.json({
        success: true,
        user: {
            username: req.session.username,
            role: req.session.role,
            phone: req.session.phone
        }
    });
});

// ✅ GET ALL USERS (Admin only)
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
    const users = userManager.getAllUsers();
    res.json({ success: true, users });
});

// ✅ CREATE USER (Admin only)
app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
    const { username, password, phone } = req.body;

    if (!username || !password || !phone) {
        return res.status(400).json({ error: 'Username, Passwort und Telefonnummer erforderlich' });
    }

    const result = userManager.createUser(username, password, phone, req.session.username);

    if (!result.success) {
        return res.status(400).json(result);
    }

    res.json(result);
});

// ✅ DELETE USER (Admin only)
app.delete('/api/users/:phone', requireAuth, requireAdmin, (req, res) => {
    const { phone } = req.params;
    const result = userManager.deleteUser(phone);

    if (!result.success) {
        return res.status(404).json(result);
    }

    res.json(result);
});

// ✅ UPDATE USER PASSWORD (Admin only)
app.put('/api/users/:phone/password', requireAuth, requireAdmin, (req, res) => {
    const { phone } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) {
        return res.status(400).json({ error: 'Neues Passwort erforderlich' });
    }

    const result = userManager.updateUserPassword(phone, newPassword);

    if (!result.success) {
        return res.status(404).json(result);
    }

    res.json(result);
});

// ✅ UPDATE USER SETTINGS (User or Admin)
app.put('/api/users/:phone/settings', requireAuth, (req, res) => {
    const { phone } = req.params;

    // Users can only update their own settings
    if (req.session.role !== 'admin' && req.session.phone !== phone) {
        return res.status(403).json({ error: 'Keine Berechtigung' });
    }

    const { settings } = req.body;

    if (!settings) {
        return res.status(400).json({ error: 'Einstellungen erforderlich' });
    }

    const result = userManager.updateUserSettings(phone, settings);

    if (!result.success) {
        return res.status(404).json(result);
    }

    res.json(result);
});

// ✅ RESET USER PROMPT (User or Admin)
app.post('/api/users/:phone/reset-prompt', requireAuth, (req, res) => {
    const { phone } = req.params;

    // Users can only reset their own prompt
    if (req.session.role !== 'admin' && req.session.phone !== phone) {
        return res.status(403).json({ error: 'Keine Berechtigung' });
    }

    const result = userManager.resetPrompt(phone);

    if (!result.success) {
        return res.status(404).json(result);
    }

    res.json(result);
});

// ✅ GET USER SETTINGS (User or Admin)
app.get('/api/users/:phone/settings', requireAuth, (req, res) => {
    const { phone } = req.params;

    // Users can only view their own settings
    if (req.session.role !== 'admin' && req.session.phone !== phone) {
        return res.status(403).json({ error: 'Keine Berechtigung' });
    }

    const user = userManager.getUserByPhone(phone);

    if (!user) {
        return res.status(404).json({ error: 'Benutzer nicht gefunden' });
    }

    res.json({
        success: true,
        username: user.username,
        phone: user.phone,
        settings: user.settings
    });
});

// ✅ DASHBOARD CHAT (Authenticated users)
app.post('/api/chat', requireAuth, async (req, res) => {
    try {
        const { message, useMultiAI } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Nachricht erforderlich' });
        }

        // Get user settings if user (not admin)
        let userSettings = {};
        if (req.session.role === 'user' && req.session.phone) {
            userSettings = userManager.getUserSettings(req.session.phone);
        }

        const chatId = `dashboard_${req.session.username}`;
        const history = conversationManager.getHistory(chatId, 50);

        conversationManager.addMessage(chatId, 'user', message);

        const isSchoolTopic = isSchoolRelated(message);

        // ✅ Multi-AI or Simple based on request
        const forceMode = useMultiAI ? 'multi' : 'simple';

        const response = await multiAI.generateResponse(
            message,
            history,
            isSchoolTopic,
            null, // no image in dashboard chat
            forceMode,
            null // no OCR text
        );

        conversationManager.addMessage(chatId, 'assistant', response);

        res.json({
            success: true,
            response,
            timestamp: Date.now()
        });

    } catch (error) {
        console.error('❌ Dashboard Chat Fehler:', error);
        res.status(500).json({
            error: 'Ein Fehler ist aufgetreten',
            message: error.message
        });
    }
});

// ✅ GET DEFAULT PROMPTS
app.get('/api/prompts/defaults', requireAuth, (req, res) => {
    const defaults = userManager.getDefaultPrompts();
    res.json({ success: true, prompts: defaults });
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server läuft auf Port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`🔗 QR Code: http://localhost:${PORT}/qr`);
    console.log(`🏓 Ping: http://localhost:${PORT}/ping`);
    console.log(`\n💡 TIPP: Nutze UptimeRobot oder cron-job.org um /ping alle 5-30 Min aufzurufen`);
    console.log(`   Das hält den Bot wach und verhindert Render.com Sleep-Modus!\n`);
});

initializeWhatsApp();

process.on('SIGINT', async () => {
    console.log('🛑 Shutting down...');
    if (whatsappClient) await whatsappClient.destroy();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received...');
    if (whatsappClient) await whatsappClient.destroy();
    process.exit(0);
});
