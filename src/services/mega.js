import { Storage } from 'megajs';
import dotenv from 'dotenv';

dotenv.config();

export class MegaService {
    constructor() {
        this.storage = null;
    }

    async connect() {
        if (this.storage) return this.storage;

        try {
            if (!process.env.MEGA_EMAIL || !process.env.MEGA_PASSWORD) {
                throw new Error('MEGA Login-Daten fehlen in .env');
            }

            this.storage = new Storage({
                email: process.env.MEGA_EMAIL,
                password: process.env.MEGA_PASSWORD
            });

            await this.storage.ready;
            console.log('✅ MEGA verbunden');
            return this.storage;

        } catch (error) {
            throw new Error(`MEGA Verbindung fehlgeschlagen: ${error.message}`);
        }
    }

    async findFile(fach, seiteNummer) {
        await this.connect();

        console.log(`🔍 Suche: ${fach} Seite ${seiteNummer}`);

        const files = this.storage.files;
        const fachLower = fach.toLowerCase();
        const seiteStr = seiteNummer.toString();

        const foundFile = Object.values(files).find(file => {
            const name = file.name?.toLowerCase();
            if (!name) return false;

            const nameWithoutExt = name.replace(/\.(jpg|png|jpeg|pdf)$/i, '');

            const patterns = [
                `^${fachLower}_seite_${seiteStr}$`,
                `^${fachLower}_${seiteStr}$`,
                `^${fachLower}seite${seiteStr}$`,
                `^${fachLower}_s${seiteStr}$`,
                `^${fachLower}_page_${seiteStr}$`
            ];

            const isExactMatch = patterns.some(pattern => {
                const regex = new RegExp(pattern, 'i');
                return regex.test(nameWithoutExt);
            });

            if (isExactMatch) {
                console.log(`✅ Datei gefunden: ${name}`);
                return true;
            }

            if (nameWithoutExt.includes(fachLower)) {
                const numbers = nameWithoutExt.match(/\d+/g) || [];
                const hasExactNumber = numbers.includes(seiteStr);
                const hasCorrectPosition =
                    nameWithoutExt.match(new RegExp(`(seite|page|s)_?${seiteStr}(?!\\d)`, 'i')) ||
                    nameWithoutExt.match(new RegExp(`${fachLower}_${seiteStr}(?!\\d)`, 'i'));

                if (hasExactNumber && hasCorrectPosition) {
                    console.log(`✅ Fallback Match: ${name}`);
                    return true;
                }
            }

            return false;
        });

        if (!foundFile) {
            console.log('❌ Verfügbare Dateien für', fach + ':');
            Object.values(files).forEach(file => {
                if (file.name?.toLowerCase().includes(fachLower)) {
                    console.log(`   📄 ${file.name}`);
                }
            });

            throw new Error(`Datei nicht gefunden: ${fach} Seite ${seiteNummer}\n\nErwartete Formate:\n• ${fach}_seite_${seiteNummer}.jpg\n• ${fach}_${seiteNummer}.jpg`);
        }

        return foundFile;
    }
}
