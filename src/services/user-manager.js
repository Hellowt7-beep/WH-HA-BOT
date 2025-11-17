import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class UserManager {
    constructor() {
        this.usersFile = path.join(__dirname, '../data/users.json');
        this.users = {};
        this.adminUser = {
            username: 'Admin',
            password: 'Hallo%',
            role: 'admin',
            createdAt: Date.now()
        };
        this.loadUsers();
    }

    loadUsers() {
        try {
            const dataDir = path.join(__dirname, '../data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            if (fs.existsSync(this.usersFile)) {
                const data = fs.readFileSync(this.usersFile, 'utf8');
                this.users = JSON.parse(data);
                console.log(`✅ ${Object.keys(this.users).length} Benutzer geladen`);
            } else {
                this.users = {};
                this.saveUsers();
                console.log('✅ Neue Benutzerdatenbank erstellt');
            }
        } catch (error) {
            console.error('❌ Fehler beim Laden der Benutzer:', error);
            this.users = {};
        }
    }

    saveUsers() {
        try {
            fs.writeFileSync(this.usersFile, JSON.stringify(this.users, null, 2));
        } catch (error) {
            console.error('❌ Fehler beim Speichern der Benutzer:', error);
        }
    }

    // Admin Login
    loginAdmin(username, password) {
        if (username === this.adminUser.username && password === this.adminUser.password) {
            return {
                success: true,
                user: {
                    username: this.adminUser.username,
                    role: 'admin'
                }
            };
        }
        return { success: false, message: 'Ungültige Admin-Anmeldedaten' };
    }

    // User Login
    loginUser(username, password) {
        const user = Object.values(this.users).find(u => u.username === username);

        if (!user) {
            return { success: false, message: 'Benutzer nicht gefunden' };
        }

        if (user.password !== password) {
            return { success: false, message: 'Falsches Passwort' };
        }

        return {
            success: true,
            user: {
                username: user.username,
                phone: user.phone,
                role: 'user',
                settings: user.settings
            }
        };
    }

    // Admin: Create User
    createUser(username, password, phone, createdBy = 'admin') {
        // Validate phone number
        if (!phone.startsWith('+49')) {
            return { success: false, message: 'Telefonnummer muss mit +49 beginnen' };
        }

        // Check if user exists
        if (this.users[phone]) {
            return { success: false, message: 'Benutzer mit dieser Telefonnummer existiert bereits' };
        }

        // Check if username is taken
        const existingUser = Object.values(this.users).find(u => u.username === username);
        if (existingUser) {
            return { success: false, message: 'Benutzername bereits vergeben' };
        }

        // Default settings
        const defaultSettings = {
            customPrompt: null, // null = use default
            spamLimit: 500,
            reactOnCommand: false, // false = react to all messages, true = only on command
            commandPrefix: '!',
            enableMultiAI: true,
            enableOCR: true,
            enableMega: true
        };

        this.users[phone] = {
            username,
            password,
            phone,
            role: 'user',
            settings: defaultSettings,
            createdAt: Date.now(),
            createdBy
        };

        this.saveUsers();

        console.log(`✅ Benutzer erstellt: ${username} (${phone})`);

        return {
            success: true,
            message: 'Benutzer erfolgreich erstellt',
            user: this.users[phone]
        };
    }

    // Admin: Delete User
    deleteUser(phone) {
        if (!this.users[phone]) {
            return { success: false, message: 'Benutzer nicht gefunden' };
        }

        const username = this.users[phone].username;
        delete this.users[phone];
        this.saveUsers();

        console.log(`✅ Benutzer gelöscht: ${username} (${phone})`);

        return { success: true, message: 'Benutzer erfolgreich gelöscht' };
    }

    // Admin: Update User Password
    updateUserPassword(phone, newPassword) {
        if (!this.users[phone]) {
            return { success: false, message: 'Benutzer nicht gefunden' };
        }

        this.users[phone].password = newPassword;
        this.saveUsers();

        return { success: true, message: 'Passwort erfolgreich geändert' };
    }

    // User: Update Own Settings
    updateUserSettings(phone, settings) {
        if (!this.users[phone]) {
            return { success: false, message: 'Benutzer nicht gefunden' };
        }

        this.users[phone].settings = {
            ...this.users[phone].settings,
            ...settings
        };

        this.saveUsers();

        console.log(`✅ Einstellungen aktualisiert für ${this.users[phone].username}`);

        return {
            success: true,
            message: 'Einstellungen erfolgreich gespeichert',
            settings: this.users[phone].settings
        };
    }

    // Reset Custom Prompt to Default
    resetPrompt(phone) {
        if (!this.users[phone]) {
            return { success: false, message: 'Benutzer nicht gefunden' };
        }

        this.users[phone].settings.customPrompt = null;
        this.saveUsers();

        console.log(`✅ Prompt zurückgesetzt für ${this.users[phone].username}`);

        return { success: true, message: 'Prompt erfolgreich zurückgesetzt' };
    }

    // Get User by Phone
    getUserByPhone(phone) {
        return this.users[phone] || null;
    }

    // Get User Settings
    getUserSettings(phone) {
        const user = this.users[phone];
        if (!user) {
            // Return default settings for unregistered users
            return {
                customPrompt: null,
                spamLimit: 500,
                reactOnCommand: false,
                commandPrefix: '!',
                enableMultiAI: true,
                enableOCR: true,
                enableMega: true
            };
        }
        return user.settings;
    }

    // Get All Users (Admin only)
    getAllUsers() {
        return Object.values(this.users).map(user => ({
            username: user.username,
            phone: user.phone,
            role: user.role,
            settings: user.settings,
            createdAt: user.createdAt,
            createdBy: user.createdBy
        }));
    }

    // Get Default Prompts
    getDefaultPrompts() {
        return {
            school: 'Du bist eine hilfsbereite KI-Assistentin für Hausaufgaben. Antworte kurz aber vollständig mit allen wichtigen Infos.',
            normal: 'Du bist eine freundliche KI-Assistentin. Antworte kurz aber vollständig.',
            translation: 'Du bist eine Übersetzungs-KI.\n\nWICHTIG - Bei Übersetzungen IMMER strukturiert und ausführlich:\n- Nutze Überschriften mit **\n- Nummeriere jede Zeile mit >\n- Gib JEDE Zeile einzeln an\n- Füge Erklärungen mit ➡️ hinzu\n- Nutze Emojis\n- Sei vollständig und präzise'
        };
    }

    // Stats
    getStats() {
        return {
            totalUsers: Object.keys(this.users).length,
            users: this.getAllUsers()
        };
    }
}
