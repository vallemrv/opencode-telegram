# opencode-telegram — Arquitectura y estado del proyecto

> Última actualización: febrero 2026  
> Bot: `@valle_manjaro_bot` — framework: [grammY](https://grammy.dev/) + TypeScript

---

## Qué es esto

Bot de Telegram que actúa como interfaz para uno o varios agentes [OpenCode](https://opencode.ai).  
Cada agente es un proceso `opencode serve` de larga duración, con su propio puerto, directorio de trabajo y sesión persistente.  
El usuario habla con los agentes desde Telegram como si fuera un chat normal.

---

## Arquitectura general

```
systemd
  └─ node dist/cli.js          ← proceso principal (supervisor)
       └─ node dist/app.js     ← bot grammY (hijo directo)
            ├─ opencode serve --port 15000   ← agente "gotocheck"
            └─ opencode serve --port 15001   ← agente "Content sonar"
```

### Por qué dos procesos (cli + app)

`cli.js` es el entry point que registra systemd. Lanza `app.js` como hijo con `spawn`.  
Esto permite que `/restart` haga `process.exit(0)` en `app.js` y systemd lo detecte y reinicie.  
**Importante:** `cli.js` siempre propaga el exit code del hijo (`process.exit(code ?? 0)`), de lo contrario systemd no reinicia con exit 0.

### Puertos de agentes

Los agentes se asignan a puertos a partir del 15000 (`pickPort`).  
Se persisten en SQLite (`AgentDbService`) junto con el workdir y el modelo configurado.

---

## Flujo de un prompt

```
Usuario → Telegram → grammY → OpenCodeBot.sendPromptToAgent()
  → PersistentAgentService.sendPrompt()
    → POST /session/{id}/prompt_async   ← opencode acepta (204)
    → heartbeat timer arranca (cada 3 min)
  ← SSE /event emite session.idle
  ← resolvePromptFromIdle() fetcha /session/{id}/message
  ← respuesta editada en el mensaje de heartbeat de Telegram
```

### Endpoint crítico: `prompt_async`

El endpoint correcto en opencode ≥ 1.2.x es:

```
POST /session/{id}/prompt_async
```

**Con underscore, no con barra.** `/session/{id}/prompt/async` devuelve la web UI (200 HTML) silenciosamente — trampa difícil de detectar.

---

## Heartbeat

Mientras un prompt está en vuelo, cada `HEARTBEAT_INTERVAL_MS` (3 min) se edita **el mismo mensaje** de Telegram con info en tiempo real:

```
⏳ gotocheck — trabajando (6 min)
🔧 edit
💬 "Ahora voy a añadir la validación..."
📊 8 mensajes · 2 archivos editados
```

- **Primera vez**: se envía un mensaje nuevo y se guarda `{ chatId, msgId }` en `heartbeatMessages`.
- **Ticks siguientes**: se edita ese mismo mensaje.
- **Al resolver**: se edita el mismo mensaje con la respuesta final del agente.
- **`/esc`**: edita el mensaje a `❌ cancelado` y resuelve el pending promise.

La info se extrae de los `parts` de los mensajes SSE: `tool-invocation` para el tool name, `text` para el snippet, conteo de mensajes y tools de escritura (`edit`, `write`, `patch`, `multiedit`).

### Recuperación tras desconexión SSE

Si el SSE se cae mientras opencode procesa un prompt, el evento `session.idle` se pierde.  
Al reconectar, `recoverPendingPrompt()` comprueba si la sesión ya está `idle` y resuelve el pending inmediatamente.

---

## Cancelación con `/esc`

`/esc` ahora tiene tres niveles, en orden de prioridad:

1. **Prompt en vuelo**: si el agente activo/último está `isBusy()` → `cancelPendingPrompt()` → edita el mensaje de heartbeat con `❌ cancelado`.
2. **Wizard activo** (`/new`, `/run`, `/rename`): cancela el wizard.
3. **Agente sticky**: desactiva el agente fijo del usuario.

---

## Sesiones de OpenCode

Cada agente tiene una sesión "larga vida" en opencode. Al arrancar, el bot restaura la sesión guardada en BD; si ya no existe en el server, crea una nueva.

El comando `/session` lista las sesiones del agente activo con botones inline para:
- Cambiar la sesión activa
- Crear sesión nueva
- Borrar una sesión
- Borrar todas las sesiones

### Bug histórico: BUTTON_DATA_INVALID

Los callback data de Telegram tienen límite de **64 bytes**. Los UUIDs de opencode tienen 36 chars, y combinando `agentId + sessionId` se superaba el límite.  
Solución: índice en memoria `sessIndex: Map<shortKey, {agentId, sessionId}>`. Los botones usan claves cortas (`sa:s0:1`, `sx:s0:1`, `sn:s0`, `sd:s0`).

---

## Base de datos

SQLite en `opencode_bot_sessions.sqlite` (mismo directorio).

Tablas gestionadas por `AgentDbService`:
- `agents` — id, name, port, workdir, model, userId, sessionId, lastUsed

Tablas gestionadas por `SessionDbService`:
- `state` — key/value genérico (usado para `restart_pending_chat_id`, `restart_pending_message_id`)

---

## Servicio systemd

```ini
# /etc/systemd/system/opencode-telegram.service
ExecStart=/usr/bin/node dist/cli.js
WorkingDirectory=/home/valle/Documentos/proyectos/opencode-telegram
EnvironmentFile=.../.env
StandardOutput=append:.../bot.log
StandardError=append:.../bot.log
Restart=always
RestartSec=10
```

Logs: `tail -f bot.log` o `journalctl -u opencode-telegram -f`.

---

## Comandos del bot

| Comando | Descripción |
|---------|-------------|
| `/new` | Wizard para crear un agente nuevo (workdir local) |
| `/agents` | Lista agentes, activa sticky, borra |
| `/session` | Lista y gestiona sesiones del agente activo |
| `/rename` | Renombra la sesión activa |
| `/delete` | Borra sesión activa y crea una nueva |
| `/deleteall` | Borra todas las sesiones y crea una nueva |
| `/models` | Cambia el modelo de IA del agente activo |
| `/run` | Prompt one-shot a un agente concreto |
| `/esc` | Cancela operación en curso (prompt, wizard, sticky) |
| `/undo` | Revertir último cambio |
| `/redo` | Restaurar cambio revertido |
| `/restart` | Reinicia bot y agentes (systemd lo relanza) |

---

## Agentes actuales

| Nombre | Puerto | Workdir |
|--------|--------|---------|
| gotocheck | 15000 | `/home/valle/proyectos/gotocheck` (symlink → Documentos/proyectos/gotocheck) |
| Content sonar | 15001 | `/home/valle/Documentos/proyectos/content-sonar` |

---

## Decisiones de diseño relevantes

### `findOpencodeCmd` — orden de búsqueda

`/usr/bin/opencode` va primero. El wrapper de `node_modules/.bin/opencode` falla buscando binarios nativos cuando se lanza desde systemd.

### Sin timeout duro

No hay timeout de 10 minutos. El usuario cancela explícitamente con `/esc`.  
El heartbeat es solo informativo, no tiene efecto sobre el ciclo de vida del prompt.

### Un `opencode serve` por agente

Cada agente tiene su propio proceso, puerto y sesión. No se comparte servidor entre agentes. Esto permite modelos distintos por agente y aislamiento total.

### Cola de prompts por agente

Si el agente está ocupado y llega otro prompt, se encola (`promptQueues`). Al resolver el prompt en curso, se drena el siguiente automáticamente. `/esc` limpia también la cola.

### Auto-rename de sesión

Si la sesión tiene título por defecto (`tg-*`), el primer prompt la renombra automáticamente con el texto del prompt (hasta 50 chars).

---

## Cosas que podrían mejorarse algún día

- **Persistir `heartbeatMessages` en BD** — ahora es en memoria, si el bot se reinicia mientras hay un prompt en vuelo el heartbeat message queda huérfano en Telegram.
- **`/abort` en opencode** — el endpoint `POST /session/{id}/abort` existe pero no lo usamos; podría ser más limpio que simplemente resolver el promise localmente con "cancelado".
- **Multi-usuario real** — ahora el `userId` del agente es el del creador; si hubiera más usuarios necesitaría routing por chat.
- **Notificación de sesión perdida** — si el bot se reinicia con un prompt en vuelo y el opencode server también se reinició, el trabajo se pierde silenciosamente.
