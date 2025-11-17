export class ConversationManager {
    constructor() {
        this.conversations = new Map();
        this.maxMessages = 50;

        this.stats = {
            totalMessagesSent: 0,
            totalMessagesReceived: 0,
            totalMegaRequests: 0,
            totalOCRProcessed: 0,
            totalSimpleForced: 0, // ✅ NEU: Tracker für . Präfix
            totalMultiForced: 0,  // ✅ NEU: Tracker für / Präfix
            startTime: Date.now()
        };
    }

    addMessage(chatId, role, content) {
        if (!this.conversations.has(chatId)) {
            this.conversations.set(chatId, []);
        }

        const messages = this.conversations.get(chatId);

        messages.push({
            role: role,
            content: content,
            timestamp: Date.now()
        });

        if (role === 'user') {
            this.stats.totalMessagesReceived++;
        } else {
            this.stats.totalMessagesSent++;
        }

        if (messages.length > this.maxMessages) {
            messages.shift();
        }

        console.log(`💾 Nachricht gespeichert für ${chatId} (${messages.length} total)`);
    }

    incrementMegaRequests() {
        this.stats.totalMegaRequests++;
    }

    incrementOCRProcessed() {
        this.stats.totalOCRProcessed++;
    }

    // ✅ NEU: Tracker für Simple Mode (.)
    incrementSimpleForced() {
        this.stats.totalSimpleForced++;
    }

    // ✅ NEU: Tracker für Multi-AI Mode (/)
    incrementMultiForced() {
        this.stats.totalMultiForced++;
    }

    getHistory(chatId, limit = 10) {
        const messages = this.conversations.get(chatId) || [];
        return messages.slice(-limit);
    }

    clearChat(chatId) {
        this.conversations.delete(chatId);
        console.log(`🧹 Chat-Historie gelöscht für ${chatId}`);
    }

    getAllChats() {
        return Array.from(this.conversations.keys());
    }

    getStats() {
        const uptimeSeconds = Math.floor((Date.now() - this.stats.startTime) / 1000);

        return {
            totalChats: this.conversations.size,
            totalMessages: Array.from(this.conversations.values())
                .reduce((sum, msgs) => sum + msgs.length, 0),
            messagesSent: this.stats.totalMessagesSent,
            messagesReceived: this.stats.totalMessagesReceived,
            megaRequests: this.stats.totalMegaRequests,
            ocrProcessed: this.stats.totalOCRProcessed,
            simpleForced: this.stats.totalSimpleForced, // ✅ NEU
            multiForced: this.stats.totalMultiForced,   // ✅ NEU
            uptimeSeconds: uptimeSeconds,
            uptimeFormatted: this.formatUptime(uptimeSeconds)
        };
    }

    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;

        if (days > 0) return `${days}d ${hours}h ${minutes}m`;
        if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
        if (minutes > 0) return `${minutes}m ${secs}s`;
        return `${secs}s`;
    }

    cleanup() {
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        let cleaned = 0;

        for (const [chatId, messages] of this.conversations.entries()) {
            if (messages.length > 0 && messages[messages.length - 1].timestamp < sevenDaysAgo) {
                this.conversations.delete(chatId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`🧹 Cleanup: ${cleaned} alte Konversationen gelöscht`);
        }
    }
}
