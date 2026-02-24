/**
 * BackgroundAgentService
 *
 * Runs `opencode run` as an isolated subprocess (with its own ephemeral server
 * via --port <random>) and returns the collected stdout once the process exits.
 *
 * Design decisions:
 * - Uses --port <random> so the background task never touches the main server.
 * - Captures stdout line-by-line and strips ANSI escape codes.
 * - Resolves with { output, exitCode } when the process finishes.
 * - onProgress callback is called with each meaningful line (for future streaming).
 */

import { spawn } from "child_process";
import * as os from "os";
import * as nodePath from "path";

export interface RunOptions {
    model: string;
    workdir: string;
    prompt: string;
    agent?: string;
    onProgress?: (line: string) => void;
}

export interface RunResult {
    output: string;
    exitCode: number;
}

/** Strip ANSI colour / cursor codes from a string */
function stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B\[[0-9;]*[mGKHFABCDJnsu]/g, "").replace(/\x1B\([A-Z]/g, "");
}

/** Resolve ~ and expand basic env vars in a path */
export function resolveDir(p: string): string {
    if (p.startsWith("~/") || p === "~") {
        return nodePath.join(os.homedir(), p.slice(1));
    }
    return p;
}

/** Pick a random port in 14000-15000 range for the ephemeral opencode server */
function randomPort(): number {
    return 14000 + Math.floor(Math.random() * 1000);
}

/** Find the opencode binary (same logic as OpenCodeServerService) */
async function findOpencodeCmd(): Promise<string> {
    const { access, constants } = await import("fs/promises");

    const candidates = [
        nodePath.join(process.cwd(), "node_modules", ".bin", "opencode"),
        nodePath.join(process.env.HOME || "", ".opencode", "bin", "opencode"),
        "/usr/bin/opencode",
        "/usr/local/bin/opencode",
    ];

    for (const p of candidates) {
        try {
            await access(p, constants.X_OK);
            return p;
        } catch { /* try next */ }
    }

    // Fallback: try PATH
    try {
        const { execSync } = await import("child_process");
        const found = execSync("which opencode").toString().trim();
        if (found) return found;
    } catch { /* not in PATH */ }

    throw new Error("opencode binary not found. Make sure OpenCode is installed.");
}

export class BackgroundAgentService {

    async run(opts: RunOptions): Promise<RunResult> {
        const cmd = await findOpencodeCmd();
        const port = randomPort();
        const resolvedDir = resolveDir(opts.workdir);

        const args = [
            "run",
            "--port", String(port),
            "--dir", resolvedDir,
            "--model", opts.model,
        ];

        if (opts.agent) {
            args.push("--agent", opts.agent);
        }

        // Prompt goes last as positional argument
        args.push(opts.prompt);

        return new Promise((resolve) => {
            const child = spawn(cmd, args, {
                cwd: resolvedDir,
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env },
            });

            const lines: string[] = [];

            const handleData = (data: Buffer) => {
                const raw = data.toString("utf8");
                const cleaned = stripAnsi(raw);
                for (const line of cleaned.split("\n")) {
                    const trimmed = line.trim();
                    // Skip empty lines and the "build · model" header line
                    if (!trimmed || trimmed.startsWith(">")) continue;
                    lines.push(trimmed);
                    opts.onProgress?.(trimmed);
                }
            };

            child.stdout.on("data", handleData);
            child.stderr.on("data", handleData);

            child.on("close", (code) => {
                resolve({
                    output: lines.join("\n").trim(),
                    exitCode: code ?? 1,
                });
            });

            child.on("error", (err) => {
                resolve({
                    output: `Failed to start opencode: ${err.message}`,
                    exitCode: 1,
                });
            });
        });
    }
}
