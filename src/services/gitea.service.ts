import type { GiteaProject, CreateProjectRequest } from "./gitea.types.js";

export class GiteaService {
    private baseUrl: string;
    private token: string;

    constructor() {
        this.baseUrl = process.env.GITEA_URL || "http://10.0.0.1:3000";
        this.token = process.env.GITEA_TOKEN || "";
    }

    private getHeaders(): Record<string, string> {
        return {
            "Authorization": `token ${this.token}`,
            "Content-Type": "application/json",
        };
    }

    async listProjects(): Promise<GiteaProject[]> {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/user/repos`, {
                method: "GET",
                headers: this.getHeaders(),
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch projects: ${response.statusText}`);
            }

            const data = await response.json() as GiteaProject[];
            return data;
        } catch (error) {
            console.error("Error fetching Gitea projects:", error);
            return [];
        }
    }

    async createProject(request: CreateProjectRequest): Promise<GiteaProject | null> {
        try {
            const response = await fetch(`${this.baseUrl}/api/v1/user/repos`, {
                method: "POST",
                headers: this.getHeaders(),
                body: JSON.stringify({
                    name: request.name,
                    description: request.description || "",
                    private: request.private ?? false,
                    auto_init: true,
                    readme: request.readme || "default",
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to create project: ${response.statusText} - ${errorText}`);
            }

            const data = await response.json() as GiteaProject;
            return data;
        } catch (error) {
            console.error("Error creating Gitea project:", error);
            return null;
        }
    }

    async cloneProject(projectName: string, localPath: string): Promise<boolean> {
        try {
            const { execSync } = await import("child_process");
            const project = await this.getProject(projectName);
            
            if (!project) {
                throw new Error(`Project ${projectName} not found`);
            }

            // Clone the repository
            execSync(`git clone ${project.ssh_url} ${localPath}`, {
                stdio: "inherit",
            });

            return true;
        } catch (error) {
            console.error(`Error cloning project ${projectName}:`, error);
            return false;
        }
    }

    async getProject(name: string): Promise<GiteaProject | null> {
        try {
            const projects = await this.listProjects();
            return projects.find(p => p.name === name) || null;
        } catch (error) {
            console.error(`Error getting project ${name}:`, error);
            return null;
        }
    }
}
