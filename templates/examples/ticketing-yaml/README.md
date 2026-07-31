# Ticketing System Integration (YAML-based)

This example shows a declarative integration with a ticketing system using
**YAML Functions** instead of TypeScript.

## What are YAML Functions?

YAML Functions are declarative proxy definitions in the `functions/` directory.
They combine URL routing, request transformation, and response transformation in
a single file.

**Advantages:**

- No TypeScript/JavaScript required
- Purely declarative - easy to read and maintain
- Same routing conventions as TypeScript Functions
- Ideal for simple proxy scenarios

## Project Structure

```
ticketing-yaml/
├── deno.json
├── docker-compose.yml
├── .env.example
└── functions/
    ├── health.yml         # GET /health
    └── tickets/
        └── index.yml      # /tickets (all methods)
```

## YAML Function Format

```yaml
# Target URL (required)
target: "{{ env.TICKET_API_URL }}"

# Optional: Allowed methods (default: all)
methods: [GET, POST, PUT, DELETE]

# Optional: Timeout in ms (default: 30000)
timeout: 30000

# Request transformations
request:
  headers:
    set:
      authorization: "Bearer {{ env.TOKEN }}"
    add:
      x-request-id: "{{ context.requestId }}"
    remove:
      - x-internal
  url:
    prefix: "/api/v2"
    # or: removePrefix: "/external"
    # or: rewrite: "/new/path"

# Response transformations
response:
  headers:
    add:
      x-request-id: "{{ context.requestId }}"
    remove:
      - x-internal-debug
  # Optional:
  # statusCode:
  #     set: 200
```

## Available Template Variables

| Variable                  | Description          |
| ------------------------- | -------------------- |
| `{{ env.VARIABLE }}`      | Environment variable |
| `{{ context.requestId }}` | Request UUID         |
| `{{ context.startedAt }}` | ISO 8601 timestamp   |
| `{{ request.url }}`       | Request URL          |
| `{{ request.method }}`    | HTTP method          |
| `{{ request.body }}`      | Request body         |

## Quick Start

```bash
# Create configuration
cp .env.example .env
nano .env

# Start
docker-compose up -d

# Test
curl http://localhost:8080/health
curl http://localhost:8080/tickets
```

## Comparison: YAML vs TypeScript Functions

| Feature                  | YAML Function  | TypeScript Function |
| ------------------------ | -------------- | ------------------- |
| Proxy to backend         | ✅ Declarative | Manual with fetch() |
| Transform headers        | ✅ Built-in    | ✅ ctx.req.headers  |
| Transform URL            | ✅ Built-in    | ✅ ctx.req.url      |
| Complex logic            | ❌             | ✅ Full control     |
| Load data from DB        | ❌             | ✅                  |
| Multiple backend calls   | ❌             | ✅                  |
| Manipulate response body | Replace only   | ✅ JSON parsing     |

**Recommendation:**

- YAML Functions for simple proxy scenarios with header/URL transformation
- TypeScript Functions for complex logic, data processing, and multi-backend
  integrations

## Usage

Copy the YAML files to your project and adjust the environment variables.
