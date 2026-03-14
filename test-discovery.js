#!/usr/bin/env node
/**
 * Script de prueba para verificar la funcionalidad de descubrimiento de agentes
 */

const axios = require('axios');

async function testDiscovery(targetHost, targetPort = 17000) {
    console.log(`🔍 Probando descubrimiento en http://${targetHost}:${targetPort}/discovery`);
    
    try {
        const response = await axios.get(`http://${targetHost}:${targetPort}/discovery`, {
            timeout: 5000
        });
        
        console.log('✅ Conexión exitosa!');
        console.log('📡 Agentes encontrados:');
        
        if (response.data && response.data.agents && response.data.agents.length > 0) {
            response.data.agents.forEach((agent, index) => {
                console.log(`  ${index + 1}. Proyecto: ${agent.project}`);
                console.log(`     Puerto: ${agent.port}`);
                console.log(`     Directorio: ${agent.workdir}`);
                console.log(`     Estado: ${agent.status}`);
                if (agent.sessionId) {
                    console.log(`     Sesión: ${agent.sessionId}`);
                }
                console.log('');
            });
        } else {
            console.log('  ❗ No se encontraron agentes activos');
        }
    } catch (error) {
        console.error('❌ Error al conectar con el servidor de descubrimiento:', error.message);
        if (error.response) {
            console.error(`   Código HTTP: ${error.response.status}`);
            console.error(`   Cuerpo: ${error.response.data}`);
        }
    }
}

async function testHealth(targetHost, targetPort = 17000) {
    console.log(`🏥 Probando salud en http://${targetHost}:${targetPort}/`);
    
    try {
        const response = await axios.get(`http://${targetHost}:${targetPort}/`, {
            timeout: 5000
        });
        
        console.log('✅ Servidor de descubrimiento saludable');
        console.log('   Estado:', response.data.status);
        console.log('   Puerto:', response.data.port);
        console.log('   Hora:', response.data.timestamp);
    } catch (error) {
        console.error('❌ Error al probar salud:', error.message);
    }
}

// Ejecutar tests
async function runTests() {
    const args = process.argv.slice(2);
    const targetHost = args[0] || 'localhost';
    const targetPort = args[1] || '17000';
    
    console.log(`🧪 Test de descubrimiento multinodo`);
    console.log(`   Host: ${targetHost}`);
    console.log(`   Puerto: ${targetPort}`);
    console.log('');
    
    await testHealth(targetHost, targetPort);
    console.log('');
    await testDiscovery(targetHost, targetPort);
}

runTests().catch(console.error);