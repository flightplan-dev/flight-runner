# flight-runner

Agent runner for [Flightplan](https://flightplan.dev) missions. Runs inside sandboxes (Sprites) and executes coding tasks using [pi-mono](https://github.com/badlogic/pi-mono) SDK.

## Overview

`flight-runner` is a standalone Node.js application that:

1. Receives a prompt and configuration via environment variables
2. Creates a pi-mono agent session with coding tools
3. Runs the prompt and streams events back to the Flightplan Gateway via HTTP

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GATEWAY_URL` | URL of the Flightplan gateway (e.g., `https://flightplan.app`) |
| `GATEWAY_API_KEY` | Organization API key for webhook authentication |
| `MISSION_ID` | UUID of the mission being executed |
| `PROMPT` | The prompt/task to execute |
| `MODEL` | The LLM model to use (e.g., `claude-sonnet-4.5`, `gpt-4o`) |
| `LLM_API_KEY` | API key for the LLM provider (Anthropic, OpenAI) |
| `WORKSPACE` | Path to the workspace directory (cloned repo) |

## Models

Friendly model names are mapped to provider/model pairs:

| Friendly Name | Provider | Model ID |
|---------------|----------|----------|
| `claude-sonnet-4.5` | anthropic | claude-sonnet-4-5 |
| `claude-opus-4.5` | anthropic | claude-opus-4-5 |
| `claude-sonnet-4` | anthropic | claude-sonnet-4 |
| `claude-opus-4` | anthropic | claude-opus-4-0 |
| `gpt-4o` | openai | gpt-4o |
| `gpt-4.1` | openai | gpt-4.1 |

You can also use full `provider/model` format (e.g., `anthropic/claude-sonnet-4-5`).

## Tools

The agent uses pi-mono's built-in coding tools:

| Tool | Description |
|------|-------------|
| `read` | Read file contents |
| `bash` | Execute shell commands |
| `edit` | Replace exact text in a file |
| `write` | Write content to a file |

## Events

The agent streams these events back to the Gateway via `POST /api/missions/:id/events`:

| Event | Description |
|-------|-------------|
| `agent:start` | Agent started processing |
| `agent:end` | Agent finished (with token usage) |
| `agent:error` | Agent encountered an error |
| `message:start` | Assistant message started |
| `message:delta` | Text chunk from assistant |
| `message:end` | Assistant message completed |
| `tool:start` | Tool execution started |
| `tool:update` | Tool output streaming |
| `tool:end` | Tool execution completed |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run agent (requires env vars)
npm start

# Run setup script
npm run setup

# Type check
npm run typecheck
```

## Executables

This package provides two executables:

### `flight-runner`

The main agent runner. Executes LLM-powered coding tasks.

```bash
flight-runner
# or
node dist/index.js
```

Requires environment variables: `GATEWAY_URL`, `MISSION_ID`, `MODEL`, `LLM_API_KEY`, `WORKSPACE`

### `flightplan-setup`

Environment setup script. Runs before the agent to prepare the workspace.

```bash
flightplan-setup <workspace>
# or
node dist/setup/index.js <workspace>
```

**What it does:**
1. Reads `flightplan.yml` from workspace
2. Installs and starts services directly (Postgres, Redis - no Docker)
3. Copies env files, injects secrets
4. Runs setup commands
5. Starts dev server (if configured)
6. Waits for port to be ready
7. Writes `.flightplan-status.json` with service URLs, etc.

**Environment variables:**
| Variable | Description |
|----------|-------------|
| `WORKSPACE` | Path to workspace (alternative to CLI arg) |
| `SECRETS_JSON` | JSON object of org secrets |
| `KEEP_ALIVE` | Set to "true" to keep running for dev server |
| `POSTGRES_URL` | If set, uses existing Postgres instead of installing |
| `REDIS_URL` | If set, uses existing Redis instead of installing |

**Supported services:**
- `postgres:16` → Installs PostgreSQL, creates `flightplan` database
- `redis:7` → Installs Redis

Services are installed via apt-get (Debian/Ubuntu), apk (Alpine), or brew (macOS).

**Example:**
```bash
# Basic setup
flightplan-setup /path/to/project

# With secrets
SECRETS_JSON='{"STRIPE_KEY":"sk_test_xxx"}' flightplan-setup ./myapp

# Keep alive for dev server
KEEP_ALIVE=true flightplan-setup ./myapp

# Use existing database (skip installation)
POSTGRES_URL='postgres://user:pass@localhost/mydb' flightplan-setup ./myapp
```

## Usage in Sandbox

The Flightplan Gateway executes this runner inside a Sprite sandbox:

```bash
# Gateway calls this via Sprites exec API
node /opt/flight-runner/dist/index.js
```

The runner is cloned and built during sandbox setup:

```bash
git clone https://github.com/flightplan-dev/flight-runner /opt/flight-runner
cd /opt/flight-runner && npm install && npm run build
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Sprite Sandbox                          │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  flight-runner                                           │   │
│  │                                                          │   │
│  │  ┌──────────────────────────────────────────────────┐   │   │
│  │  │  pi-mono SDK                                      │   │   │
│  │  │  - createAgentSession()                          │   │   │
│  │  │  - SessionManager.inMemory()                     │   │   │
│  │  │  - createCodingTools(workspace)                  │   │   │
│  │  └──────────────────────────────────────────────────┘   │   │
│  │       │                                                 │   │
│  │       │ session.subscribe(event => ...)                │   │
│  │       ▼                                                 │   │
│  │  ┌──────────────────────────────────────────────────┐  │   │
│  │  │  Event Reporter                                   │  │   │
│  │  │  POST /api/missions/:id/events                    │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│  /workspace (cloned repo)    │                                  │
└──────────────────────────────│──────────────────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  Flightplan Gateway │
                    │  (Heroku)           │
                    └─────────────────────┘
```

## Configuration: flightplan.yml

Projects can include a `flightplan.yml` file to configure infrastructure that the LLM can't discover on its own. The philosophy is:

- **Explicit**: Services (DB, Redis), env vars, secrets, ports
- **Implicit**: Test commands, build steps - LLM figures these out

### Schema

```yaml
# Services to spin up (we create them, inject connection URLs)
services:
  - postgres:16              # → POSTGRES_URL env var
  - postgres:16-postgis      # → with PostGIS extension
  - postgres:16-pgvector     # → with pgvector extension
  - redis:7                  # → REDIS_URL env var

# Environment configuration
env:
  from_file: .env.example          # Copy this as base
  secrets:                          # Pull from Gateway (org secrets)
    - STRIPE_API_KEY
    - OPENAI_API_KEY
  set:                              # Static values / interpolations
    NODE_ENV: development
    DATABASE_URL: ${POSTGRES_URL}   # Interpolate from service

# Setup commands (run BEFORE dev server, order matters)
setup:
  - npm install
  - npx prisma generate
  - npx prisma migrate deploy

# Dev server (runs as background process)
dev_server:
  command: npm run dev
  port: 3000
  timeout: 60                       # Max seconds to wait for port

# Help LLM find project conventions (optional)
docs: CONTRIBUTING.md

# Or inline hints (optional)
hints:
  - "Unit tests: yarn test:unit (vitest)"
  - "Integration tests: yarn test:integration (mocha, needs DB)"
```

### Startup Flow

1. Parse `flightplan.yml`
2. Spin up services (Postgres, Redis, etc.)
3. Copy env file (if `from_file` specified)
4. Inject secrets and resolved env vars
5. Run setup commands in order
6. Start dev server (background process)
7. Wait for port to be open
8. Start LLM agent

### No Config?

If no `flightplan.yml` exists, the LLM figures everything out by reading the codebase (package.json, README, etc.). Services won't be available.

### Examples

See `examples/` directory:
- `flightplan-minimal.yml` - Simple project, just setup
- `flightplan-postgres.yml` - Node.js + PostgreSQL
- `flightplan-postgis.yml` - PostgreSQL + PostGIS (geospatial)
- `flightplan-pgvector.yml` - PostgreSQL + pgvector (AI embeddings)
- `flightplan-python.yml` - Django + Postgres + Redis
- `flightplan-multitest.yml` - Project with multiple test suites

## License

Private - Flightplan
