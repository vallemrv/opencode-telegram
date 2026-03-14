/**
 * Discovery Server Service
 * 
 * Provides an endpoint to discover OpenCode agents running on this node.
 * Used for multi-node support in opencode-telegram.
 */

import express from 'express';
import cors from 'cors';
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
  private app: express.Application;
  private server: any;
  private port: number;

  constructor(private agentDb: AgentDbService) {
    this.app = express();
    this.port = parseInt(process.env.DISCOVERY_PORT || '17000', 10);
    
    // Enable CORS for cross-origin requests
    this.app.use(cors());
    
    // Parse JSON bodies
    this.app.use(express.json());
    
    // Health check endpoint
    this.app.get('/', (req, res) => {
      res.json({ 
        status: 'ok', 
        message: 'OpenCode Discovery Server',
        port: this.port,
        timestamp: new Date().toISOString()
      });
    });

    // Discovery endpoint - returns all agents running on this node
    this.app.get('/discovery', (req, res) => {
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
        
        res.json(response);
      } catch (error) {
        console.error('[DiscoveryServer] Error in /discovery endpoint:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }

  private extractProjectName(workdir: string): string {
    // Extract project name from workdir path (last directory name)
    const pathParts = workdir.replace(/\/$/, '').split('/');
    return pathParts[pathParts.length - 1] || workdir;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
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
      if (this.server) {
        this.server.close(() => {
          console.log('[DiscoveryServer] Discovery server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}