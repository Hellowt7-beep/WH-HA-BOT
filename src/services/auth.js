import crypto from 'crypto';

export class AuthService {
    constructor() {
        this.sessions = new Map(); // sessionId -> { username, role, phone, createdAt }
        this.sessionTimeout = 24 * 60 * 60 * 1000; // 24 hours

        // Cleanup expired sessions every hour
        setInterval(() => this.cleanupSessions(), 60 * 60 * 1000);
    }

    createSession(username, role, phone = null) {
        const sessionId = crypto.randomBytes(32).toString('hex');

        this.sessions.set(sessionId, {
            username,
            role,
            phone,
            createdAt: Date.now()
        });

        console.log(`✅ Session erstellt für ${username} (${role})`);

        return sessionId;
    }

    validateSession(sessionId) {
        const session = this.sessions.get(sessionId);

        if (!session) {
            return null;
        }

        // Check if session expired
        const age = Date.now() - session.createdAt;
        if (age > this.sessionTimeout) {
            this.sessions.delete(sessionId);
            console.log(`⏰ Session abgelaufen für ${session.username}`);
            return null;
        }

        return session;
    }

    destroySession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            console.log(`🚪 Session beendet für ${session.username}`);
            this.sessions.delete(sessionId);
            return true;
        }
        return false;
    }

    cleanupSessions() {
        const now = Date.now();
        let cleaned = 0;

        for (const [sessionId, session] of this.sessions.entries()) {
            const age = now - session.createdAt;
            if (age > this.sessionTimeout) {
                this.sessions.delete(sessionId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`🧹 ${cleaned} abgelaufene Sessions gelöscht`);
        }
    }

    getActiveSessions() {
        return this.sessions.size;
    }
}
