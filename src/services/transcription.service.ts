import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface TranscriptionResult {
    success: boolean;
    text?: string;
    error?: string;
}

/** Ordered list of models to try. First available wins.
 *  Configurable via GEMINI_MODELS env var (comma-separated).
 *  Defaults: gemini-2.5-flash, gemini-3-flash-preview, gemini-2.5-flash-lite
 */
const DEFAULT_GEMINI_MODELS = [
    "gemini-2.5-flash",
    "gemini-3-flash-preview",
    "gemini-2.5-flash-lite",
];

function getGeminiModels(): string[] {
    const env = process.env.GEMINI_MODELS?.trim();
    if (env) {
        return env.split(",").map(m => m.trim()).filter(Boolean);
    }
    return DEFAULT_GEMINI_MODELS;
}

export class TranscriptionService {
    private apiKey: string | null = null;

    constructor() {
        this.apiKey = process.env.GEMINI_API_KEY || null;
    }

    isConfigured(): boolean {
        return this.apiKey !== null;
    }

    async transcribeAudio(audioPath: string): Promise<TranscriptionResult> {
        if (!this.apiKey) {
            return { success: false, error: "GEMINI_API_KEY no configurado" };
        }

        if (!fs.existsSync(audioPath)) {
            return { success: false, error: "Archivo de audio no encontrado" };
        }

        const audioBuffer = fs.readFileSync(audioPath);
        const base64Audio = audioBuffer.toString("base64");
        const mimeType = this.getMimeType(audioPath);

        let lastError = "Sin modelos disponibles";

        for (const model of getGeminiModels()) {
            try {
                console.log(`[Transcription] Trying model ${model}…`);
                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            contents: [{
                                parts: [
                                    { text: "Transcribe el siguiente audio. Responde SOLO con la transcripción, sin comentarios adicionales ni formato." },
                                    {
                                        inline_data: {
                                            mime_type: mimeType,
                                            data: base64Audio
                                        }
                                    }
                                ]
                            }]
                        }),
                        signal: AbortSignal.timeout(120000)
                    }
                );

                if (response.status === 503 || response.status === 429) {
                    const errorText = await response.text();
                    lastError = `${model}: HTTP ${response.status} (saturado, probando siguiente)`;
                    console.warn(`[Transcription] ${lastError}`);
                    continue; // try next model
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    lastError = `${model}: HTTP ${response.status} - ${errorText}`;
                    console.warn(`[Transcription] ${lastError}`);
                    continue;
                }

                const data: any = await response.json();
                const transcription = data?.candidates?.[0]?.content?.parts?.[0]?.text;

                if (!transcription) {
                    lastError = `${model}: respuesta vacía del modelo`;
                    console.warn(`[Transcription] ${lastError}`);
                    continue;
                }

                console.log(`[Transcription] Success with model ${model}`);
                return { success: true, text: transcription.trim() };

            } catch (error) {
                lastError = `${model}: ${error}`;
                console.warn(`[Transcription] ${lastError}`);
                continue;
            }
        }

        return { success: false, error: `Error de transcripción: ${lastError}` };
    }

    private getMimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
            ".ogg": "audio/ogg",
            ".oga": "audio/ogg",
            ".mp3": "audio/mpeg",
            ".mpeg": "audio/mpeg",
            ".mpga": "audio/mpeg",
            ".wav": "audio/wav",
            ".m4a": "audio/mp4",
            ".mp4": "audio/mp4",
            ".webm": "audio/webm",
            ".flac": "audio/flac",
            ".aac": "audio/aac"
        };
        return mimeTypes[ext] || "audio/ogg";
    }
}