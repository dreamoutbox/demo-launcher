CREATE TABLE IF NOT EXISTS project_demos (
    project_id TEXT PRIMARY KEY,
    status TEXT NOT NULL, -- 'STOPPED' | 'LAUNCHING' | 'RUNNING' | 'FAILED'
    droplet_id INTEGER,
    droplet_ip TEXT,
    tags TEXT,            -- JSON array of DigitalOcean tags
    launched_at INTEGER,  -- Unix timestamp in milliseconds
    attempt_id TEXT       -- UUID for the current launch attempt
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,       -- Serialized full project configuration JSON
    updated_at INTEGER NOT NULL -- Unix timestamp in milliseconds
);

CREATE TABLE IF NOT EXISTS action_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    project_id TEXT,
    ip_address TEXT,
    country TEXT,
    user_agent TEXT,
    status TEXT NOT NULL,
    details TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_logs_created_at ON action_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_logs_project_id ON action_logs(project_id);
