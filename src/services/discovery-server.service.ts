/**
 * Discovery Server Service
 * 
 * Provides an endpoint to discover OpenCode agents running on this node.
 * Used for multi-node support in opencode-telegram.
 * Uses native http module to avoid packaging issues with esbuild.
 */

import http from 'http';
import url from 'url';
import { AgentDbService, PersistentAgent } from './agent-db.service.js';

interface DiscoveryResponse {
  agents: Array<{
    port: number;
    workdir: string;
    project: string;
    status: string;
    sessionId?: string;
  }>;
}

export class DiscoveryServerService {
  private server: http.Server;
  private port: number;

  constructor(private agentDb: AgentDbService) {
    this.port = parseInt(process.env.DISCOVERY_PORT || '17000', 10);
    
    this.server = http.createServer((req, res) => {
      const parsedUrl = url.parse(req.url!, true);
      const pathname = parsedUrl.pathname;
      
      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }
      
      if (pathname === '/' && req.method === 'GET') {
        this.handleHealthCheck(req, res);
      } else if (pathname === '/discovery' && req.method === 'GET') {
        this.handleDiscovery(req, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });
  }

  private handleHealthCheck(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      message: 'OpenCode Discovery Server',
      port: this.port,
      timestamp: new Date().toISOString()
    }));
  }

  private handleDiscovery(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      // Get all agents managed by this node
      const allAgents = this.agentDb.getAll();
      
      // Filter to only agents hosted on localhost (this node)
      const localAgents = allAgents.filter(agent => 
        !agent.isRemote && (agent.host === 'localhost' || agent.host === '127.0.0.1' || !agent.host)
      );
      
      const response: DiscoveryResponse = {
        agents: localAgents.map(agent => ({
          port: agent.port,
          workdir: agent.workdir,
          project: this.extractProjectName(agent.workdir),
          status: agent.status,
          sessionId: agent.sessionId
        }))
      };
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      console.error('[DiscoveryServer] Error in /discovery endpoint:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  private extractProjectName(workdir: string): string {
    // Extract project name from workdir path (last directory name)
    const pathParts = workdir.replace(/\/$/, '').split('/');
    return pathParts[pathParts.length - 1] || workdir;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[DiscoveryServer] Discovery server running on port ${this.port}`);
        resolve();
      });
      
      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[DiscoveryServer] Port ${this.port} is already in use`);
        }
        reject(err);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('[DiscoveryServer] Discovery server stopped');
        resolve();
      });
    });
  }
}