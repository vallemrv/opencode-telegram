# TelegramCoder Docker Setup

This directory contains Docker configuration files to run the TelegramCoder bot with OpenCode server in a single container.

## What's Included

- **Dockerfile**: Multi-service container running both the Telegram bot and OpenCode server
- **docker-compose.yml**: Docker Compose configuration for easy deployment
- **.env.template**: Template for environment variables

## Prerequisites

- Docker (20.10+)
- Docker Compose (2.0+)
- Node.js 22 (for local development)

## Quick Start

### 1. Configure Environment Variables

Copy the template and fill in your values:

```bash
cd docker
cp .env.template .env
```

Edit `.env` and set:
- `TELEGRAM_BOT_TOKENS`: Your bot token from [@BotFather](https://t.me/BotFather)
- `ALLOWED_USER_IDS`: Comma-separated list of Telegram user IDs
- `OPENCODE_BASE_URL`: Leave as `http://localhost:4000` (default)

### 2. Build and Run

```bash
# Build the container
docker-compose build

# Start the services
docker-compose up -d

# View logs
docker-compose logs -f
```

### 3. Verify Services

Check that both services are running:

```bash
# Check container status
docker-compose ps

# Check OpenCode server
curl http://localhost:4000/health

# Check bot logs
docker-compose logs telegramcoder
```

## Services

The container runs two services managed by Supervisor:

1. **OpenCode Server** (`opencode serve`)
   - Runs on port 4000
   - Workspace directory: `/workspace`
   - Logs: `/app/logs/opencode.log`

2. **Telegram Bot** (`node dist/app.js`)
   - Connects to Telegram API
   - Uses OpenCode server at `http://localhost:4000`
   - Logs: `/app/logs/bot.log`

## Volumes

- `../logs`: Application and service logs
- `../events`: Event snapshots (JSON files)
- `opencode_workspace`: OpenCode workspace (persistent)

## Ports

- `4000`: OpenCode server (exposed to host)

## Management Commands

```bash
# Start services
docker-compose up -d

# Stop services
docker-compose down

# Restart services
docker-compose restart

# View logs
docker-compose logs -f

# View logs for specific service
docker-compose logs -f telegramcoder

# Execute commands in container
docker-compose exec telegramcoder bash

# Rebuild after code changes
docker-compose build --no-cache
docker-compose up -d
```

## Troubleshooting

### Bot not responding
1. Check if container is running: `docker-compose ps`
2. Check bot logs: `docker-compose logs telegramcoder | grep bot`
3. Verify bot token in `.env`
4. Verify user ID is in `ALLOWED_USER_IDS`

### OpenCode server not accessible
1. Check server logs: `docker-compose logs telegramcoder | grep opencode`
2. Verify port 4000 is exposed: `docker-compose ps`
3. Test health endpoint: `curl http://localhost:4000/health`

### Permission issues
The container runs services as the `node` user for security. If you encounter permission issues with volumes:

```bash
# Fix log directory permissions
chown -R 1000:1000 ../logs ../events

# Or run with current user
docker-compose run --user $(id -u):$(id -g) telegramcoder
```

### Viewing supervisor status
```bash
docker-compose exec telegramcoder supervisorctl status
```

## Development

For local development without Docker:

1. Install dependencies: `npm install`
2. Build: `npm run build:prod`
3. Start OpenCode server: `opencode serve --workspace ./workspace`
4. Start bot: `npm start`

## Resource Limits

Default limits (adjust in `docker-compose.yml`):
- CPU: 0.5-4.0 cores
- Memory: 512MB-4GB

## Security

- Container runs with `no-new-privileges` security option
- Services run as non-root `node` user
- Environment variables stored in `.env` (not committed to git)
- Logs are rotated (max 10MB, 3 files)

## License

Same as parent project.
