import { spawn, ChildProcess } from "child_process";
import { access, constants } from "fs/promises";
import { join } from "path";

export class OpenCodeServerService {
    private serverProcess: ChildProcess | null = null;
    private serverUrl: string;
    private startupTimeout = 30000; // 30 seconds

    constructor(serverUrl?: string) {
        this.serverUrl = serverUrl || process.env.OPENCODE_SERVER_URL || "http://localhost:4096";
    }

    async isServerRunning(): Promise<boolean> {
        try {
            const url = new URL(this.serverUrl);
            const response = await fetch(this.serverUrl, {
                method: "HEAD",
                signal: AbortSignal.timeout(5000),
            });
            return response.ok || response.status < 500;
        } catch (error) {
            return false;
        }
    }

    private async getResolvedOpenCodeCommand(): Promise<string | null> {
        // 1. Check local node_modules first
        const localPath = join(process.cwd(), "node_modules", ".bin", "opencode");
        try {
            await access(localPath, constants.X_OK);
            return localPath;
        } catch {
            // Not in local node_modules
        }

        // 2. Check in PATH
        try {
            const { execSync } = await import("child_process");
            const path = execSync("which opencode").toString().trim();
            if (path) {
                return path;
            }
        } catch {
            // Not in PATH
        }

        // 3. Check known user location
        const userPath = join(process.env.HOME || "", ".opencode", "bin", "opencode");
        try {
            await access(userPath, constants.X_OK);
            return userPath;
        } catch {
            // Not in user home
        }

        return null;
    }

    private async isOpenCodeInstalled(): Promise<boolean> {
        const cmd = await this.getResolvedOpenCodeCommand();
        return cmd !== null;
    }

    async startServer(): Promise<{ success: boolean; message: string }> {
        // Check if server is already running
        if (await this.isServerRunning()) {
            return { success: true, message: "OpenCode server is already running" };
        }

        // Check if opencode is available
        const opencodeCmd = await this.getResolvedOpenCodeCommand();
        if (!opencodeCmd) {
            return {
                success: false,
                message: "opencode command is not available. Please install OpenCode: npm install -g opencode-ai",
            };
        }

        try {
            // Extract port and hostname from URL
            const url = new URL(this.serverUrl);
            const port = url.port || "4096";
            const hostname = url.hostname || "localhost";

            // Start OpenCode server using: opencode serve --port <number> --hostname <string>
            const args = ["serve", "--port", port, "--hostname", hostname];

            const workDir = process.env.GITEA_DEFAULT_WORKDIR || process.cwd();
            
            this.serverProcess = spawn(opencodeCmd, args, {
                detached: true,
                stdio: "ignore",
                cwd: workDir,
            });

            // Unref so the parent process can exit independently
            this.serverProcess.unref();

            // Wait for server to start
            const startTime = Date.now();
            while (Date.now() - startTime < this.startupTimeout) {
                if (await this.isServerRunning()) {
                    return {
                        success: true,
                        message: `OpenCode server started successfully on ${this.serverUrl}`,
                    };
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }

            return {
                success: false,
                message: "OpenCode server started but did not respond within 30 seconds",
            };
        } catch (error) {
            return {
                success: false,
                message: `Failed to start OpenCode server: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    stopServer(): void {
        if (this.serverProcess && !this.serverProcess.killed) {
            this.serverProcess.kill();
            this.serverProcess = null;
        }
    }

}
