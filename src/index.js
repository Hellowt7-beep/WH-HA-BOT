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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let whatsappClient = null;
let isReady = false;
let currentQR = null;

// Services
const aiService = new AIService();
const multiAI = new MultiAIService();
const megaService = new MegaService();
const ocrService = new OCRService();
const conversationManager = new ConversationManager();

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

    console.log(`📨 Nachricht von ${chat.name || chat.id.user}: ${message.body}`);

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
        multiAI: multiAI.getStats()
    });
});

app.get('/dashboard', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Bot Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        .header {
            background: rgba(255,255,255,0.95);
            padding: 30px;
            border-radius: 15px;
            margin-bottom: 20px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            text-align: center;
        }
        .header h1 {
            color: #667eea;
            font-size: 2.5em;
            margin-bottom: 10px;
        }
        .status {
            display: inline-block;
            padding: 8px 20px;
            border-radius: 20px;
            font-weight: bold;
            margin-top: 10px;
        }
        .status.online { background: #10b981; color: white; }
        .status.offline { background: #ef4444; color: white; }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }
        .card {
            background: rgba(255,255,255,0.95);
            padding: 25px;
            border-radius: 15px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            transition: transform 0.3s ease;
        }
        .card:hover {
            transform: translateY(-5px);
        }
        .card-icon {
            font-size: 3em;
            margin-bottom: 10px;
        }
        .card-title {
            color: #666;
            font-size: 0.9em;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 10px;
        }
        .card-value {
            color: #333;
            font-size: 2.5em;
            font-weight: bold;
        }
        .card-subtitle {
            color: #999;
            font-size: 0.85em;
            margin-top: 5px;
        }
        .card-small-value {
            color: #555;
            font-size: 1.2em;
            font-weight: 600;
            margin-top: 8px;
        }

        .section-title {
            color: white;
            font-size: 1.8em;
            margin: 30px 0 15px;
            font-weight: 600;
            text-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .live-indicator {
            display: inline-block;
            width: 10px;
            height: 10px;
            background: #10b981;
            border-radius: 50%;
            margin-right: 8px;
            animation: pulse 2s infinite;
        }

        .help-box {
            background: rgba(255,255,255,0.95);
            padding: 20px;
            border-radius: 15px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            margin-top: 20px;
        }
        .help-box h3 {
            color: #667eea;
            margin-bottom: 15px;
        }
        .help-box ul {
            list-style: none;
            padding: 0;
        }
        .help-box li {
            padding: 8px 0;
            border-bottom: 1px solid #eee;
        }
        .help-box li:last-child {
            border-bottom: none;
        }
        .prefix {
            background: #667eea;
            color: white;
            padding: 2px 8px;
            border-radius: 4px;
            font-family: monospace;
            margin-right: 8px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📱 WhatsApp Bot Dashboard</h1>
            <div class="status" id="status">
                <span class="live-indicator"></span>
                Lädt...
            </div>
        </div>

        <h2 class="section-title">📊 Nachrichten Statistiken</h2>
        <div class="grid">
            <div class="card">
                <div class="card-icon">📨</div>
                <div class="card-title">Nachrichten Empfangen</div>
                <div class="card-value" id="messagesReceived">0</div>
                <div class="card-subtitle">Gesamt</div>
            </div>

            <div class="card">
                <div class="card-icon">💬</div>
                <div class="card-title">Nachrichten Gesendet</div>
                <div class="card-value" id="messagesSent">0</div>
                <div class="card-subtitle">Gesamt</div>
            </div>

            <div class="card">
                <div class="card-icon">👥</div>
                <div class="card-title">Aktive Chats</div>
                <div class="card-value" id="totalChats">0</div>
                <div class="card-subtitle">Konversationen</div>
            </div>

            <div class="card">
                <div class="card-icon">📚</div>
                <div class="card-title">MEGA Anfragen</div>
                <div class="card-value" id="megaRequests">0</div>
                <div class="card-subtitle">Dateien abgerufen</div>
            </div>

            <div class="card">
                <div class="card-icon">🔤</div>
                <div class="card-title">OCR Verarbeitet</div>
                <div class="card-value" id="ocrProcessed">0</div>
                <div class="card-subtitle">Bilder gescannt</div>
            </div>

            <div class="card">
                <div class="card-icon">⏱️</div>
                <div class="card-title">Uptime</div>
                <div class="card-value" id="uptime" style="font-size: 1.5em;">0s</div>
                <div class="card-subtitle">Online seit</div>
            </div>
        </div>

        <h2 class="section-title">🧠 Multi-AI System</h2>
        <div class="grid">
            <div class="card">
                <div class="card-icon">💡</div>
                <div class="card-title">Einfache Anfragen</div>
                <div class="card-value" id="simpleQueries">0</div>
                <div class="card-subtitle">Nur Gemini</div>
            </div>

            <div class="card">
                <div class="card-icon">🧠</div>
                <div class="card-title">Komplexe Anfragen</div>
                <div class="card-value" id="complexQueries">0</div>
                <div class="card-subtitle">Multi-AI aktiviert</div>
            </div>

            <div class="card">
                <div class="card-icon">⚡</div>
                <div class="card-title">Simple Mode (Punkt)</div>
                <div class="card-value" id="simpleForced">0</div>
                <div class="card-subtitle">Erzwungen mit .</div>
            </div>

            <div class="card">
                <div class="card-icon">🚀</div>
                <div class="card-title">Multi Mode (Slash)</div>
                <div class="card-value" id="multiForced">0</div>
                <div class="card-subtitle">Erzwungen mit /</div>
            </div>

            <div class="card">
                <div class="card-icon">🌐</div>
                <div class="card-title">Web-Suchen</div>
                <div class="card-value" id="webSearches">0</div>
                <div class="card-subtitle">Tavily API</div>
            </div>

            <div class="card">
                <div class="card-icon">📈</div>
                <div class="card-title">Komplexitätsrate</div>
                <div class="card-value" id="complexityRate" style="font-size: 2em;">0%</div>
                <div class="card-subtitle">Multi-AI Nutzung</div>
            </div>
        </div>

        <h2 class="section-title">🤖 KI Modelle</h2>
        <div class="grid">
            <div class="card">
                <div class="card-icon">🔑</div>
                <div class="card-title">Gemini API Keys</div>
                <div class="card-value" id="geminiKeys">0</div>
                <div class="card-subtitle">Verfügbar</div>
                <div class="card-small-value" id="currentGeminiModel">-</div>
            </div>

            <div class="card">
                <div class="card-icon">📊</div>
                <div class="card-title">Aktuelles Modell</div>
                <div class="card-value" id="currentModel" style="font-size: 1.5em;">-</div>
                <div class="card-subtitle">Gemini</div>
            </div>

            <div class="card">
                <div class="card-icon">⏰</div>
                <div class="card-title">Quota Reset</div>
                <div class="card-value" id="quotaReset" style="font-size: 1.8em;">-</div>
                <div class="card-subtitle">Stunden bis Reset</div>
            </div>

            <div class="card">
                <div class="card-icon">⚠️</div>
                <div class="card-title">Quota Exceeded</div>
                <div class="card-value" id="quotaExceeded">0</div>
                <div class="card-subtitle">Gemini</div>
            </div>
        </div>

        <h2 class="section-title">💻 System</h2>
        <div class="grid">
            <div class="card">
                <div class="card-icon">🧠</div>
                <div class="card-title">RAM Verbrauch</div>
                <div class="card-value" id="ramUsed">0</div>
                <div class="card-subtitle">MB</div>
            </div>

            <div class="card">
                <div class="card-icon">💾</div>
                <div class="card-title">Total RAM</div>
                <div class="card-value" id="ramTotal">0</div>
                <div class="card-subtitle">MB</div>
            </div>

            <div class="card">
                <div class="card-icon">⚙️</div>
                <div class="card-title">CPU User</div>
                <div class="card-value" id="cpuUser">0</div>
                <div class="card-subtitle">ms</div>
            </div>

            <div class="card">
                <div class="card-icon">🔧</div>
                <div class="card-title">CPU System</div>
                <div class="card-value" id="cpuSystem">0</div>
                <div class="card-subtitle">ms</div>
            </div>

            <div class="card">
                <div class="card-icon">🖥️</div>
                <div class="card-title">Platform</div>
                <div class="card-value" id="platform" style="font-size: 1.5em;">-</div>
                <div class="card-subtitle">System</div>
            </div>

            <div class="card">
                <div class="card-icon">📦</div>
                <div class="card-title">Node Version</div>
                <div class="card-value" id="nodeVersion" style="font-size: 1.5em;">-</div>
                <div class="card-subtitle">Runtime</div>
            </div>
        </div>

        <div class="help-box">
            <h3>💡 Wie benutze ich die Präfixe?</h3>
            <ul>
                <li><span class="prefix">.</span> <strong>Simple Mode:</strong> Erzwingt einfache Verarbeitung (nur Gemini, schnell) - z.B. ".erkläre Therme in Mathematik"</li>
                <li><span class="prefix">/</span> <strong>Multi-AI Mode:</strong> Erzwingt Multi-AI System (3 KIs + Validatoren + Synthesizer) - z.B. "/was ist 2+2"</li>
                <li><strong>Kein Präfix:</strong> Automatische Erkennung (einfache Fragen → Gemini, komplexe → Multi-AI)</li>
            </ul>
        </div>
    </div>

    <script>
        async function updateStats() {
            try {
                const response = await fetch('/api/stats');
                const data = await response.json();

                // Status
                const statusEl = document.getElementById('status');
                if (data.whatsapp.connected) {
                    statusEl.className = 'status online';
                    statusEl.innerHTML = '<span class="live-indicator"></span>Online & Verbunden';
                } else {
                    statusEl.className = 'status offline';
                    statusEl.innerHTML = 'Offline';
                }

                // Nachrichten
                document.getElementById('messagesReceived').textContent = data.conversation.messagesReceived.toLocaleString();
                document.getElementById('messagesSent').textContent = data.conversation.messagesSent.toLocaleString();
                document.getElementById('totalChats').textContent = data.conversation.totalChats.toLocaleString();
                document.getElementById('megaRequests').textContent = data.conversation.megaRequests.toLocaleString();
                document.getElementById('ocrProcessed').textContent = data.conversation.ocrProcessed.toLocaleString();
                document.getElementById('uptime').textContent = data.conversation.uptimeFormatted;

                // Multi-AI
                document.getElementById('simpleQueries').textContent = data.multiAI.simpleQueries.toLocaleString();
                document.getElementById('complexQueries').textContent = data.multiAI.complexQueries.toLocaleString();
                document.getElementById('simpleForced').textContent = data.conversation.simpleForced.toLocaleString();
                document.getElementById('multiForced').textContent = data.conversation.multiForced.toLocaleString();
                document.getElementById('webSearches').textContent = data.multiAI.webSearches.toLocaleString();
                document.getElementById('complexityRate').textContent = data.multiAI.complexityRate;

                // KI Modelle
                document.getElementById('geminiKeys').textContent = data.ai.totalKeys.toLocaleString();
                document.getElementById('currentModel').textContent = data.ai.currentModel;
                document.getElementById('currentGeminiModel').textContent = data.multiAI.geminiModel;
                document.getElementById('quotaExceeded').textContent = data.multiAI.geminiQuotaExceeded.toLocaleString();

                const hoursUntilReset = data.ai.hoursUntilReset;
                if (hoursUntilReset !== null && hoursUntilReset > 0) {
                    document.getElementById('quotaReset').textContent = hoursUntilReset.toFixed(1) + 'h';
                } else {
                    document.getElementById('quotaReset').textContent = '-';
                }

                // System
                document.getElementById('ramUsed').textContent = data.system.memory.used.toLocaleString();
                document.getElementById('ramTotal').textContent = data.system.memory.total.toLocaleString();
                document.getElementById('cpuUser').textContent = data.system.cpu.user.toLocaleString();
                document.getElementById('cpuSystem').textContent = data.system.cpu.system.toLocaleString();
                document.getElementById('platform').textContent = data.system.platform;
                document.getElementById('nodeVersion').textContent = data.system.nodeVersion;

            } catch (error) {
                console.error('Fehler beim Laden der Stats:', error);
            }
        }

        updateStats();
        setInterval(updateStats, 3000);
    </script>
</body>
</html>
    `);
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
