# AGENTS.md

## OpenCode Telegram Bot - Deployment

**El bot solamente se arranca y gestiona a través de systemd:**

```bash
sudo systemctl start opencode-telegram
sudo systemctl stop opencode-telegram
sudo systemctl restart opencode-telegram
sudo systemctl status opencode-telegram
```

**NUNCA usar PM2** para gestionar el bot. PM2 causa conflictos de token (error 409: Conflict: terminated by other getUpdates request) al crear instancias duplicadas que pelean con systemd.

Siempre verificar que no haya procesos huérfanos de PM2 antes de reiniciar:

```bash
pm2 list
# Si aparece telegramCoder: pm2 stop telegramCoder && pm2 delete telegramCoder
```
