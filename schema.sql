-- DROP TABLE IF EXISTS Customers;

-- CREATE TABLE IF NOT EXISTS Customers (CustomerId INTEGER PRIMARY KEY, CompanyName TEXT, ContactName TEXT);

-- INSERT INTO Customers 
-- (CustomerID, CompanyName, ContactName) 
-- VALUES 
-- (1, 'Alfreds Futterkiste', 'Maria Anders'), 
-- (4, 'Around the Horn', 'Thomas Hardy'), 
-- (11, 'Bs Beverages', 'Victoria Ashworth'), 
-- (13, 'Bs Beverages', 'Random Name');

CREATE TABLE IF NOT EXISTS project_demos (
    project_id TEXT PRIMARY KEY,
    status TEXT NOT NULL, -- 'STOPPED' | 'LAUNCHING' | 'RUNNING' | 'FAILED'
    droplet_id INTEGER,
    droplet_ip TEXT,
    launched_at INTEGER   -- Unix timestamp in milliseconds
);
