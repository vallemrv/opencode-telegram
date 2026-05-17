# opencode-telegram

Project created via TelegramCoder.

## Notas importantes

- **sudo sin password**: El usuario `valle` tiene sudo sin contraseña para gestionar el servicio `opencode-telegram.service`.
- **Comandos de servicio**:
  - `sudo systemctl stop opencode-telegram` - Detener el bot
  - `sudo systemctl start opencode-telegram` - Iniciar el bot
  - `sudo systemctl status opencode-telegram` - Ver estado
  - `sudo journalctl -u opencode-telegram -f` - Ver logs en tiempo real
