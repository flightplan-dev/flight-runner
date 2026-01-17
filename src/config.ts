/**
 * Flightplan Config Parser
 *
 * Parses and validates flightplan.yml configuration files.
 * Also handles auto-detection of common project patterns as fallback.
 */

import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { readFile, access } from "fs/promises";
import { join } from "path";

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
 * Environment variable definition.
 * Can be static values or interpolations:
 * - Static: "test"
 * - From service: "${POSTGRES_URL}"
 * - From secrets: "${secrets.API_KEY}"
 * 
 * Note: YAML may parse numbers/booleans, so we coerce to string.
 */
const EnvValueSchema = z.union([z.string(), z.number(), z.boolean()]).transform(String);

/**
 * Test command configuration.
 * Can be a simple string or detailed config.
 */
const TestCommandSchema = z.union([
  z.string(), // Simple: "npm test"
  z.object({
    command: z.string(),
    timeout: z.number().optional().default(300), // seconds
    retry: z.number().optional().default(0),
  }),
]);

/**
 * Dev server readiness check configuration.
 * Used to determine when the server is ready to accept requests.
 */
const ReadyCheckSchema = z.object({
  // URL path to poll (e.g., "/health", "/api/ready")
  path: z.string().default("/"),
  // Expected HTTP status code (default 200)
  status: z.number().default(200),
  // How often to poll in milliseconds
  interval: z.number().default(1000),
});

/**
 * Dev server configuration for browser-based debugging.
 * 
 * Readiness detection (in order of precedence):
 * 1. wait_for - Watch stdout for a specific string (most reliable)
 * 2. ready_check - Poll an HTTP endpoint until it returns expected status
 * 3. Neither - Just wait for `timeout` seconds and hope for the best
 */
const DevServerSchema = z.object({
  command: z.string(),
  port: z.number().min(1).max(65535),
  // Watch stdout for this string to determine readiness
  wait_for: z.string().optional(),
  // Poll an HTTP endpoint to determine readiness
  ready_check: ReadyCheckSchema.optional(),
  // Max seconds to wait for startup (default 60)
  timeout: z.number().optional().default(60),
});

/**
 * Lifecycle hooks - commands run at specific events.
 */
const HooksSchema = z.object({
  setup: z.array(z.string()).optional(), // After cloning
  pre_test: z.array(z.string()).optional(), // Before each test run
  test: TestCommandSchema.optional(), // How to run tests
  post_merge: z.array(z.string()).optional(), // After PR merged
});

/**
 * Complete flightplan.yml configuration.
 */
export const FlightplanConfigSchema = z.object({
  // Services the app depends on
  services: z.array(ServiceSchema).optional(),

  // Environment variables
  env: z.record(z.string(), EnvValueSchema).optional(),

  // Lifecycle hooks
  hooks: HooksSchema.optional(),

  // Dev server configuration
  dev_server: DevServerSchema.optional(),

  // File patterns to ignore in agent context
  ignore: z.array(z.string()).optional(),
});

export type FlightplanConfig = z.infer<typeof FlightplanConfigSchema>;

// =============================================================================
// Service Definitions
// =============================================================================

export interface ServiceInfo {
  name: string;
  version: string | null;
  envVars: Record<string, string>; // Environment vars this service provides
}

/**
 * Known services and their default environment variable mappings.
 */
const SERVICE_DEFINITIONS: Record<string, { envVar: string; defaultVersion: string }> = {
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
 */
export function parseService(service: string): ServiceInfo {
  const parts = service.split(":");
  const name = parts[0].toLowerCase();
  const version = parts[1] || null;

  const definition = SERVICE_DEFINITIONS[name];
  const envVars: Record<string, string> = {};

  if (definition) {
    // Service will inject its URL as this env var
    // Actual URL is determined by the sandbox orchestrator
    envVars[definition.envVar] = `{{${name.toUpperCase()}_URL}}`;
  }

  return {
    name,
    version: version || definition?.defaultVersion || null,
    envVars,
  };
}

// =============================================================================
// Environment Variable Interpolation
// =============================================================================

export interface InterpolationContext {
  services: Record<string, string>; // Service env vars (e.g., POSTGRES_URL)
  secrets: Record<string, string>; // Organization secrets
}

/**
 * Interpolate environment variable values.
 * Supports:
 * - ${SERVICE_VAR} - from services
 * - ${secrets.KEY} - from org secrets
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
      return match; // Keep original if not found
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
// Auto-Detection (Fallback)
// =============================================================================

export interface DetectedSetup {
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | null;
  installCommand: string | null;
  testCommand: string | null;
  devCommand: string | null;
  language: "javascript" | "typescript" | "python" | "ruby" | "go" | "rust" | null;
}

/**
 * Auto-detect project setup from common patterns.
 * Used as fallback when no flightplan.yml exists.
 */
export async function detectProjectSetup(workspacePath: string): Promise<DetectedSetup> {
  const result: DetectedSetup = {
    packageManager: null,
    installCommand: null,
    testCommand: null,
    devCommand: null,
    language: null,
  };

  // Check for Node.js projects
  const hasPackageJson = await fileExists(join(workspacePath, "package.json"));
  if (hasPackageJson) {
    result.language = "javascript";

    // Detect package manager
    const hasYarnLock = await fileExists(join(workspacePath, "yarn.lock"));
    const hasPnpmLock = await fileExists(join(workspacePath, "pnpm-lock.yaml"));
    const hasBunLock = await fileExists(join(workspacePath, "bun.lockb"));

    if (hasBunLock) {
      result.packageManager = "bun";
      result.installCommand = "bun install";
    } else if (hasPnpmLock) {
      result.packageManager = "pnpm";
      result.installCommand = "pnpm install";
    } else if (hasYarnLock) {
      result.packageManager = "yarn";
      result.installCommand = "yarn install";
    } else {
      result.packageManager = "npm";
      result.installCommand = "npm install";
    }

    // Try to detect scripts from package.json
    try {
      const pkgJson = JSON.parse(await readFile(join(workspacePath, "package.json"), "utf-8"));
      const scripts = pkgJson.scripts || {};

      if (scripts.test) {
        result.testCommand = `${result.packageManager} test`;
      }
      if (scripts.dev) {
        result.devCommand = `${result.packageManager} run dev`;
      } else if (scripts.start) {
        result.devCommand = `${result.packageManager} start`;
      }

      // Check if TypeScript
      if (pkgJson.devDependencies?.typescript || pkgJson.dependencies?.typescript) {
        result.language = "typescript";
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check for Python projects
  const hasRequirementsTxt = await fileExists(join(workspacePath, "requirements.txt"));
  const hasPyproject = await fileExists(join(workspacePath, "pyproject.toml"));
  if (hasRequirementsTxt || hasPyproject) {
    result.language = "python";
    if (hasPyproject) {
      result.installCommand = "pip install -e .";
    } else {
      result.installCommand = "pip install -r requirements.txt";
    }
    result.testCommand = "pytest";
  }

  // Check for Ruby projects
  const hasGemfile = await fileExists(join(workspacePath, "Gemfile"));
  if (hasGemfile) {
    result.language = "ruby";
    result.installCommand = "bundle install";
    result.testCommand = "bundle exec rspec";
  }

  // Check for Go projects
  const hasGoMod = await fileExists(join(workspacePath, "go.mod"));
  if (hasGoMod) {
    result.language = "go";
    result.installCommand = "go mod download";
    result.testCommand = "go test ./...";
  }

  // Check for Rust projects
  const hasCargoToml = await fileExists(join(workspacePath, "Cargo.toml"));
  if (hasCargoToml) {
    result.language = "rust";
    result.installCommand = "cargo build";
    result.testCommand = "cargo test";
  }

  return result;
}

// =============================================================================
// Config Loading
// =============================================================================

export interface LoadedConfig {
  config: FlightplanConfig;
  source: "flightplan.yml" | "auto-detected";
  services: ServiceInfo[];
  resolvedEnv: Record<string, string>;
}

/**
 * Load configuration from flightplan.yml or auto-detect.
 */
export async function loadConfig(
  workspacePath: string,
  context: InterpolationContext = { services: {}, secrets: {} }
): Promise<LoadedConfig> {
  const configPath = join(workspacePath, "flightplan.yml");

  // Try to load flightplan.yml
  if (await fileExists(configPath)) {
    console.log("[Config] Found flightplan.yml");

    const content = await readFile(configPath, "utf-8");
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

    // Build service env context
    const serviceEnvContext = { ...context.services };
    for (const service of services) {
      Object.assign(serviceEnvContext, service.envVars);
    }

    // Resolve environment variables
    const resolvedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env || {})) {
      resolvedEnv[key] = interpolateEnvValue(value, {
        services: serviceEnvContext,
        secrets: context.secrets,
      });
    }

    return {
      config,
      source: "flightplan.yml",
      services,
      resolvedEnv,
    };
  }

  // Fall back to auto-detection
  console.log("[Config] No flightplan.yml found, auto-detecting project setup");

  const detected = await detectProjectSetup(workspacePath);
  console.log("[Config] Auto-detected:", detected);

  // Build a synthetic config from auto-detection
  const config: FlightplanConfig = {
    hooks: {},
  };

  if (detected.installCommand) {
    config.hooks!.setup = [detected.installCommand];
  }

  if (detected.testCommand) {
    config.hooks!.test = detected.testCommand;
  }

  return {
    config,
    source: "auto-detected",
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

// =============================================================================
// Test Command Helpers
// =============================================================================

export interface TestConfig {
  command: string;
  timeout: number;
  retry: number;
}

/**
 * Normalize test configuration to a standard format.
 */
export function getTestConfig(config: FlightplanConfig): TestConfig | null {
  const test = config.hooks?.test;

  if (!test) {
    return null;
  }

  if (typeof test === "string") {
    return {
      command: test,
      timeout: 300,
      retry: 0,
    };
  }

  return {
    command: test.command,
    timeout: test.timeout ?? 300,
    retry: test.retry ?? 0,
  };
}

/**
 * Get the setup commands from config.
 */
export function getSetupCommands(config: FlightplanConfig): string[] {
  return config.hooks?.setup || [];
}

/**
 * Get the pre-test commands from config.
 */
export function getPreTestCommands(config: FlightplanConfig): string[] {
  return config.hooks?.pre_test || [];
}

/**
 * Get dev server config if defined.
 */
export function getDevServerConfig(config: FlightplanConfig): FlightplanConfig["dev_server"] {
  return config.dev_server;
}

/**
 * Get ignore patterns for agent context.
 */
export function getIgnorePatterns(config: FlightplanConfig): string[] {
  // Default patterns always ignored
  const defaults = ["node_modules/", ".git/", "dist/", "build/", "*.log"];

  const custom = config.ignore || [];

  // Dedupe
  return Array.from(new Set([...defaults, ...custom]));
}

// =============================================================================
// Dev Server Helpers
// =============================================================================

export interface DevServerConfig {
  command: string;
  port: number;
  timeout: number;
  readiness: 
    | { type: "wait_for"; pattern: string }
    | { type: "ready_check"; path: string; status: number; interval: number }
    | { type: "timeout" }; // Just wait for timeout
}

/**
 * Get normalized dev server configuration with readiness strategy.
 */
export function getDevServer(config: FlightplanConfig): DevServerConfig | null {
  const ds = config.dev_server;
  if (!ds) return null;

  let readiness: DevServerConfig["readiness"];

  if (ds.wait_for) {
    readiness = { type: "wait_for", pattern: ds.wait_for };
  } else if (ds.ready_check) {
    readiness = {
      type: "ready_check",
      path: ds.ready_check.path,
      status: ds.ready_check.status,
      interval: ds.ready_check.interval,
    };
  } else {
    readiness = { type: "timeout" };
  }

  return {
    command: ds.command,
    port: ds.port,
    timeout: ds.timeout ?? 60,
    readiness,
  };
}
