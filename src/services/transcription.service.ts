import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface TranscriptionResult {
    success: boolean;
    text?: string;
    error?: string;
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

        try {
            const audioBuffer = fs.readFileSync(audioPath);
            const base64Audio = audioBuffer.toString("base64");
            
            const mimeType = this.getMimeType(audioPath);
            
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${this.apiKey}`,
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

            if (!response.ok) {
                const errorText = await response.text();
                return { success: false, error: `Error API Gemini: ${response.status} - ${errorText}` };
            }

            const data: any = await response.json();
            
            const transcription = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            
            if (!transcription) {
                return { success: false, error: "No se obtuvo transcripción del modelo" };
            }

            return { success: true, text: transcription.trim() };
        } catch (error) {
            return { success: false, error: `Error de transcripción: ${error}` };
        }
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