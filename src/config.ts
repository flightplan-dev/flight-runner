/**
 * Flightplan Config Parser
 *
 * Parses and validates flightplan.yml configuration files.
 * Focuses on infrastructure (services, env) that the LLM can't discover on its own.
 * Test commands, build steps, etc. are left for the LLM to figure out.
 */

import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { readFile, access } from "fs/promises";
import { join } from "path";
import * as net from "net";

// =============================================================================
// Schema Definition
// =============================================================================

/**
 * Service definition - databases, caches, etc.
 * Format: "name:version" or just "name"
 * Examples: "postgres:16", "redis:7", "elasticsearch:8"
 */
const ServiceSchema = z.string().refine(
  (s) => /^[a-z0-9-]+(:[\w.-]+)?$/.test(s),
  { message: "Invalid service format. Use 'name' or 'name:version'" }
);

/**
 * Environment variable value.
 * Can be static values or interpolations:
 * - Static: "test"
 * - From service: "${POSTGRES_URL}"
 *
 * Note: YAML may parse numbers/booleans, so we coerce to string.
 */
const EnvValueSchema = z
  .union([z.string(), z.number(), z.boolean()])
  .transform(String);

/**
 * Environment configuration.
 * Handles env files, secrets, and static values.
 */
const EnvConfigSchema = z.object({
  // Copy an env file as base (e.g., .env.example → .env)
  from_file: z.string().optional(),

  // Secrets to pull from Gateway (org-level secrets)
  secrets: z.array(z.string()).optional(),

  // Static env vars or interpolations
  set: z.record(z.string(), EnvValueSchema).optional(),
});

/**
 * Dev server configuration.
 * Runs as a background process before the LLM agent starts.
 * Readiness is determined by port being open.
 */
const DevServerSchema = z.object({
  command: z.string(),
  port: z.number().min(1).max(65535).optional().default(8080),
  // Max seconds to wait for port to open (default 60)
  timeout: z.number().optional().default(60),
});

/**
 * Complete flightplan.yml configuration.
 *
 * Philosophy:
 * - Explicit: Infrastructure the LLM can't discover (services, env, ports)
 * - Implicit: Commands the LLM can figure out (test, build, etc.)
 */
export const FlightplanConfigSchema = z.object({
  // Services to spin up (postgres, redis, etc.)
  services: z.array(ServiceSchema).optional(),

  // Environment configuration
  env: EnvConfigSchema.optional(),

  // Setup commands run BEFORE dev server starts (ordered)
  // These are explicit because order matters and some aren't discoverable
  setup: z.array(z.string()).optional(),

  // Dev server configuration
  dev_server: DevServerSchema.optional(),

  // Optional: point LLM to docs for conventions, test commands, etc.
  // Can be a single file path or array of paths
  docs: z.union([z.string(), z.array(z.string())]).optional(),
  // Optional: inline hints for the LLM (natural language)
  hints: z.array(z.string()).optional(),
});

export type FlightplanConfig = z.infer<typeof FlightplanConfigSchema>;

// =============================================================================
// Service Definitions
// =============================================================================

export interface ServiceInfo {
  name: string;
  version: string;
  envVar: string; // Environment variable this service provides (e.g., POSTGRES_URL)
  extensions?: string[]; // Extensions to enable (e.g., ["postgis", "pgvector"])
}

/**
 * Known services and their default configurations.
 */
const SERVICE_DEFINITIONS: Record<
  string,
  { envVar: string; defaultVersion: string }
> = {
  postgres: { envVar: "POSTGRES_URL", defaultVersion: "16" },
  postgresql: { envVar: "POSTGRES_URL", defaultVersion: "16" },
  mysql: { envVar: "MYSQL_URL", defaultVersion: "8" },
  redis: { envVar: "REDIS_URL", defaultVersion: "7" },
  elasticsearch: { envVar: "ELASTICSEARCH_URL", defaultVersion: "8" },
  mongodb: { envVar: "MONGODB_URL", defaultVersion: "7" },
  rabbitmq: { envVar: "RABBITMQ_URL", defaultVersion: "3" },
  memcached: { envVar: "MEMCACHED_URL", defaultVersion: "1" },
};

/**
 * Parse a service string into structured info.
 * 
 * Formats supported:
 *   - "postgres:16"           → Postgres 16
 *   - "postgres:16-postgis"   → Postgres 16 with PostGIS
 *   - "postgres:16-postgis-pgvector" → Postgres 16 with PostGIS and pgvector
 */
export function parseService(service: string): ServiceInfo {
  const parts = service.split(":");
  const name = parts[0].toLowerCase();
  let versionPart = parts[1] || null;

  // Parse extensions from version string (e.g., "16-postgis-pgvector")
  let version: string | null = null;
  let extensions: string[] = [];

  if (versionPart) {
    const versionParts = versionPart.split("-");
    version = versionParts[0]; // First part is always version
    extensions = versionParts.slice(1); // Rest are extensions
  }

  const definition = SERVICE_DEFINITIONS[name];

  if (!definition) {
    throw new Error(`Unknown service: ${name}`);
  }

  return {
    name,
    version: version || definition.defaultVersion,
    envVar: definition.envVar,
    extensions: extensions.length > 0 ? extensions : undefined,
  };
}

// =============================================================================
// Environment Variable Interpolation
// =============================================================================

export interface InterpolationContext {
  // Service URLs (e.g., { POSTGRES_URL: "postgres://..." })
  services: Record<string, string>;
  // Organization secrets from Gateway
  secrets: Record<string, string>;
  // Runtime variables (e.g., { APP_URL: "https://mission-xxx.sprites.app" })
  runtime?: Record<string, string>;
}

/**
 * Interpolate environment variable values.
 * Supports:
 *   - ${VAR_NAME} for services (e.g., ${POSTGRES_URL})
 *   - ${secrets.KEY} for org secrets
 *   - ${APP_URL} for the sprite's public URL (runtime variable)
 */
export function interpolateEnvValue(
  value: string,
  context: InterpolationContext
): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, expr) => {
    // Handle secrets.KEY
    if (expr.startsWith("secrets.")) {
      const key = expr.slice(8);
      if (key in context.secrets) {
        return context.secrets[key];
      }
      console.warn(`[Config] Secret not found: ${key}`);
      return match;
    }

    // Handle runtime variables (e.g., APP_URL)
    if (context.runtime && expr in context.runtime) {
      return context.runtime[expr];
    }

    // Handle service env vars (e.g., POSTGRES_URL)
    if (expr in context.services) {
      return context.services[expr];
    }

    console.warn(`[Config] Unknown interpolation: ${expr}`);
    return match;
  });
}

// =============================================================================
// Config Loading
// =============================================================================

export interface LoadedConfig {
  config: FlightplanConfig;
  source: "env" | "flightplan.yml" | "none";
  services: ServiceInfo[];
  resolvedEnv: Record<string, string>;
}

/**
 * Load configuration from flightplan.yml.
 * Returns minimal config if no file exists (LLM figures out the rest).
 */
export async function loadConfig(
  workspacePath: string,
  context: InterpolationContext = { services: {}, secrets: {} }
): Promise<LoadedConfig> {
  // Priority:
  // 1. FLIGHTPLAN_CONFIG env var (YAML string from Gateway)
  // 2. flightplan.yml in workspace
  // 3. No config (LLM figures it out)

  let content: string | null = null;
  let source: "env" | "flightplan.yml" | "none" = "none";

  // Check for config from environment (Gateway-provided)
  if (process.env.FLIGHTPLAN_CONFIG) {
    console.log("[Config] Using FLIGHTPLAN_CONFIG from environment");
    content = process.env.FLIGHTPLAN_CONFIG;
    source = "env";
  }

  // Fall back to flightplan.yml in workspace
  if (!content) {
    const configPath = join(workspacePath, "flightplan.yml");
    if (await fileExists(configPath)) {
      console.log("[Config] Found flightplan.yml");
      content = await readFile(configPath, "utf-8");
      source = "flightplan.yml";
    }
  }

  // Parse config if we have content
  if (content) {
    const rawConfig = parseYaml(content);
    const parseResult = FlightplanConfigSchema.safeParse(rawConfig);

    if (!parseResult.success) {
      console.error("[Config] Invalid flightplan.yml:");
      for (const error of parseResult.error.errors) {
        console.error(`  - ${error.path.join(".")}: ${error.message}`);
      }
      throw new Error("Invalid flightplan.yml configuration");
    }

    const config = parseResult.data;

    // Parse services
    const services = (config.services || []).map(parseService);

    // Build service env context for interpolation
    const serviceEnvContext = { ...context.services };
    for (const service of services) {
      // Only set placeholder if not already provided in context
      if (!(service.envVar in serviceEnvContext)) {
        serviceEnvContext[service.envVar] = `{{${service.name.toUpperCase()}_URL}}`;
      }
    }

    // Resolve environment variables
    const resolvedEnv: Record<string, string> = {};

    // Start with values from set
    for (const [key, value] of Object.entries(config.env?.set || {})) {
      resolvedEnv[key] = interpolateEnvValue(value, {
        services: serviceEnvContext,
        secrets: context.secrets,
      });
    }

    // Add secrets (if requested)
    for (const secretKey of config.env?.secrets || []) {
      if (secretKey in context.secrets) {
        resolvedEnv[secretKey] = context.secrets[secretKey];
      } else {
        console.warn(`[Config] Requested secret not provided: ${secretKey}`);
      }
    }

    return {
      config,
      source,
      services,
      resolvedEnv,
    };
  }

  // No config - return empty config, LLM figures it out
  console.log("[Config] No config found, LLM will discover project setup");

  return {
    config: {},
    source: "none",
    services: [],
    resolvedEnv: {},
  };
}

// =============================================================================
// Helpers
// =============================================================================

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get setup commands from config.
 */
export function getSetupCommands(config: FlightplanConfig): string[] {
  return config.setup || [];
}

/**
 * Get dev server config if defined.
 */
export function getDevServerConfig(
  config: FlightplanConfig
): { command: string; port: number; timeout: number } | null {
  if (!config.dev_server) return null;

  return {
    command: config.dev_server.command,
    port: config.dev_server.port,
    timeout: config.dev_server.timeout ?? 60,
  };
}

/**
 * Get the docs file paths (for LLM to read).
 * Normalizes single string to array.
 */
export function getDocsPaths(config: FlightplanConfig): string[] {
  if (!config.docs) return [];
  return Array.isArray(config.docs) ? config.docs : [config.docs];
}

/**
 * Get hints for the LLM.
 */
export function getHints(config: FlightplanConfig): string[] {
  return config.hints || [];
}

/**
 * Get the env file to copy (e.g., .env.example).
 */
export function getEnvFromFile(config: FlightplanConfig): string | null {
  return config.env?.from_file || null;
}

// =============================================================================
// Dev Server Management
// =============================================================================

/**
 * Wait for a port to be open (accepting connections).
 */
export async function waitForPort(
  port: number,
  timeoutMs: number = 60000
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await checkPort(port);
      console.log(`[Config] Port ${port} is ready`);
      return;
    } catch {
      // Port not ready yet, wait and retry
      await sleep(500);
    }
  }

  throw new Error(`Port ${port} not ready after ${timeoutMs}ms`);
}

/**
 * Check if a port is accepting connections.
 */
function checkPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: "localhost" });

    socket.on("connect", () => {
      socket.destroy();
      resolve();
    });

    socket.on("error", (err) => {
      socket.destroy();
      reject(err);
    });

    // Timeout for individual connection attempt
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error("Connection timeout"));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
