#!/bin/bash

# Script de inicio para OpenCode Telegram Bot
# Previene múltiples instancias

PIDFILE="/var/run/opencode-telegram.pid"
WORKDIR="/home/valle/Documentos/proyectos/opencode-telegram"
USER="valle"

# Función para limpiar procesos existentes
cleanup_existing() {
    echo "Limpiando procesos existentes..."
    pkill -f "opencode.*telegram" 2>/dev/null || true
    pkill -f "node.*app.js" 2>/dev/null || true
    
    # Esperar un momento para que los procesos terminen
    sleep 2
    
    # Forzar si aún quedan procesos
    pkill -9 -f "opencode.*telegram" 2>/dev/null || true
    pkill -9 -f "node.*app.js" 2>/dev/null || true
    
    # Limpiar archivo PID si existe
    [ -f "$PIDFILE" ] && rm -f "$PIDFILE"
}

# Verificar si ya está ejecutándose
check_running() {
    if [ -f "$PIDFILE" ]; then
        PID=$(cat "$PIDFILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "El bot ya está ejecutándose (PID: $PID)"
            exit 1
        else
            echo "Archivo PID obsoleto, limpiando..."
            rm -f "$PIDFILE"
        fi
    fi
}

# Función principal
main() {
    echo "Iniciando OpenCode Telegram Bot..."
    
    # Verificar si ya está ejecutándose
    check_running
    
    # Limpiar procesos existentes
    cleanup_existing
    
    # Cambiar al directorio de trabajo
    cd "$WORKDIR" || {
        echo "Error: No se puede acceder al directorio $WORKDIR"
        exit 1
    }
    
    # Verificar que el ejecutable existe
    if [ ! -f "dist/app.js" ]; then
        echo "Error: dist/app.js no encontrado. ¿Has compilado el proyecto?"
        exit 1
    fi
    
    # Iniciar el bot y capturar el PID
    exec node dist/app.js &
    echo $! > "$PIDFILE"
    
    echo "Bot iniciado con PID: $(cat $PIDFILE)"
}

# Ejecutar función principal
main "$@"