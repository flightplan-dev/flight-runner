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
| `GATEWAY_SECRET` | Secret for authenticating with the gateway |
| `MISSION_ID` | UUID of the mission being executed |
| `PROMPT` | The prompt/task to execute |
| `MODEL` | The LLM model to use (e.g., `claude-sonnet-4`, `gpt-4o`) |
| `LLM_API_KEY` | API key for the LLM provider |
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

## License

Private - Flightplan
