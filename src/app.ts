import { Bot } from "grammy";
import { ConfigService } from './services/config.service.js';
import { AgentDbService } from './services/agent-db.service.js';
import { PersistentAgentService } from './services/persistent-agent.service.js';
import { OpenCodeBot } from './features/opencode/opencode.bot.js';
import { AccessControlMiddleware } from './middleware/access-control.middleware.js';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

console.log('[TelegramCoder] Starting bot...');

dotenv.config();

// Initialize config service
const configService = new ConfigService();

try {
    configService.validate();
    console.log('[TelegramCoder] Configuration loaded successfully');
    console.log(configService.getDebugInfo());
} catch (error) {
    console.error('[TelegramCoder] Configuration error:', error);
    process.exit(1);
}

// Get the first bot token
const tokens = configService.getTelegramBotTokens();
if (tokens.length === 0) {
    console.error('[TelegramCoder] No bot tokens found in configuration');
    process.exit(1);
}

const botToken = tokens[0];
console.log(`[TelegramCoder] Initializing with token: ${botToken.substring(0, 10)}...`);

// Create bot instance
const bot = new Bot(botToken);

// Initialize services
const agentDb = new AgentDbService();
const persistentAgentService = new PersistentAgentService(agentDb);

// Set global error handler to prevent crashes
bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`[TelegramCoder] Error while handling update ${ctx.update.update_id}:`, err.error);
});

// Set config service for access control
AccessControlMiddleware.setConfigService(configService);

// Set bot instance for access control (needed for admin notifications)
AccessControlMiddleware.setBot(bot);

// Initialize the OpenCode bot
const opencodeBot = new OpenCodeBot(configService);

// Register handlers
opencodeBot.registerHandlers(bot);

async function startBot() {
    try {
        console.log('[TelegramCoder] Starting initialization...');

        // Clean up media directory if configured
        if (configService.shouldCleanUpMediaDir()) {
            const botMediaPath = path.join(configService.getMediaTmpLocation(), 'bot-1');
            if (fs.existsSync(botMediaPath)) {
                console.log(`[TelegramCoder] Cleaning up media directory: ${botMediaPath}`);
                fs.rmSync(botMediaPath, { recursive: true, force: true });
                console.log('[TelegramCoder] ✅ Media directory cleaned');
            }
        }

        // Get bot info
        try {
            const me = await bot.api.getMe();
            const fullName = [me.first_name, me.last_name].filter(Boolean).join(" ");
            console.log(`[TelegramCoder] Bot info: ${fullName} (@${me.username})`);
        } catch (error) {
            console.error('[TelegramCoder] Failed to get bot info:', error);
        }

        // Set bot commands for Telegram UI
        try {
            await bot.api.setMyCommands([
                { command: 'new',       description: 'Crear nuevo agente' },
                { command: 'agents',    description: 'Listar / gestionar agentes' },
                { command: 'run',       description: 'Enviar prompt one-shot a un agente' },
                { command: 'session',   description: 'Ver sesiones del agente activo' },
                { command: 'rename',    description: 'Renombrar sesión activa' },
                { command: 'delete',    description: 'Borrar sesión activa y crear una nueva' },
                { command: 'deleteall', description: 'Borrar todas las sesiones y crear una nueva' },
                { command: 'models',    description: 'Cambiar modelo de IA' },
                { command: 'esc',       description: 'Cancelar operación en curso' },
                { command: 'undo',      description: 'Revertir último cambio' },
                { command: 'redo',      description: 'Restaurar cambio revertido' },
                { command: 'restart',   description: 'Reiniciar bot y agentes' },
                { command: 'start',     description: 'Mensaje de bienvenida' },
            ]);
            console.log('[TelegramCoder] ✅ Bot commands registered');
        } catch (error) {
            console.error('[TelegramCoder] Failed to set bot commands:', error);
        }

        // Notify user after restart if requested (before bot.start blocks)
        try {
            const { SessionDbService } = await import('./services/session-db.service.js');
            const db = new SessionDbService();
            const chatId = db.getState('restart_pending_chat_id');
            const messageId = db.getState('restart_pending_message_id');
            if (chatId) {
                db.deleteState('restart_pending_chat_id');
                db.deleteState('restart_pending_message_id');
                if (messageId) {
                    await bot.api.editMessageText(
                        Number(chatId), Number(messageId),
                        '✅ Bot reiniciado correctamente.'
                    ).catch(() => {});
                } else {
                    await bot.api.sendMessage(Number(chatId), '✅ Bot reiniciado correctamente.').catch(() => {});
                }
            }
        } catch { /* non-fatal */ }

        // Start the bot
        await bot.start();
        console.log('[TelegramCoder] ✅ Bot started successfully');
    } catch (error) {
        console.error('[TelegramCoder] Failed to start:', error);
        process.exit(1);
    }
}

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) {
        console.log('[TelegramCoder] Shutdown already in progress...');
        return;
    }

    shuttingDown = true;
    console.log(`[TelegramCoder] Received ${signal}, shutting down gracefully...`);

    try {
        await bot.stop();
        console.log('[TelegramCoder] ✅ Shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('[TelegramCoder] Error during shutdown:', error);
        process.exit(1);
    }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
    console.error('[TelegramCoder] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('[TelegramCoder] Uncaught Exception:', error);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

startBot().catch((error) => {
    console.error('[TelegramCoder] Fatal error:', error);
    process.exit(1);
});
