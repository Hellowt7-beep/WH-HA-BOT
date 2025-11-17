import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

export class AIService {
    constructor() {
        this.apiKeys = [];
        this.currentKeyIndex = 0;
        this.keyFailCount = new Map();
        this.currentModel = 'gemini-2.5-flash';
        this.fallbackModel = 'gemini-2.5-flash-lite';
        this.usingFallback = false;
        this.quotaExceededCount = 0;
        this.lastQuotaExceeded = null;
        this.quotaResetCheckInterval = null;
        this.initialize();
    }

    initialize() {
        const keys = [];

        if (process.env.GEMINI_API_KEY) {
            keys.push(process.env.GEMINI_API_KEY);
        }

        for (let i = 2; i <= 100; i++) {
            const key = process.env[`GEMINI_API_KEY_${i}`];
            if (key) {
                keys.push(key);
            }
        }

        if (keys.length === 0) {
            throw new Error('Keine GEMINI_API_KEY gefunden!');
        }

        this.apiKeys = keys;
        console.log(`✅ ${this.apiKeys.length} Gemini API Key(s) geladen`);

        this.apiKeys.forEach(key => this.keyFailCount.set(key, 0));

        this.startQuotaResetTimer();
    }

    startQuotaResetTimer() {
        console.log(`✅ Passiver Auto-Reset aktiviert (prüft automatisch bei Requests)`);
    }

    async checkAndResetIfNeeded() {
        if (this.usingFallback && this.lastQuotaExceeded) {
            const nextMidnightUTC = this.getNextMidnightUTC();
            const now = Date.now();

            if (now >= nextMidnightUTC.getTime()) {
                console.log(`\n${'='.repeat(80)}`);
                console.log(`🔄 QUOTA RESET-ZEIT ERREICHT - Wechsle zurück zu ${this.currentModel}`);
                console.log(`💡 Der nächste Request wird mit dem Hauptmodell versucht`);
                console.log(`${'='.repeat(80)}\n`);
                this.resetToPrimaryModel();
            }
        }
    }

    getNextMidnightUTC() {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setUTCHours(24, 0, 0, 0);
        return tomorrow;
    }

    formatTimeUntilReset(ms) {
        if (ms <= 0) return 'JETZT';

        const hours = Math.floor(ms / (1000 * 60 * 60));
        const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));

        if (hours > 0) {
            return `${hours}h ${minutes}min`;
        }
        return `${minutes}min`;
    }

    getTimeUntilResetHours() {
        if (!this.lastQuotaExceeded) return null;

        const nextMidnightUTC = this.getNextMidnightUTC();
        const msUntilReset = nextMidnightUTC - Date.now();
        return Math.max(0, msUntilReset / (1000 * 60 * 60));
    }

    resetToPrimaryModel() {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`✅ ZURÜCK ZUM HAUPTMODELL: ${this.fallbackModel} → ${this.currentModel}`);
        console.log(`💡 Quota wurde zurückgesetzt - nutze wieder das bessere Modell!`);
        console.log(`${'='.repeat(80)}\n`);

        this.usingFallback = false;
        this.quotaExceededCount = 0;
        this.lastQuotaExceeded = null;

        this.apiKeys.forEach(key => this.keyFailCount.set(key, 0));
    }

    getNextKey() {
        const key = this.apiKeys[this.currentKeyIndex];
        this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
        return key;
    }

    markKeyFailed(key) {
        const count = this.keyFailCount.get(key) || 0;
        this.keyFailCount.set(key, count + 1);
        console.log(`⚠️ API Key ${this.apiKeys.indexOf(key) + 1} failed (${count + 1}x)`);
    }

    resetKeyFailCount(key) {
        this.keyFailCount.set(key, 0);
    }

    isQuotaError(error) {
        const msg = error.message.toLowerCase();
        return msg.includes('quota') ||
               msg.includes('429') ||
               msg.includes('too many requests') ||
               msg.includes('rate limit');
    }

    switchToFallback() {
        if (!this.usingFallback) {
            this.usingFallback = true;
            this.lastQuotaExceeded = Date.now();

            console.log(`\n${'='.repeat(80)}`);
            console.log(`🔄 MODELL-WECHSEL: ${this.currentModel} → ${this.fallbackModel}`);
            console.log(`💡 Grund: Quota für ${this.currentModel} erschöpft`);
            console.log(`✅ Fahre mit ${this.fallbackModel} fort (schneller & günstiger)`);
            console.log(`⏰ Automatischer Rückwechsel nach 12 Stunden oder am nächsten Tag`);
            console.log(`${'='.repeat(80)}\n`);
        }
    }

    getActiveModel() {
        return this.usingFallback ? this.fallbackModel : this.currentModel;
    }

    async generateResponse(userMessage, history = [], isSchoolTopic = false, imageBuffer = null) {
        await this.checkAndResetIfNeeded();

        const maxRetries = this.apiKeys.length;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const apiKey = this.getNextKey();

            try {
                const genAI = new GoogleGenerativeAI(apiKey);
                const activeModel = this.getActiveModel();
                const model = genAI.getGenerativeModel({ model: activeModel });

                let prompt = '';

                if (isSchoolTopic) {
                    prompt = `Du bist eine hilfsbereite KI-Assistentin. Hilf bei Hausaufgaben, erkläre Schritt für Schritt, aber sei kurz und präzise. Nutze Emojis wo passend.\n\n`;
                } else {
                    prompt = `Du bist eine freundliche KI-Assistentin. Antworte kurz, natürlich und hilfreich.\n\n`;
                }

                if (history.length > 0) {
                    history.slice(-10).forEach(msg => {
                        prompt += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
                    });
                }

                prompt += `User: ${userMessage}\nAssistant:`;

                let result;
                if (imageBuffer) {
                    const base64Image = imageBuffer.toString('base64');
                    const imagePart = {
                        inlineData: {
                            data: base64Image,
                            mimeType: "image/jpeg"
                        }
                    };
                    result = await model.generateContent([prompt, imagePart]);
                } else {
                    result = await model.generateContent(prompt);
                }

                const response = await result.response;

                this.resetKeyFailCount(apiKey);

                if (this.usingFallback && activeModel === this.currentModel) {
                    this.resetToPrimaryModel();
                }

                return response.text();

            } catch (error) {
                if (this.isQuotaError(error)) {
                    this.quotaExceededCount++;

                    if (this.quotaExceededCount >= this.apiKeys.length && !this.usingFallback) {
                        this.switchToFallback();
                        return this.generateResponse(userMessage, history, isSchoolTopic, imageBuffer);
                    }
                }

                this.markKeyFailed(apiKey);

                console.error(`❌ API Key ${attempt + 1}/${maxRetries} Fehler (${this.getActiveModel()}):`, error.message);

                if (attempt === maxRetries - 1) {
                    if (error.message.includes('overloaded') || error.message.includes('503')) {
                        return '⚠️ Alle API Keys gerade überlastet - versuch es in 30 Sekunden nochmal!';
                    }

                    if (!this.usingFallback && this.isQuotaError(error)) {
                        this.switchToFallback();
                        return this.generateResponse(userMessage, history, isSchoolTopic, imageBuffer);
                    }

                    throw new Error(`KI-Antwort fehlgeschlagen: ${error.message}`);
                }

                console.log(`🔄 Versuche nächsten API Key...`);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    }

    async generateSolution(fach, seite, pageText) {
        await this.checkAndResetIfNeeded();

        const maxRetries = this.apiKeys.length;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const apiKey = this.getNextKey();

            try {
                const genAI = new GoogleGenerativeAI(apiKey);
                const activeModel = this.getActiveModel();
                const model = genAI.getGenerativeModel({ model: activeModel });

                const prompt = `Analysiere die Aufgaben von Seite ${seite} (${fach}) und löse sie kurz und verständlich.

Text: ${pageText}

Gib die Lösungen strukturiert aus. Nutze ** für Überschriften und Emojis.`;

                const result = await model.generateContent(prompt);
                const response = await result.response;

                this.resetKeyFailCount(apiKey);

                if (this.usingFallback && activeModel === this.currentModel) {
                    this.resetToPrimaryModel();
                }

                return `📚 **${fach} - Seite ${seite}**\n\n${response.text()}`;

            } catch (error) {
                if (this.isQuotaError(error)) {
                    this.quotaExceededCount++;

                    if (this.quotaExceededCount >= this.apiKeys.length && !this.usingFallback) {
                        this.switchToFallback();
                        return this.generateSolution(fach, seite, pageText);
                    }
                }

                this.markKeyFailed(apiKey);
                console.error(`❌ Lösungs-API Key ${attempt + 1}/${maxRetries} Fehler (${this.getActiveModel()}):`, error.message);

                if (attempt === maxRetries - 1) {
                    if (error.message.includes('overloaded') || error.message.includes('503')) {
                        return '⚠️ KI gerade überlastet - versuch es gleich nochmal!';
                    }

                    if (!this.usingFallback && this.isQuotaError(error)) {
                        this.switchToFallback();
                        return this.generateSolution(fach, seite, pageText);
                    }

                    throw error;
                }

                console.log(`🔄 Versuche nächsten API Key...`);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    }

    getSchoolPrompt() {
        return '';
    }

    getDefaultPrompt() {
        return '';
    }
}
