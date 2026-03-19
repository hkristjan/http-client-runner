# http-client-runner


[![npm version](https://img.shields.io/npm/v/http-client-runner.svg)](https://www.npmjs.com/package/http-client-runner)
[![license](https://img.shields.io/npm/l/http-client-runner.svg)](https://github.com/hkristjan/http-client-runner/blob/main/LICENSE)

Execute JetBrains-style `.http` files programmatically with axios — supports request chaining, JS handlers, variables, imports, environments, and response caching.

Use it as a **library** in your Node.js/TypeScript code, or as a **CLI** to run `.http` files directly from the terminal.

## Installation

```bash
npm install http-client-runner
```

Global install (for CLI usage):

```bash
npm install -g http-client-runner
```

## Quick Start

```ts
import { runFile } from 'http-client-runner';

const { results, summary } = await runFile('./api-tests.http', {
  environment: 'development',
  verbose: true,
});

console.log(summary);
// { totalRequests: 3, executedRequests: 3, passedTests: 5, failedTests: 0, ... }
```

CommonJS is also supported:

```js
const { runFile } = require('http-client-runner');
```

## CLI

Run `.http` files directly from the terminal:

```bash
http-client-runner api-tests.http --env development --verbose
```

**Options:**

| Flag | Description |
|---|---|
| `--env, -e <name>` | Environment name (from `http-client.env.json`) |
| `--var, -v <key=value>` | Set a variable (repeatable) |
| `--verbose` | Print request/response details |
| `--help, -h` | Show help |

**Examples:**

```bash
# Run with an environment
http-client-runner api.http --env staging

# Pass variables
http-client-runner tests.http -v host=https://api.example.com -v token=abc123

# Run multiple files sequentially (state carries across files)
http-client-runner auth.http api-tests.http --verbose

# Compact output (no --verbose)
http-client-runner api.http -v host=https://httpbin.org
#   ✓ Login — 200
#   ✓ Get Users — 200
#     ✓ Status is 200
#     ✓ Returns array
#   Requests: 2 | Tests: 2 passed, 0 failed
```

## API

### `runFile(filePath, options?): Promise<RunResult>`

Executes all requests in a `.http` file sequentially.

**Options (`RunOptions`):**

| Option | Type | Description |
|---|---|---|
| `environment` | `string` | Environment name to load from `http-client.env.json` |
| `variables` | `Record<string, string>` | Additional variables to inject (e.g. `{ host: 'http://localhost:3000' }`) |
| `verbose` | `boolean` | Print request/response info to stdout |
| `client` | `HttpClientRunner` | Reuse an existing client instance (shares global variables across runs) |

**Returns `RunResult`:**

```ts
interface RunResult {
  results: RequestResult[];
  summary: RunSummary;
  client: HttpClientRunner;
}

interface RunSummary {
  totalRequests: number;
  executedRequests: number;
  skippedRequests: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
}

interface RequestResult {
  name: string;
  request: { method: string; url: string };
  status: number | null;
  response: IHttpResponse | null;
  testResults: TestResult[];
  logs: string[];
  skipped: boolean;
}
```

### `runString(content, options?): Promise<RunResult>`

Same as `runFile` but accepts the `.http` content as a string. Accepts an additional `baseDir` option for resolving relative file paths.

### `parseHttpFile(filePath): RequestDescriptor[]`

Low-level parser that returns an array of request descriptors without executing them. Filters out `import`/`run` directives.

### `parseHttpString(content, baseDir?): RequestDescriptor[]`

Same as `parseHttpFile` but takes a string.

### `parseHttpFileEntries(filePath): ParsedEntry[]`

Full parser that returns all entries including `import`/`run` directives alongside request descriptors. Use this when you need to process the complete structure of an `.http` file.

### `parseHttpStringEntries(content, baseDir?): ParsedEntry[]`

Same as `parseHttpFileEntries` but takes a string.

### `HttpClientRunner`

Create a standalone client to share state across multiple file runs:

```ts
import { HttpClientRunner, runFile } from 'http-client-runner';

const client = new HttpClientRunner({ verbose: true });

// Run auth file first – sets tokens in client.global
await runFile('./auth.http', { client });

// Run API tests – reuses auth tokens
await runFile('./api-tests.http', { client });
```

### Exported Types

All interfaces are exported from the package for use in your TypeScript code:

```ts
import type {
  RunResult,
  RunOptions,
  RunSummary,
  RequestResult,
  RequestDescriptor,
  TestResult,
  IHttpResponse,
  HttpClientRunnerRunnerOptions,
  ParsedEntry,
  ImportDirective,
  RunDirective,
  CacheAdapter,
  CachedResponse,
  CacheDirective,
} from 'http-client-runner';
```

## .http File Format

The library supports the [JetBrains HTTP Client](https://www.jetbrains.com/help/idea/http-client-in-product-code-editor.html) file format.

### Basic Request

```http
GET https://httpbin.org/get
Accept: application/json
```

### Request with Body

```http
POST https://httpbin.org/post
Content-Type: application/json

{
  "name": "test",
  "value": 42
}
```

### Multiple Requests (separated by `###`)

```http
GET https://httpbin.org/get

###

POST https://httpbin.org/post
Content-Type: application/json

{"key": "value"}
```

### Named Requests

```http
### Login request
POST https://api.example.com/login
Content-Type: application/json

{"username": "admin", "password": "secret"}
```

Or with `@name` directive:

```http
# @name LoginRequest
POST https://api.example.com/login
```

### Variables

Use `{{variable}}` syntax anywhere in URLs, headers, or bodies:

```http
GET {{host}}/api/users
Authorization: Bearer {{token}}
```

#### Built-in Dynamic Variables

| Variable | Description |
|---|---|
| `{{$uuid}}` | Random UUID |
| `{{$timestamp}}` | Unix timestamp (seconds) |
| `{{$isoTimestamp}}` | ISO 8601 timestamp |
| `{{$randomInt}}` | Random integer 0-999 |

### Response Handlers (JavaScript)

Inline handler after a request — runs after the response is received:

```http
POST https://api.example.com/login
Content-Type: application/json

{"username": "admin", "password": "secret"}

> {%
    client.global.set("authToken", response.body.token);
    client.log("Got token: " + response.body.token);
%}
```

The handler has access to:

- **`response.status`** — HTTP status code
- **`response.body`** — parsed response body
- **`response.contentType.mimeType`** — content type string
- **`response.headers.valueOf(name)`** — single header value
- **`response.headers.valuesOf(name)`** — array of header values
- **`client.global.set(name, value)`** — store a variable for subsequent requests
- **`client.global.get(name)`** — read a stored variable
- **`client.global.clear(name)`** — remove a variable
- **`client.global.clearAll()`** — remove all variables
- **`client.test(name, fn)`** — define a test assertion
- **`client.assert(condition, message)`** — assert a condition
- **`client.log(text)`** — log output
- **`client.exit()`** — stop handler execution

### Pre-request Scripts

Run JavaScript before a request is sent:

```http
< {%
    request.variables.set("timestamp", Date.now().toString());
%}
POST https://api.example.com/events
Content-Type: application/json

{"time": "{{timestamp}}"}
```

### Chaining Requests

The key feature — pass data from one request to the next:

```http
### Step 1: Login
POST {{host}}/auth/login
Content-Type: application/json

{"username": "admin", "password": "secret"}

> {%
    client.global.set("token", response.body.token);
    client.global.set("userId", response.body.user.id);
%}

### Step 2: Get user profile (uses token from step 1)
GET {{host}}/users/{{userId}}
Authorization: Bearer {{token}}

> {%
    client.test("Status is 200", function() {
        client.assert(response.status === 200, "Expected 200");
    });
    client.test("Has correct user", function() {
        client.assert(response.body.id == client.global.get("userId"), "User ID mismatch");
    });
%}
```

### Tests and Assertions

```http
GET https://httpbin.org/get

> {%
    client.test("Status is 200", function() {
        client.assert(response.status === 200, "Expected 200 OK");
    });

    client.test("Content type is JSON", function() {
        client.assert(
            response.contentType.mimeType === "application/json",
            "Expected JSON response"
        );
    });
%}
```

Test results are available in the returned `results[].testResults` array.

### Directives

Add directives as comments before a request:

```http
# @no-redirect
# @no-cookie-jar
# @timeout 5000 ms
GET https://api.example.com/slow-endpoint
```

| Directive | Description |
|---|---|
| `@no-redirect` | Don't follow 3xx redirects |
| `@no-log` | Exclude from logging |
| `@no-cookie-jar` | Don't store cookies |
| `@timeout <value> <unit>` | Read timeout (ms, s, m) |
| `@connection-timeout <value> <unit>` | Connection timeout |
| `@cache(ttl=<ms>)` | Cache the response for the given TTL (milliseconds) |
| `@cache(ttl=<ms>, key=<name>)` | Cache with an explicit key (useful for invalidation) |

### Response Caching

Add a `@cache` directive to avoid repeated network calls for the same request. Cached responses are stored in memory by default and expire after the specified TTL.

**Auto-keyed cache** — the cache key is derived from method, URL, headers, and body:

```http
# @cache(ttl=30000)
GET {{host}}/api/config
```

**Named cache key** — use an explicit key so you can reference or invalidate it:

```http
# @cache(ttl=30000, key=user-profile)
GET {{host}}/api/users/{{userId}}
```

When a cache hit occurs, the stored response is returned without making a network request. Post-response handlers and response redirects still run on cached responses, so your test assertions and variable extraction work the same way.

**Cache invalidation from scripts** — use `client.cache.delete(key)` to remove a specific entry or `client.cache.clear()` to wipe the entire cache. These work in both pre-request and post-response handlers, and are safely awaited even with async adapters like Redis.

**Invalidate before a request** — force a fresh fetch by deleting the cached entry in a pre-request script:

```http
# @cache(ttl=30000, key=user-profile)
GET {{host}}/api/users/{{userId}}

< {%
  // Force a fresh request by clearing the cached entry
  client.cache.delete("user-profile");
%}
```

**Invalidate after a response** — useful when a cached token or session is rejected by the server. The post-response handler can detect the failure and evict the stale entry so the next request fetches a fresh one:

```http
### Cache the auth token for 10 minutes
# @cache(ttl=600000, key=auth-token)
POST {{host}}/auth/token
Content-Type: application/json

{"client_id": "{{clientId}}", "client_secret": "{{clientSecret}}"}

> {%
  client.global.set("token", response.body.access_token);
%}

###

### Call a protected endpoint using the cached token
GET {{host}}/api/protected
Authorization: Bearer {{token}}

> {%
  if (response.status === 401) {
    // Token was revoked or expired server-side — invalidate the cache
    // so the next run fetches a fresh token
    client.cache.delete("auth-token");
    client.log("Auth token invalidated — will refresh on next run");
  }
%}
```

To clear all cached entries at once (e.g. after a deployment or environment switch):

```http
< {%
  client.cache.clear();
%}
GET {{host}}/api/health
```

Only successful responses (2xx) are cached. Network errors and non-2xx responses are never stored.

**Custom cache adapter** — provide your own `CacheAdapter` implementation (e.g. Redis, filesystem) via the `HttpClientRunner` constructor:

```ts
import { HttpClientRunner, runFile } from 'http-client-runner';
import type { CacheAdapter } from 'http-client-runner';

const redisCache: CacheAdapter = {
  async get(key) { /* ... */ },
  async set(key, value, ttlMs) { /* ... */ },
  async delete(key) { /* ... */ },
  async clear() { /* ... */ },
};

const client = new HttpClientRunner({ cacheAdapter: redisCache });
await runFile('./api.http', { client });
```

### Response Redirect to File

Save response body to a file:

```http
GET https://api.example.com/data
>> ./output/response.json

GET https://api.example.com/data
>>! ./output/response.json
```

`>>` creates a new file (adds numeric suffix if exists), `>>!` overwrites.

### Body from File

```http
POST https://api.example.com/upload
Content-Type: application/json

< ./payload.json
```

### External Handler Scripts

```http
GET https://api.example.com/data
> ./scripts/handle-response.js
```

### Importing and Running Requests from Other Files

You can split your `.http` files into reusable modules and compose them using `import` and `run` directives.

#### `import` — Load requests for later use

Place `import` at the top of your `.http` file to make the named requests from another file available:

```http
import auth.http
import helpers.http
```

#### `run` — Execute requests

**Run a named request** from an imported file:

```http
import auth.http

### Authenticate first
run #Login
```

**Run a named request with variable overrides** using `(@key=value)` syntax:

```http
import helpers.http

### Create a widget
run #Create Resource (@resourceName=my-widget)

### Create another with two overrides
run #Create Resource (@resourceName=gadget, @owner=alice)
```

**Run all requests from a file** (no `import` needed):

```http
### Run the full auth flow
run ./auth.http

### Run helpers with overrides
run ./helpers.http (@host=https://staging.example.com)
```

#### How state flows

Variables set via `client.global.set()` in imported/run request handlers are available to subsequent requests, just like inline requests. This makes it easy to compose flows:

```http
import auth.http

### Step 1 — run Login from auth.http, which sets {{authToken}}
run #Login

### Step 2 — use the token it set
GET {{host}}/api/protected
Authorization: Bearer {{authToken}}
```

#### Full import/run example

**auth.http:**

```http
### Login
POST {{host}}/auth/login
Content-Type: application/json

{"username": "admin", "password": "secret"}

> {%
    client.global.set("token", response.body.token);
%}
```

**api-tests.http:**

```http
import auth.http

### Authenticate
run #Login

### Use the token from Login
GET {{host}}/api/users
Authorization: Bearer {{token}}

> {%
    client.test("Returns users", function() {
        client.assert(response.status === 200, "Expected 200");
    });
%}

### Run the full helpers suite at the end
run ./helpers.http
```

#### Entry-level parser API

If you need access to import/run directives programmatically:

```ts
import { parseHttpFileEntries } from 'http-client-runner';
import type { ParsedEntry } from 'http-client-runner';

const entries: ParsedEntry[] = parseHttpFileEntries('./api-tests.http');

for (const entry of entries) {
  switch (entry.kind) {
    case 'import':
      console.log('Import:', entry.filePath);
      break;
    case 'run':
      console.log('Run:', entry.requestName ?? entry.filePath);
      break;
    case 'request':
      console.log('Request:', entry.descriptor.method, entry.descriptor.url);
      break;
  }
}
```

## Environment Files

Create `http-client.env.json` in the same directory as your `.http` file:

```json
{
  "development": {
    "host": "http://localhost:3000",
    "token": "dev-token-123"
  },
  "staging": {
    "host": "https://staging.api.example.com",
    "token": "staging-token-456"
  },
  "production": {
    "host": "https://api.example.com",
    "token": "prod-token-789"
  }
}
```

For secrets, use `http-client.private.env.json` (add to `.gitignore`). Private values override public ones.

```ts
await runFile('./api.http', { environment: 'development' });
```

Variables from the environment file are resolved in `{{variable}}` placeholders. Process environment variables (`process.env`) are also available as fallback.

## Full Example

```ts
import { runFile } from 'http-client-runner';

const { results, summary } = await runFile('./examples/chain.http', {
  environment: 'development',
  variables: { host: 'https://httpbin.org' },
  verbose: true,
});

for (const r of results) {
  console.log(`${r.name}: ${r.status}`);
  for (const t of r.testResults) {
    console.log(`  ${t.passed ? '✓' : '✗'} ${t.name}${t.error ? ' — ' + t.error : ''}`);
  }
}

console.log(`\nTests: ${summary.passedTests} passed, ${summary.failedTests} failed`);
```

## Security

**Treat `.http` files with JavaScript handlers as executable code.** Response handlers (`> {% %}`) and pre-request scripts (`< {% %}`) run inside a Node.js `vm` context, which is not a security sandbox. Malicious scripts can escape the VM and access the host process.

This is consistent with how JetBrains' own HTTP Client works — handlers run in-process with full trust. Only run `.http` files you trust, the same way you would only run scripts you trust.

## Development

```bash
git clone <repo-url>
cd http-client-runner
npm install
npm run build        # Compile TypeScript → dist/
npm test             # Run example .http files against httpbin.org
```

## License

[CC BY-NC 4.0](./LICENSE) — Free for non-commercial use. For commercial licensing, contact the author.
