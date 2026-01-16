# flight-runner

Agent runner for [Flightplan](https://flightplan.dev) missions. Runs inside sandboxes (Sprites) and executes coding tasks using LLM APIs.

## Overview

`flight-runner` is a standalone Node.js application that:

1. Receives a prompt and configuration via environment variables
2. Runs an agentic loop using Claude API with coding tools
3. Streams events back to the Flightplan Gateway via HTTP

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GATEWAY_URL` | URL of the Flightplan gateway (e.g., `https://flightplan.app`) |
| `GATEWAY_SECRET` | Secret for authenticating with the gateway |
| `MISSION_ID` | UUID of the mission being executed |
| `PROMPT` | The prompt/task to execute |
| `MODEL` | The LLM model to use (e.g., `claude-sonnet-4-20250514`) |
| `LLM_API_KEY` | API key for the LLM provider (Anthropic) |
| `WORKSPACE` | Path to the workspace directory (cloned repo) |

## Tools

The agent has access to these tools:

| Tool | Description |
|------|-------------|
| `read` | Read file contents with optional offset/limit |
| `write` | Write content to a file |
| `edit` | Replace exact text in a file |
| `bash` | Execute shell commands |
| `glob` | Find files matching a pattern |

## Events

The agent streams these events back to the Gateway:

| Event | Description |
|-------|-------------|
| `agent:start` | Agent started processing |
| `agent:end` | Agent finished (with token usage) |
| `agent:error` | Agent encountered an error |
| `message:start` | Assistant message started |
| `message:delta` | Text chunk from assistant |
| `message:end` | Assistant message completed |
| `tool:start` | Tool execution started |
| `tool:end` | Tool execution completed |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run (requires env vars)
npm start

# Type check
npm run typecheck
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
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │   │
│  │  │  Agent   │──│  Claude  │  │  Tools               │  │   │
│  │  │  Loop    │  │  API     │  │  - read/write/edit   │  │   │
│  │  │          │──│          │──│  - bash              │  │   │
│  │  └──────────┘  └──────────┘  └──────────────────────┘  │   │
│  │       │                                                 │   │
│  │       │ HTTP POST                                       │   │
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

## License

Private - Flightplan
