export interface GiteaProject {
    id: number;
    name: string;
    description: string;
    html_url: string;
    ssh_url: string;
    clone_url: string;
    created_at: string;
    updated_at: string;
}

export interface CreateProjectRequest {
    name: string;
    description?: string;
    private?: boolean;
    readme?: string;
}
