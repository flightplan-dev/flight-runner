# TODO: Implement `flightplan.yml` Support

## Overview: YAML → Zod Validation

The approach is to use a YAML parser to convert the file to a JavaScript object, then validate with Zod:

```typescript
import { parse } from 'yaml';
import { z } from 'zod';

// 1. Define Zod schema
const FlightplanSchema = z.object({
  services: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  hooks: z.object({
    setup: z.array(z.string()).optional(),
    pre_test: z.array(z.string()).optional(),
    test: z.union([
      z.string(),
      z.object({
        command: z.string(),
        timeout: z.number().optional(),
        retry: z.number().optional(),
      })
    ]).optional(),
    post_merge: z.array(z.string()).optional(),
  }).optional(),
  dev_server: z.object({
    command: z.string(),
    port: z.number(),
    wait_for: z.string().optional(),
  }).optional(),
  ignore: z.array(z.string()).optional(),
});

type Flightplan = z.infer<typeof FlightplanSchema>;

// 2. Parse and validate
function loadFlightplan(yamlContent: string): Flightplan {
  const parsed = parse(yamlContent);  // YAML → JS object
  return FlightplanSchema.parse(parsed);  // Validate with Zod
}
```

**Dependencies:**
- `yaml` - YAML parser (or `js-yaml`)
- `zod` - Schema validation

---

## 1. Schema Definition
- [ ] Create a Zod schema for `flightplan.yml` validation
- [ ] Define types for:
  - [ ] `services` (array of service strings like `postgres:16`, `redis:7`, `elasticsearch:8`)
  - [ ] `env` (key-value pairs with string interpolation support: `${POSTGRES_URL}`, `${secrets.API_KEY}`)
  - [ ] `hooks` object with:
    - [ ] `setup` (array of commands)
    - [ ] `pre_test` (array of commands)
    - [ ] `test` (command string OR object with `command`, `timeout`, `retry`)
    - [ ] `post_merge` (array of commands)
  - [ ] `dev_server` object (`command`, `port`, `wait_for`)
  - [ ] `ignore` (array of glob patterns)

## 2. Parser
- [ ] Create a YAML parser that reads `flightplan.yml` from repo root
- [ ] Implement environment variable interpolation:
  - [ ] `${SERVICE_URL}` - from running services
  - [ ] `${secrets.SECRET_NAME}` - from org-level secrets store
- [ ] Add validation errors with helpful messages

## 3. Auto-Detection Fallbacks
- [ ] Implement fallback detection when no `flightplan.yml` exists:
  - [ ] `package.json` + `yarn.lock` → `yarn install`
  - [ ] `package.json` + `package-lock.json` → `npm install`
  - [ ] `Gemfile` → `bundle install`
  - [ ] `requirements.txt` → `pip install -r requirements.txt`
  - [ ] `go.mod` → `go mod download`
- [ ] Auto-detect test commands (e.g., `npm test`, `yarn test`, `pytest`, `go test`)

## 4. Services Integration
- [ ] Define service manifest (which services are supported)
- [ ] Implement service startup logic for Sprites:
  - [ ] Postgres (inject `DATABASE_URL` / `POSTGRES_URL`)
  - [ ] Redis (inject `REDIS_URL`)
  - [ ] Elasticsearch (inject `ELASTICSEARCH_URL`)
- [ ] Handle service readiness checks before running setup hooks

## 5. Hook Execution
- [ ] Implement hook runner with:
  - [ ] Sequential command execution
  - [ ] Error handling (fail fast vs. continue)
  - [ ] Timeout support per command
  - [ ] Streaming output back to Gateway
- [ ] Integrate hooks into mission lifecycle:
  - [ ] Run `setup` after repo clone
  - [ ] Run `pre_test` before each test execution
  - [ ] Run `test` when agent needs to verify changes
  - [ ] Run `post_merge` via GitHub webhook after PR merge

## 6. Dev Server Support
- [ ] Implement dev server startup from `dev_server` config
- [ ] Wait for readiness string in stdout (`wait_for`)
- [ ] Expose port for browser-based debugging
- [ ] Handle graceful shutdown

## 7. Ignore Patterns
- [ ] Parse `ignore` patterns
- [ ] Pass ignore patterns to agent context (reduce noise in file listings)
- [ ] Integrate with `glob` tool to respect ignore patterns

## 8. Secrets Integration
- [ ] Create secrets storage in org settings (encrypted)
- [ ] Implement `${secrets.NAME}` interpolation at mission start
- [ ] Never persist decrypted secrets to disk in Sprite

## 9. Testing
- [ ] Unit tests for schema validation
- [ ] Unit tests for auto-detection logic
- [ ] Unit tests for variable interpolation
- [ ] Integration test with sample `flightplan.yml` files

## 10. Documentation
- [ ] Document `flightplan.yml` format for users
- [ ] Provide example configs for common stacks (Node, Python, Go, Ruby)
- [ ] Document supported services and their injected env vars
