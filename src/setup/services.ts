/**
 * Service Management
 *
 * Installs and manages services (Postgres, Redis) directly on the system.
 * Designed for Sprite sandboxes where we have full control.
 */

import { spawn } from "child_process";
import { waitForPort } from "../config.js";

export interface ServiceInstance {
  name: string;
  url: string;
  port: number;
}

export interface ServiceConfig {
  name: string;
  version: string;
  envVar: string;
  extensions?: string[];  // e.g., ["postgis", "pg_trgm"]
}

/**
 * Start a service, installing if necessary.
 */
export async function startService(service: ServiceConfig): Promise<ServiceInstance> {
  switch (service.name) {
    case "postgres":
    case "postgresql":
      return startPostgres(service.version, service.extensions);
    case "redis":
      return startRedis(service.version);
    default:
      throw new Error(`Unsupported service: ${service.name}`);
  }
}

// =============================================================================
// PostgreSQL
// =============================================================================

async function startPostgres(version: string, extensions?: string[]): Promise<ServiceInstance> {
  // Check if already running
  const existingUrl = process.env.POSTGRES_URL;
  if (existingUrl) {
    console.log("[services] Using existing POSTGRES_URL from environment");
    return { name: "postgres", url: existingUrl, port: 5432 };
  }

  const port = 5432;
  const database = "flightplan";
  const user = "flightplan";
  const password = "flightplan";

  // Check if Postgres is already installed and running
  if (await isPortOpen(port)) {
    console.log("[services] Postgres already running on port 5432");
    // Ensure our database exists
    await ensurePostgresDatabase(database, user, password, extensions);
    const url = `postgres://${user}:${password}@localhost:${port}/${database}`;
    return { name: "postgres", url, port };
  }

  // Check if Postgres is installed
  const isInstalled = await commandExists("psql");

  if (!isInstalled) {
    console.log(`[services] Installing PostgreSQL ${version}...`);
    await installPostgres(version, extensions);
  }

  // Start Postgres
  console.log("[services] Starting PostgreSQL...");
  await startPostgresService();

  // Wait for it to be ready
  await waitForPort(port, 30000);

  // Create database and user, enable extensions
  await ensurePostgresDatabase(database, user, password, extensions);

  const url = `postgres://${user}:${password}@localhost:${port}/${database}`;
  console.log(`[services] PostgreSQL ready: ${url}`);

  return { name: "postgres", url, port };
}

async function installPostgres(version: string, extensions?: string[]): Promise<void> {
  // Determine the major version (e.g., "16" from "16.1")
  const majorVersion = version.split(".")[0];

  // Try different installation methods based on OS
  const os = await detectOS();

  if (os === "debian" || os === "ubuntu") {
    // Debian/Ubuntu
    await runCommand("apt-get update");
    await runCommand(`apt-get install -y postgresql-${majorVersion} postgresql-contrib-${majorVersion}`);
    
    // Install extension packages
    if (extensions?.includes("postgis")) {
      console.log("[services] Installing PostGIS extension...");
      await runCommand(`apt-get install -y postgresql-${majorVersion}-postgis-3 postgresql-${majorVersion}-postgis-3-scripts`);
    }
    if (extensions?.includes("pgvector")) {
      console.log("[services] Installing pgvector extension...");
      await runCommand(`apt-get install -y postgresql-${majorVersion}-pgvector`);
    }
  } else if (os === "alpine") {
    // Alpine Linux (common in containers)
    await runCommand(`apk add --no-cache postgresql${majorVersion} postgresql${majorVersion}-contrib`);
    
    if (extensions?.includes("postgis")) {
      await runCommand(`apk add --no-cache postgis`);
    }
  } else if (os === "macos") {
    // macOS (for local development)
    await runCommand(`brew install postgresql@${majorVersion}`);
    
    if (extensions?.includes("postgis")) {
      await runCommand("brew install postgis");
    }
    if (extensions?.includes("pgvector")) {
      await runCommand("brew install pgvector");
    }
  } else {
    throw new Error(`Unsupported OS for Postgres installation: ${os}`);
  }
}

async function startPostgresService(): Promise<void> {
  const os = await detectOS();

  if (os === "debian" || os === "ubuntu") {
    // Try systemctl first, fall back to pg_ctlcluster
    try {
      await runCommand("pg_ctlcluster 16 main start || service postgresql start");
    } catch {
      // If cluster doesn't exist, create it
      await runCommand("pg_createcluster 16 main --start");
    }
  } else if (os === "alpine") {
    // Alpine uses rc-service or direct pg_ctl
    await runCommand("mkdir -p /run/postgresql && chown postgres:postgres /run/postgresql");
    await runCommand("su postgres -c 'pg_ctl -D /var/lib/postgresql/data start'", true);
  } else if (os === "macos") {
    await runCommand("brew services start postgresql@16");
  }
}

async function ensurePostgresDatabase(database: string, user: string, password: string, extensions?: string[]): Promise<void> {
  // Create user if not exists
  await runCommand(
    `su postgres -c "psql -tc \\"SELECT 1 FROM pg_roles WHERE rolname='${user}'\\" | grep -q 1 || psql -c \\"CREATE USER ${user} WITH PASSWORD '${password}' CREATEDB SUPERUSER\\""`,
    true // ignore errors
  );

  // Create database if not exists
  await runCommand(
    `su postgres -c "psql -tc \\"SELECT 1 FROM pg_database WHERE datname='${database}'\\" | grep -q 1 || psql -c \\"CREATE DATABASE ${database} OWNER ${user}\\""`,
    true
  );

  // Enable extensions in the database
  if (extensions && extensions.length > 0) {
    for (const ext of extensions) {
      console.log(`[services] Enabling extension: ${ext}`);
      await runCommand(
        `su postgres -c "psql -d ${database} -c \\"CREATE EXTENSION IF NOT EXISTS ${ext}\\""`,
        true
      );
    }
  }
}

// =============================================================================
// Redis
// =============================================================================

async function startRedis(version: string): Promise<ServiceInstance> {
  // Check if already running
  const existingUrl = process.env.REDIS_URL;
  if (existingUrl) {
    console.log("[services] Using existing REDIS_URL from environment");
    return { name: "redis", url: existingUrl, port: 6379 };
  }

  const port = 6379;

  // Check if Redis is already running
  if (await isPortOpen(port)) {
    console.log("[services] Redis already running on port 6379");
    const url = `redis://localhost:${port}`;
    return { name: "redis", url, port };
  }

  // Check if Redis is installed
  const isInstalled = await commandExists("redis-server");

  if (!isInstalled) {
    console.log(`[services] Installing Redis ${version}...`);
    await installRedis(version);
  }

  // Start Redis
  console.log("[services] Starting Redis...");
  await startRedisService();

  // Wait for it to be ready
  await waitForPort(port, 15000);

  const url = `redis://localhost:${port}`;
  console.log(`[services] Redis ready: ${url}`);

  return { name: "redis", url, port };
}

async function installRedis(version: string): Promise<void> {
  const os = await detectOS();

  if (os === "debian" || os === "ubuntu") {
    await runCommand("apt-get update");
    await runCommand("apt-get install -y redis-server");
  } else if (os === "alpine") {
    await runCommand("apk add --no-cache redis");
  } else if (os === "macos") {
    await runCommand("brew install redis");
  } else {
    throw new Error(`Unsupported OS for Redis installation: ${os}`);
  }
}

async function startRedisService(): Promise<void> {
  const os = await detectOS();

  if (os === "debian" || os === "ubuntu") {
    await runCommand("service redis-server start || redis-server --daemonize yes");
  } else if (os === "alpine") {
    await runCommand("redis-server --daemonize yes");
  } else if (os === "macos") {
    await runCommand("brew services start redis");
  }
}

// =============================================================================
// Helpers
// =============================================================================

type OS = "debian" | "ubuntu" | "alpine" | "macos" | "unknown";

let cachedOS: OS | null = null;

async function detectOS(): Promise<OS> {
  if (cachedOS) return cachedOS;

  // Check for macOS
  if (process.platform === "darwin") {
    cachedOS = "macos";
    return cachedOS;
  }

  // Check for Linux distros
  try {
    const osRelease = await runCommandCapture("cat /etc/os-release 2>/dev/null || echo ''");

    if (osRelease.includes("ID=ubuntu")) {
      cachedOS = "ubuntu";
    } else if (osRelease.includes("ID=debian")) {
      cachedOS = "debian";
    } else if (osRelease.includes("ID=alpine")) {
      cachedOS = "alpine";
    } else {
      // Default to debian-like for most Linux
      cachedOS = "debian";
    }
  } catch {
    cachedOS = "unknown";
  }

  console.log(`[services] Detected OS: ${cachedOS}`);
  return cachedOS;
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await runCommandCapture(`which ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

async function isPortOpen(port: number): Promise<boolean> {
  const net = await import("net");

  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "localhost" });

    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });

    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function runCommand(command: string, ignoreErrors = false): Promise<void> {
  console.log(`[services] $ ${command}`);

  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      stdio: "inherit",
      env: { ...process.env },
    });

    child.on("close", (code) => {
      if (code === 0 || ignoreErrors) {
        resolve();
      } else {
        reject(new Error(`Command failed with code ${code}: ${command}`));
      }
    });

    child.on("error", (err) => {
      if (ignoreErrors) {
        resolve();
      } else {
        reject(err);
      }
    });
  });
}

function runCommandCapture(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Command failed: ${command}\n${stderr}`));
      }
    });

    child.on("error", reject);
  });
}
