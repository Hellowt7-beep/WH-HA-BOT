import fetch from 'node-fetch';
import sharp from 'sharp';
import dotenv from 'dotenv';

dotenv.config();

export class OCRService {
    async performOCR(imageBuffer) {
        try {
            const optimizedBuffer = await this.optimizeImage(imageBuffer);

            try {
                return await this.ocrSpace(optimizedBuffer);
            } catch (error) {
                console.log('⚠️ OCR.space fehlgeschlagen:', error.message);
            }

            try {
                return await this.tesseractOCR(optimizedBuffer);
            } catch (error) {
                console.log('⚠️ Tesseract fehlgeschlagen:', error.message);
            }

            return this.mockOCR();

        } catch (error) {
            console.error('❌ OCR komplett fehlgeschlagen:', error);
            return '';
        }
    }

    async optimizeImage(imageBuffer) {
        try {
            const optimized = await sharp(imageBuffer)
                .resize(2000, 2000, {
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .greyscale()
                .normalize()
                .sharpen()
                .jpeg({ quality: 90 })
                .toBuffer();

            return optimized;
        } catch (error) {
            console.log('⚠️ Bildoptimierung fehlgeschlagen:', error.message);
            return imageBuffer;
        }
    }

    async ocrSpace(imageBuffer) {
        const apiKeys = ['helloworld', 'K87899142388957'];
        const base64Image = imageBuffer.toString('base64');

        for (const apiKey of apiKeys) {
            try {
                const formData = new URLSearchParams();
                formData.append('apikey', apiKey);
                formData.append('base64Image', `data:image/jpeg;base64,${base64Image}`);
                formData.append('language', 'ger');
                formData.append('isOverlayRequired', 'false');
                formData.append('detectOrientation', 'true');
                formData.append('scale', 'true');
                formData.append('OCREngine', '1');

                const response = await fetch('https://api.ocr.space/parse/image', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: formData,
                    timeout: 45000
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const result = await response.json();

                if (result.OCRExitCode === 1 && result.ParsedResults?.[0]) {
                    const text = result.ParsedResults[0].ParsedText;
                    console.log('✅ OCR.space erfolgreich');
                    return text;
                }

                throw new Error(result.ErrorMessage || 'Kein Text erkannt');

            } catch (error) {
                console.log(`❌ OCR mit ${apiKey.substring(0, 5)}... fehlgeschlagen`);
                continue;
            }
        }

        throw new Error('Alle OCR.space Versuche fehlgeschlagen');
    }

    async tesseractOCR(imageBuffer) {
        try {
            const Tesseract = await import('tesseract.js');
            const { data: { text } } = await Tesseract.default.recognize(
                imageBuffer,
                'deu+eng',
                {
                    logger: m => {
                        if (m.status === 'recognizing text') {
                            console.log(`🔤 OCR: ${Math.round(m.progress * 100)}%`);
                        }
                    }
                }
            );
            console.log('✅ Tesseract OCR erfolgreich');
            return text;
        } catch (error) {
            throw new Error('Tesseract nicht verfügbar');
        }
    }

    mockOCR() {
        console.log('⚠️ Verwende Mock OCR - für Produktion echten API Key verwenden');
        return `[OCR Mock: Text konnte nicht extrahiert werden. Verwende einen echten OCR API Key für bessere Ergebnisse.]`;
    }
}
