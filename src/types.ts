export interface DropletInfo {
	id: number;
	ip: string;
	status: string;
}

export interface IDigitalOceanService {
	createDroplet(projectId: string, repoUrl: string): Promise<DropletInfo>;
	deleteDroplet(dropletId: number): Promise<void>;
}

export interface QueueMessage {
	projectId: string;
}

export interface Env {
	mydb: D1Database;
	DEMO_LAUNCHER_QUEUE: Queue<QueueMessage>;
	DO_API_KEY: string;
	ENVIRONMENT?: 'development' | 'production';
}

/**
 * Generates the startup bash script (Cloud-Init user_data)
 * Installs Nginx, clones the target repo, and executes demo-launcher-entrypoint.sh
 */
export function buildStartupScript(repoUrl: string): string {
	return `#!/bin/bash
set -euo pipefail

# 1. Setup Nginx & Git first
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx git curl

systemctl enable nginx
systemctl start nginx

# 2. Pull Git Project
mkdir -p /opt/demo-app
git clone "${repoUrl}" /opt/demo-app
cd /opt/demo-app

# 3. Execute demo-launcher-entrypoint.sh if present
if [ -f "./demo-launcher-entrypoint.sh" ]; then
    chmod +x ./demo-launcher-entrypoint.sh
    ./demo-launcher-entrypoint.sh
else
    echo "<h1>Demo launched for ${repoUrl}</h1>" > /var/www/html/index.html
fi
`;
}
