import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

export class MultiAIService {
    constructor() {
        this.groq = new Groq({
            apiKey: process.env.GROQ_API_KEY
        });

        this.openRouterKey = process.env.OPENROUTER_API_KEY;

        this.geminiKeys = [];
        this.currentGeminiIndex = 0;
        this.loadGeminiKeys();

        this.currentGeminiModel = 'gemini-2.5-flash';
        this.fallbackGeminiModel = 'gemini-2.5-flash-lite';
        this.usingGeminiFallback = false;
        this.geminiQuotaExceeded = 0;
        this.lastGeminiQuotaTime = null;

        this.tavilyKey = process.env.TAVILY_API_KEY;

        this.stats = {
            simpleQueries: 0,
            complexQueries: 0,
            webSearches: 0,
            totalProcessed: 0
        };
    }

    loadGeminiKeys() {
        const keys = [];
        if (process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY);
        for (let i = 2; i <= 100; i++) {
            const key = process.env[`GEMINI_API_KEY_${i}`];
            if (key) keys.push(key);
        }
        this.geminiKeys = keys;
        console.log(`✅ Multi-AI: ${this.geminiKeys.length} Gemini Keys geladen`);
    }

    getNextMidnightGerman() {
        const now = new Date();
        const germanTimeStr = now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' });
        const germanTime = new Date(germanTimeStr);
        const nextMidnight = new Date(germanTime);
        nextMidnight.setHours(24, 0, 0, 0);
        return nextMidnight;
    }

    async checkGeminiQuotaReset() {
        if (this.usingGeminiFallback && this.lastGeminiQuotaTime) {
            const nextMidnight = this.getNextMidnightGerman();
            const now = Date.now();

            if (now >= nextMidnight.getTime()) {
                console.log(`\n${'='.repeat(80)}`);
                console.log(`🔄 QUOTA RESET (0 Uhr deutsche Zeit) - Wechsle zurück zu ${this.currentGeminiModel}`);
                console.log(`${'='.repeat(80)}\n`);
                this.usingGeminiFallback = false;
                this.geminiQuotaExceeded = 0;
                this.lastGeminiQuotaTime = null;
            }
        }
    }

    isQuotaError(error) {
        const msg = error.message?.toLowerCase() || '';
        return msg.includes('quota') ||
               msg.includes('429') ||
               msg.includes('too many requests') ||
               msg.includes('rate limit');
    }

    switchToGeminiFallback() {
        if (!this.usingGeminiFallback) {
            this.usingGeminiFallback = true;
            this.lastGeminiQuotaTime = Date.now();

            console.log(`\n${'='.repeat(80)}`);
            console.log(`🔄 GEMINI FALLBACK: ${this.currentGeminiModel} → ${this.fallbackGeminiModel}`);
            console.log(`💡 Quota erschöpft - nutze günstigeres Modell`);
            console.log(`⏰ Reset um 0 Uhr deutsche Zeit`);
            console.log(`${'='.repeat(80)}\n`);
        }
    }

    isComplexQuery(message) {
        const complexIndicators = [
            /erkläre.*wie/i,
            /warum.*funktioniert/i,
            /unterschied zwischen/i,
            /vergleiche/i,
            /analysiere/i,
            /beweise/i,

            /schreibe.*aufsatz/i,
            /schreibe.*essay/i,
            /interpretation/i,
            /zusammenfassung.*buch/i,
            /charakterisierung/i,

            /integral/i,
            /ableitung/i,
            /chemische.*reaktion/i,
            /stöchiometrie/i,

            /aktuelle.*informationen/i,
            /neueste/i,
            /heute/i,
            /2024|2025/i,
            /ereignisse/i,
            /nachrichten/i,

            message.length > 400,

            (message.match(/\?/g) || []).length > 2
        ];

        return complexIndicators.some(indicator =>
            typeof indicator === 'boolean' ? indicator : indicator.test(message)
        );
    }

    async searchWeb(query) {
        if (!this.tavilyKey) {
            console.log('⚠️ Tavily API Key fehlt - überspringe Web-Suche');
            return null;
        }

        try {
            this.stats.webSearches++;

            const response = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    api_key: this.tavilyKey,
                    query: query,
                    search_depth: 'basic',
                    max_results: 5
                })
            });

            if (!response.ok) throw new Error(`Tavily: ${response.status}`);

            const data = await response.json();
            console.log(`🌐 Web-Suche erfolgreich: ${data.results?.length || 0} Ergebnisse`);

            return data.results?.map(r => ({
                title: r.title,
                content: r.content,
                url: r.url
            })) || [];

        } catch (error) {
            console.error('❌ Tavily Fehler:', error.message);
            return null;
        }
    }

    addHistoryToPrompt(history, isSchoolTopic) {
        if (!history || history.length === 0) return '';

        // ✅ Verwende IMMER die letzten 50 Nachrichten
        const relevantHistory = history.slice(-50);

        let historyText = 'Bisheriges Gespräch:\n';
        relevantHistory.forEach(msg => {
            historyText += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
        });
        historyText += '\n---\n\n';
        return historyText;
    }

    async generateWithDeepSeek(prompt, webContext = null, history = [], ocrText = null, isSchoolTopic = false) {
        if (!this.openRouterKey) {
            throw new Error('OpenRouter API Key fehlt');
        }

        try {
            let enhancedPrompt = '';

            // ✅ Historie IMMER hinzufügen (letzte 50 Nachrichten)
            if (history.length > 0) {
                enhancedPrompt += this.addHistoryToPrompt(history, isSchoolTopic);
            }

            if (webContext) {
                enhancedPrompt += `Kontext aus Web-Recherche:\n${JSON.stringify(webContext, null, 2)}\n\n`;
            }

            if (ocrText) {
                enhancedPrompt += `[Bild-Kontext - OCR extrahierter Text]:\n${ocrText}\n\n`;
            }

            // ✅ MULTI-AI PROMPTS (strukturiert & ausführlich)
            if (isSchoolTopic) {
                enhancedPrompt += `Du bist eine hilfsbereite KI-Assistentin für Hausaufgaben.

WICHTIG - Antworte IMMER strukturiert und ausführlich:
- Nutze Überschriften mit ** (z.B. **Übersetzung des Textes**)
- Nummeriere Zeilen mit > (z.B. > Zeile 1)
- Erkläre Schritt für Schritt
- Gib bei Übersetzungen jede Zeile einzeln an
- Füge Erklärungen zu wichtigen Wörtern hinzu mit ➡️ (z.B. ➡️ **Wort** (Erklärung))
- Nutze Emojis zur Visualisierung
- Sei vollständig und genau

Frage: ${prompt}`;
            } else {
                enhancedPrompt += `Du bist eine freundliche KI-Assistentin.

WICHTIG - Antworte strukturiert:
- Nutze Überschriften mit **
- Nutze Aufzählungen mit >
- Sei vollständig und klar
- Nutze Emojis wo sinnvoll

Frage: ${prompt}`;
            }

            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.openRouterKey}`,
                    'HTTP-Referer': 'https://whatsapp-bot.local',
                },
                body: JSON.stringify({
                    model: 'deepseek/deepseek-r1:free',
                    messages: [{ role: 'user', content: enhancedPrompt }],
                    max_tokens: 4000
                })
            });

            if (!response.ok) {
                return await this.generateWithDeepSeekFallback(prompt, webContext, history, ocrText, isSchoolTopic);
            }

            const data = await response.json();
            return {
                model: 'DeepSeek R1',
                response: data.choices[0].message.content,
                reasoning: true
            };

        } catch (error) {
            console.error('❌ DeepSeek R1 Fehler:', error.message);
            return await this.generateWithDeepSeekFallback(prompt, webContext, history, ocrText, isSchoolTopic);
        }
    }

    async generateWithDeepSeekFallback(prompt, webContext, history, ocrText = null, isSchoolTopic = false) {
        try {
            console.log('🔄 Fallback zu DeepSeek R1 Distill Llama 70B');

            let enhancedPrompt = '';
            if (history.length > 0) {
                enhancedPrompt += this.addHistoryToPrompt(history, isSchoolTopic);
            }
            if (webContext) {
                enhancedPrompt += `Kontext: ${JSON.stringify(webContext)}\n\n`;
            }
            if (ocrText) {
                enhancedPrompt += `[Bild-Kontext - OCR Text]:\n${ocrText}\n\n`;
            }

            // ✅ MULTI-AI PROMPTS (strukturiert & ausführlich)
            if (isSchoolTopic) {
                enhancedPrompt += `Du bist eine hilfsbereite KI-Assistentin für Hausaufgaben.

WICHTIG - Antworte IMMER strukturiert und ausführlich:
- Nutze Überschriften mit ** (z.B. **Übersetzung des Textes**)
- Nummeriere Zeilen mit > (z.B. > Zeile 1)
- Erkläre Schritt für Schritt
- Gib bei Übersetzungen jede Zeile einzeln an
- Füge Erklärungen zu wichtigen Wörtern hinzu mit ➡️ (z.B. ➡️ **Wort** (Erklärung))
- Nutze Emojis zur Visualisierung
- Sei vollständig und genau

Frage: ${prompt}`;
            } else {
                enhancedPrompt += `Du bist eine freundliche KI-Assistentin.

WICHTIG - Antworte strukturiert:
- Nutze Überschriften mit **
- Nutze Aufzählungen mit >
- Sei vollständig und klar
- Nutze Emojis wo sinnvoll

Frage: ${prompt}`;
            }

            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.openRouterKey}`,
                },
                body: JSON.stringify({
                    model: 'deepseek/deepseek-r1-distill-llama-70b:free',
                    messages: [{ role: 'user', content: enhancedPrompt }],
                    max_tokens: 3000
                })
            });

            const data = await response.json();
            return {
                model: 'DeepSeek R1 Distill',
                response: data.choices[0].message.content,
                reasoning: false
            };

        } catch (error) {
            console.error('❌ DeepSeek Fallback Fehler:', error.message);
            throw error;
        }
    }

    async generateWithLlama4Scout(prompt, webContext = null, history = [], ocrText = null, isSchoolTopic = false) {
        try {
            let enhancedPrompt = '';

            // ✅ Historie IMMER hinzufügen
            if (history.length > 0) {
                enhancedPrompt += this.addHistoryToPrompt(history, isSchoolTopic);
            }

            if (webContext) {
                enhancedPrompt += `Web-Kontext: ${JSON.stringify(webContext)}\n\n`;
            }

            if (ocrText) {
                enhancedPrompt += `[Bild-Kontext - OCR extrahierter Text]:\n${ocrText}\n\n`;
            }

            // ✅ MULTI-AI PROMPTS (strukturiert & ausführlich)
            if (isSchoolTopic) {
                enhancedPrompt += `Du bist eine hilfsbereite KI-Assistentin für Hausaufgaben.

WICHTIG - Antworte IMMER strukturiert und ausführlich:
- Nutze Überschriften mit ** (z.B. **Übersetzung des Textes**)
- Nummeriere Zeilen mit > (z.B. > Zeile 1)
- Erkläre Schritt für Schritt
- Gib bei Übersetzungen jede Zeile einzeln an
- Füge Erklärungen zu wichtigen Wörtern hinzu mit ➡️ (z.B. ➡️ **Wort** (Erklärung))
- Nutze Emojis zur Visualisierung
- Sei vollständig und genau

Frage: ${prompt}`;
            } else {
                enhancedPrompt += `Du bist eine freundliche KI-Assistentin.

WICHTIG - Antworte strukturiert:
- Nutze Überschriften mit **
- Nutze Aufzählungen mit >
- Sei vollständig und klar
- Nutze Emojis wo sinnvoll

Frage: ${prompt}`;
            }

            const completion = await this.groq.chat.completions.create({
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                messages: [{ role: 'user', content: enhancedPrompt }],
                max_tokens: 4000,
                temperature: 0.7
            });

            return {
                model: 'Llama 4 Scout',
                response: completion.choices[0].message.content,
                reasoning: false
            };

        } catch (error) {
            console.error('❌ Llama 4 Scout Fehler:', error.message);
            return await this.generateWithLlama33Fallback(prompt, webContext, history, ocrText, isSchoolTopic);
        }
    }

    async generateWithLlama33Fallback(prompt, webContext, history, ocrText = null, isSchoolTopic = false) {
        try {
            console.log('🔄 Fallback zu Llama 3.3 70B');

            let enhancedPrompt = '';
            if (history.length > 0) {
                enhancedPrompt += this.addHistoryToPrompt(history, isSchoolTopic);
            }
            if (webContext) {
                enhancedPrompt += `Kontext: ${JSON.stringify(webContext)}\n\n`;
            }
            if (ocrText) {
                enhancedPrompt += `[Bild-Kontext - OCR Text]:\n${ocrText}\n\n`;
            }

            // ✅ MULTI-AI PROMPTS (strukturiert & ausführlich)
            if (isSchoolTopic) {
                enhancedPrompt += `Du bist eine hilfsbereite KI-Assistentin für Hausaufgaben.

WICHTIG - Antworte IMMER strukturiert und ausführlich:
- Nutze Überschriften mit ** (z.B. **Übersetzung des Textes**)
- Nummeriere Zeilen mit > (z.B. > Zeile 1)
- Erkläre Schritt für Schritt
- Gib bei Übersetzungen jede Zeile einzeln an
- Füge Erklärungen zu wichtigen Wörtern hinzu mit ➡️ (z.B. ➡️ **Wort** (Erklärung))
- Nutze Emojis zur Visualisierung
- Sei vollständig und genau

Frage: ${prompt}`;
            } else {
                enhancedPrompt += `Du bist eine freundliche KI-Assistentin.

WICHTIG - Antworte strukturiert:
- Nutze Überschriften mit **
- Nutze Aufzählungen mit >
- Sei vollständig und klar
- Nutze Emojis wo sinnvoll

Frage: ${prompt}`;
            }

            const completion = await this.groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: enhancedPrompt }],
                max_tokens: 3000,
                temperature: 0.7
            });

            return {
                model: 'Llama 3.3 70B (Fallback)',
                response: completion.choices[0].message.content,
                reasoning: false
            };

        } catch (error) {
            console.error('❌ Llama Fallback Fehler:', error.message);
            throw error;
        }
    }

    async generateWithGemini(prompt, webContext = null, imageBuffer = null, history = [], isSchoolTopic = false, isMultiAI = false) {
        await this.checkGeminiQuotaReset();

        try {
            const apiKey = this.geminiKeys[this.currentGeminiIndex];
            this.currentGeminiIndex = (this.currentGeminiIndex + 1) % this.geminiKeys.length;

            const genAI = new GoogleGenerativeAI(apiKey);

            const activeModel = this.usingGeminiFallback
                ? this.fallbackGeminiModel
                : this.currentGeminiModel;

            const model = genAI.getGenerativeModel({ model: activeModel });

            let enhancedPrompt = '';

            // ✅ Historie IMMER hinzufügen
            if (history.length > 0) {
                enhancedPrompt += this.addHistoryToPrompt(history, isSchoolTopic);
            }

            if (webContext) {
                enhancedPrompt += `Web-Recherche:\n${JSON.stringify(webContext)}\n\n`;
            }

            // ✅ MULTI-AI: Strukturiert & ausführlich
            // ✅ SIMPLE MODE: Kurz & knapp
            if (isMultiAI) {
                // MULTI-AI PROMPTS (strukturiert)
                if (isSchoolTopic) {
                    enhancedPrompt += `Du bist eine hilfsbereite KI-Assistentin für Hausaufgaben.

WICHTIG - Antworte IMMER strukturiert und ausführlich:
- Nutze Überschriften mit ** (z.B. **Übersetzung des Textes**)
- Nummeriere Zeilen mit > (z.B. > Zeile 1)
- Erkläre Schritt für Schritt
- Gib bei Übersetzungen jede Zeile einzeln an
- Füge Erklärungen zu wichtigen Wörtern hinzu mit ➡️ (z.B. ➡️ **Wort** (Erklärung))
- Nutze Emojis zur Visualisierung
- Sei vollständig und genau

Frage: ${prompt}`;
                } else {
                    enhancedPrompt += `Du bist eine freundliche KI-Assistentin.

WICHTIG - Antworte strukturiert:
- Nutze Überschriften mit **
- Nutze Aufzählungen mit >
- Sei vollständig und klar
- Nutze Emojis wo sinnvoll

Frage: ${prompt}`;
                }
            } else {
                // SIMPLE MODE PROMPTS (kurz & knapp)
                if (isSchoolTopic) {
                    enhancedPrompt += `Du bist eine hilfsbereite KI-Assistentin. Hilf bei Hausaufgaben, erkläre Schritt für Schritt, aber sei kurz und präzise. Nutze Emojis wo passend.\n\nFrage: ${prompt}`;
                } else {
                    enhancedPrompt += `Du bist eine freundliche KI-Assistentin. Antworte kurz, natürlich und hilfreich.\n\nFrage: ${prompt}`;
                }
            }

            let result;
            if (imageBuffer) {
                const base64Image = imageBuffer.toString('base64');
                result = await model.generateContent([
                    enhancedPrompt,
                    { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }
                ]);
            } else {
                result = await model.generateContent(enhancedPrompt);
            }

            return {
                model: `Gemini ${activeModel}`,
                response: result.response.text(),
                reasoning: false
            };

        } catch (error) {
            console.error('❌ Gemini Fehler:', error.message);

            if (this.isQuotaError(error)) {
                this.geminiQuotaExceeded++;

                if (!this.usingGeminiFallback) {
                    this.switchToGeminiFallback();
                    return await this.generateWithGemini(prompt, webContext, imageBuffer, history, isSchoolTopic, isMultiAI);
                }
            }

            return await this.generateWithGeminiLite(prompt, webContext, imageBuffer, history, isSchoolTopic, isMultiAI);
        }
    }

    async generateWithGeminiLite(prompt, webContext, imageBuffer, history, isSchoolTopic = false, isMultiAI = false) {
        try {
            console.log('🔄 Fallback zu Gemini 2.5 Flash Lite');

            const apiKey = this.geminiKeys[this.currentGeminiIndex];
            this.currentGeminiIndex = (this.currentGeminiIndex + 1) % this.geminiKeys.length;

            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

            let enhancedPrompt = '';
            if (history.length > 0) {
                enhancedPrompt += this.addHistoryToPrompt(history, isSchoolTopic);
            }
            if (webContext) {
                enhancedPrompt += `Kontext: ${JSON.stringify(webContext)}\n\n`;
            }

            // ✅ MULTI-AI vs SIMPLE MODE
            if (isMultiAI) {
                // MULTI-AI PROMPTS (strukturiert)
                if (isSchoolTopic) {
                    enhancedPrompt += `Du bist eine hilfsbereite KI-Assistentin für Hausaufgaben.

WICHTIG - Antworte IMMER strukturiert und ausführlich:
- Nutze Überschriften mit ** (z.B. **Übersetzung des Textes**)
- Nummeriere Zeilen mit > (z.B. > Zeile 1)
- Erkläre Schritt für Schritt
- Gib bei Übersetzungen jede Zeile einzeln an
- Füge Erklärungen zu wichtigen Wörtern hinzu mit ➡️ (z.B. ➡️ **Wort** (Erklärung))
- Nutze Emojis zur Visualisierung
- Sei vollständig und genau

Frage: ${prompt}`;
                } else {
                    enhancedPrompt += `Du bist eine freundliche KI-Assistentin.

WICHTIG - Antworte strukturiert:
- Nutze Überschriften mit **
- Nutze Aufzählungen mit >
- Sei vollständig und klar
- Nutze Emojis wo sinnvoll

Frage: ${prompt}`;
                }
            } else {
                // SIMPLE MODE PROMPTS (kurz & knapp)
                if (isSchoolTopic) {
                    enhancedPrompt += `Du bist eine hilfsbereite KI-Assistentin. Hilf bei Hausaufgaben, erkläre Schritt für Schritt, aber sei kurz und präzise. Nutze Emojis wo passend.\n\nFrage: ${prompt}`;
                } else {
                    enhancedPrompt += `Du bist eine freundliche KI-Assistentin. Antworte kurz, natürlich und hilfreich.\n\nFrage: ${prompt}`;
                }
            }

            let result;
            if (imageBuffer) {
                const base64Image = imageBuffer.toString('base64');
                result = await model.generateContent([
                    enhancedPrompt,
                    { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }
                ]);
            } else {
                result = await model.generateContent(enhancedPrompt);
            }

            return {
                model: 'Gemini Flash Lite (Fallback)',
                response: result.response.text(),
                reasoning: false
            };

        } catch (error) {
            console.error('❌ Gemini Fallback Fehler:', error.message);
            throw error;
        }
    }

cleanJsonResponse(text) {
    let cleaned = text;
    cleaned = cleaned.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, ''); // ✅ NEU: Entfernt <think> Tags
    cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, ''); // ✅ KORRIGIERT: </tool_call> statt </think>
    cleaned = cleaned.trim();
    return cleaned;
}

    async validateWithLlama70B(originalQuestion, responses) {
        try {
            const validationPrompt = `Du bist ein Validator. Bewerte diese ${responses.length} Antworten auf die Frage: "${originalQuestion}"

${responses.map((r, i) => `
ANTWORT ${i + 1} (${r.model}):
${r.response}
`).join('\n---\n')}

Bewerte jede Antwort mit einem Score von 0-100 basierend auf:
- Korrektheit & Präzision
- Vollständigkeit
- Klarheit & Verständlichkeit
- Relevanz zur Frage

Antworte NUR im JSON-Format (OHNE Markdown-Tags, OHNE Thinking-Tags):
{
  "scores": [score1, score2, score3],
  "best_index": 0,
  "reasoning": "kurze Begründung"
}`;

            const completion = await this.groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: validationPrompt }],
                max_tokens: 1000,
                temperature: 0.3
            });

            const jsonText = this.cleanJsonResponse(completion.choices[0].message.content);
            const result = JSON.parse(jsonText);

            console.log('✅ Validator 1 (Llama 70B):', result);
            return result;

        } catch (error) {
            console.error('❌ Validator 1 Fehler:', error.message);
            return {
                scores: responses.map(() => 50),
                best_index: 0,
                reasoning: 'Validation failed - using fallback'
            };
        }
    }

    async validateWithQwen(originalQuestion, responses) {
        try {
            const validationPrompt = `Als Qualitäts-Validator: Bewerte diese Antworten zur Frage: "${originalQuestion}"

${responses.map((r, i) => `[${i + 1}] ${r.model}: ${r.response.substring(0, 500)}...`).join('\n\n')}

Score jede Antwort (0-100) nach Qualität, Korrektheit, Präzision.

Antworte als JSON (OHNE Markdown, OHNE Thinking-Tags):
{
  "scores": [score1, score2, score3],
  "best_index": 0,
  "comment": "Begründung"
}`;

            const completion = await this.groq.chat.completions.create({
                model: 'qwen/qwen3-32b',
                messages: [{ role: 'user', content: validationPrompt }],
                max_tokens: 800,
                temperature: 0.3
            });

            const jsonText = this.cleanJsonResponse(completion.choices[0].message.content);
            const result = JSON.parse(jsonText);

            console.log('✅ Validator 2 (Qwen 32B):', result);
            return result;

        } catch (error) {
            console.error('❌ Validator 2 Fehler:', error.message);
            return {
                scores: responses.map(() => 50),
                best_index: 0,
                comment: 'Validation failed'
            };
        }
    }

    async synthesizeBestAnswer(originalQuestion, responses, validations) {
        try {
            // ✅ VERBESSERT: Berechne Durchschnitts-Scores präziser
            const avgScores = responses.map((_, i) => {
                const scores = validations.map(v => v.scores[i] || 50);
                return scores.reduce((a, b) => a + b, 0) / scores.length;
            });

            const bestIndex = avgScores.indexOf(Math.max(...avgScores));
            const bestScore = avgScores[bestIndex];
            const secondBestScore = avgScores.filter((_, i) => i !== bestIndex).sort((a, b) => b - a)[0] || 0;
            const scoreDifference = bestScore - secondBestScore;

            console.log('📊 Durchschnitts-Scores:', avgScores.map((s, i) => `${responses[i].model}: ${s.toFixed(1)}`));
            console.log(`🏆 Beste Antwort: ${responses[bestIndex].model} (${bestScore.toFixed(1)}), Unterschied: ${scoreDifference.toFixed(1)}`);

            // ✅ VERBESSERT: Klare Entscheidung wenn Score deutlich besser ist (>10 Punkte Unterschied)
            if (scoreDifference > 10) {
                console.log(`✅ Klare beste Antwort - nutze ${responses[bestIndex].model} direkt`);
                return responses[bestIndex].response;
            }

            // ✅ Wenn Scores sehr nah beieinander (< 10 Punkte), mixe intelligent
            console.log('🔀 Scores ähnlich - mixe intelligente finale Antwort...');

            const synthesisPrompt = `Du bist ein Synthesizer. Erstelle die BESTE und KORREKTESTE Antwort auf: "${originalQuestion}"

Du hast ${responses.length} verschiedene Antworten:

${responses.map((r, i) => `
[${i + 1}] ${r.model} (Score: ${avgScores[i].toFixed(1)}):
${r.response}
`).join('\n---\n')}

DEINE AUFGABE:
1. Analysiere ALLE Antworten auf Korrektheit
2. Finde die faktisch richtigste Information
3. Nimm NUR die besten und korrektesten Teile
4. Kombiniere sie zu EINER perfekten Antwort
5. Entferne Fehler, Widersprüche und Ungenauigkeiten
6. Mach sie klar, präzise und vollständig

FORMATIERUNG (SEHR WICHTIG):
- Nutze Überschriften mit ** (z.B. **Übersetzung des Textes**)
- Nummeriere Zeilen mit > (z.B. > Zeile 1)
- Füge Erklärungen mit ➡️ hinzu (z.B. ➡️ **Wort** (Bedeutung))
- Nutze Emojis zur Visualisierung
- Sei strukturiert und übersichtlich

WICHTIG: Priorisiere KORREKTHEIT über alles andere!

Antworte NUR mit der finalen strukturierten Antwort (kein JSON, keine Meta-Kommentare).`;

            const completion = await this.groq.chat.completions.create({
                model: 'openai/gpt-oss-120b',
                messages: [{ role: 'user', content: synthesisPrompt }],
                max_tokens: 5000,
                temperature: 0.3 // ✅ Niedrigere Temperature = präzisere Antworten
            });

            const finalAnswer = completion.choices[0].message.content;
            console.log('✨ Synthesizer hat optimierte finale Antwort erstellt');
            return finalAnswer;

        } catch (error) {
            console.error('❌ Synthesizer Fehler:', error.message);
            // Fallback: Beste Antwort nach Score
            const avgScores = responses.map((_, i) => {
                const scores = validations.map(v => v.scores[i] || 50);
                return scores.reduce((a, b) => a + b, 0) / scores.length;
            });
            const bestIndex = avgScores.indexOf(Math.max(...avgScores));
            console.log(`🔄 Fallback: Nutze beste Antwort (${responses[bestIndex].model})`);
            return responses[bestIndex].response;
        }
    }

    // ✅ HAUPTFUNKTION mit forceMode Support
    async generateResponse(userMessage, history = [], isSchoolTopic = false, imageBuffer = null, forceMode = null, ocrText = null) {
        this.stats.totalProcessed++;

        let useMultiAI = false;

        if (forceMode === 'simple') {
            useMultiAI = false;
            console.log('⚡ SIMPLE MODE erzwungen - nutze nur Gemini');
        } else if (forceMode === 'multi') {
            useMultiAI = true;
            console.log('🧠 MULTI-AI MODE erzwungen');
        } else {
            const isComplex = this.isComplexQuery(userMessage);
            useMultiAI = isComplex;
        }

        // ✅ IMMER Historie verwenden - letzte 50 Nachrichten
        console.log(`💭 Historie: ${history.length} Nachrichten (nutze letzte 50)`);

        if (!useMultiAI) {
            console.log('💬 Einfache Verarbeitung → Nutze nur Gemini (schnell & kurz)');
            this.stats.simpleQueries++;

            try {
                const result = await this.generateWithGemini(userMessage, null, imageBuffer, history, isSchoolTopic, false); // isMultiAI = false
                return result.response;
            } catch (error) {
                console.error('❌ Gemini Fehler:', error.message);
                return '⚠️ Ein Fehler ist aufgetreten. Versuche es nochmal.';
            }
        }

        console.log('\n' + '='.repeat(80));
        console.log('🧠 MULTI-KI-SYSTEM AKTIVIERT!');
        console.log('='.repeat(80));
        this.stats.complexQueries++;

        try {
            let webContext = null;
            const needsWebSearch = /aktuelle|neueste|heute|2024|2025|nachrichten|ereignisse/i.test(userMessage);

            if (needsWebSearch && this.tavilyKey) {
                console.log('🌐 Starte Web-Recherche...');
                webContext = await this.searchWeb(userMessage);
            }

            console.log('🤖 Starte 3 Generator-KIs parallel...');

            if (ocrText) {
                console.log('📝 OCR-Text wird an DeepSeek & Llama gesendet (Text-only KIs)');
                console.log('🖼️ Bild wird direkt an Gemini gesendet (Vision-fähig)');
            }

            const [deepSeekResult, llamaResult, geminiResult] = await Promise.allSettled([
                this.generateWithDeepSeek(userMessage, webContext, history, ocrText, isSchoolTopic),
                this.generateWithLlama4Scout(userMessage, webContext, history, ocrText, isSchoolTopic),
                this.generateWithGemini(userMessage, webContext, imageBuffer, history, isSchoolTopic, true) // isMultiAI = true
            ]);

            const responses = [
                deepSeekResult.status === 'fulfilled' ? deepSeekResult.value : null,
                llamaResult.status === 'fulfilled' ? llamaResult.value : null,
                geminiResult.status === 'fulfilled' ? geminiResult.value : null
            ].filter(r => r !== null);

            if (responses.length === 0) {
                throw new Error('Alle Generator-KIs fehlgeschlagen');
            }

            console.log(`✅ ${responses.length} Antworten generiert`);
            responses.forEach(r => console.log(`   - ${r.model}`));

            console.log('🔍 Starte 2 Validator-KIs parallel...');

            const [validation1, validation2] = await Promise.allSettled([
                this.validateWithLlama70B(userMessage, responses),
                this.validateWithQwen(userMessage, responses)
            ]);

            const validations = [
                validation1.status === 'fulfilled' ? validation1.value : null,
                validation2.status === 'fulfilled' ? validation2.value : null
            ].filter(v => v !== null);

            console.log(`✅ ${validations.length} Validierungen abgeschlossen`);

            console.log('🧪 Synthesizer wählt beste/korrekteste Antwort...');
            const finalAnswer = await this.synthesizeBestAnswer(userMessage, responses, validations);

            console.log('✨ Multi-KI-Prozess abgeschlossen!');
            console.log('='.repeat(80) + '\n');

            return finalAnswer;

        } catch (error) {
            console.error('❌ Multi-KI Fehler:', error.message);
            console.log('🔄 Fallback zu einfachem Gemini (kurz)...');

            try {
                const result = await this.generateWithGemini(userMessage, null, imageBuffer, history, isSchoolTopic, false); // isMultiAI = false (kurz)
                return result.response;
            } catch (fallbackError) {
                return '⚠️ Ein Fehler ist aufgetreten. Bitte versuche es nochmal.';
            }
        }
    }

    getStats() {
        return {
            ...this.stats,
            complexityRate: this.stats.totalProcessed > 0
                ? (this.stats.complexQueries / this.stats.totalProcessed * 100).toFixed(1) + '%'
                : '0%',
            geminiModel: this.usingGeminiFallback ? this.fallbackGeminiModel : this.currentGeminiModel,
            geminiQuotaExceeded: this.geminiQuotaExceeded
        };
    }
}
