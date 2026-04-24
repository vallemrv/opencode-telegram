/**
 * CLI entry point for TelegramCoder
 * Allows running via npx: npx @tommertom/telegramcoder
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🤖 TelegramCoder - AI-Powered Telegram Bot');
console.log('================================================\n');

startBot();

function startBot() {
    // Check if .env file exists in current directory
    const envPath = join(process.cwd(), '.env');
    const templatePath = join(__dirname, '..', 'dot-env.template');

    if (!fs.existsSync(envPath)) {
        console.log('⚠️  No .env file found in current directory!');
        console.log('\n📝 Creating .env template...\n');

        if (fs.existsSync(templatePath)) {
            fs.copyFileSync(templatePath, envPath);
            console.log('✅ Created .env file from template');
            console.log('\n🔧 Please edit .env and configure:');
            console.log('   - TELEGRAM_BOT_TOKENS (required)');
            console.log('   - ALLOWED_USER_IDS (required)');
            console.log('\nThen run the command again.\n');
            process.exit(0);
        } else {
            console.log('❌ Template file not found. Please create .env manually.');
            console.log('\nRequired variables:');
            console.log('   TELEGRAM_BOT_TOKENS=your_bot_token_here');
            console.log('   ALLOWED_USER_IDS=your_user_id_here\n');
            process.exit(1);
        }
    }

    // Check if .env has the required variables
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const hasToken = /TELEGRAM_BOT_TOKENS\s*=\s*.+/.test(envContent);
    const hasUsers = /ALLOWED_USER_IDS\s*=\s*.+/.test(envContent);

    if (!hasToken || !hasUsers) {
        console.log('⚠️  .env file is incomplete!\n');
        if (!hasToken) console.log('   ❌ Missing TELEGRAM_BOT_TOKENS');
        if (!hasUsers) console.log('   ❌ Missing ALLOWED_USER_IDS');
        console.log('\n🔧 Please edit .env and configure the required variables.\n');
        process.exit(1);
    }

    console.log('🚀 Starting TelegramCoder...\n');

    // Start the main application
    const appPath = join(__dirname, 'app.js');

    const child = spawn(process.execPath, [appPath], {
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'production' },
        shell: false,
    });

    child.on('exit', (code) => {
        // Always propagate the exit code so systemd can restart the process.
        // A clean exit (code 0) is used by /restart — systemd must see it to restart.
        process.exit(code ?? 0);
    });

    child.on('error', (err) => {
        console.error(`\n❌ Failed to start TelegramCoder: ${err.message}`);
        process.exit(1);
    });

    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
}
