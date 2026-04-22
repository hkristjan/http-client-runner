# Injectable Request Function Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `requestFn` parameter to `RunOptions` so callers can inject a custom HTTP transport instead of the hardcoded axios call in `executor.ts`.

**Architecture:** Add a `RequestFn` type alias in `types.ts`, thread it through `RunOptions` → `ExecuteOptions` → `executeRequest`, and use it in `executor.ts` with an axios fallback. Also wire it in `rabbitmq-worker`'s `WorkflowRunnerService` to pass `requestService.request`. Fully backward-compatible — no changes to `HttpClientRunner` constructor or state.

**Tech Stack:** TypeScript, axios (`AxiosRequestConfig`/`AxiosResponse`), NestJS (rabbitmq-worker side).

---

## File Map

| File | Change |
|---|---|
| `http-client/src/types.ts` | Add `RequestFn` type; add `requestFn?` to `RunOptions` and `ExecuteOptions` |
| `http-client/src/executor.ts` | Destructure `requestFn` from options; replace `axios()` call with fallback |
| `http-client/src/runner.ts` | Thread `requestFn` from `RunOptions` into `executeRequest` calls (both direct and via `_executeRunDirective`) |
| `http-client/src/index.ts` | Export `RequestFn` type |
| `http-client/examples/run-custom-request.ts` | New verification example — passes a spy `requestFn` and asserts it was called |
| `http-client/README.md` | Add `requestFn` to RunOptions table; add "Custom request function" subsection |
| `rabbitmq-worker/src/workflow/workflow-runner.service.ts` | Pass `requestFn` to `runFile` |

---

## Task 1: Add `RequestFn` type and fields to `types.ts`

**Files:**
- Modify: `http-client/src/types.ts`

- [ ] **Step 1: Add axios import at the top of `types.ts`**

Open `http-client/src/types.ts`. The file currently starts with:
```ts
import type { HttpClientRunner } from './client';
```

Add the axios import on line 2:
```ts
import type { HttpClientRunner } from './client';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
```

- [ ] **Step 2: Add `RequestFn` type alias after `CacheAdapter`**

In `types.ts`, after the closing `}` of the `CacheAdapter` interface (currently around line 23), add:
```ts
/** Pluggable HTTP transport function — receives the built axios config, must return an AxiosResponse. */
export type RequestFn = (config: AxiosRequestConfig) => Promise<AxiosResponse>;
```

- [ ] **Step 3: Add `requestFn?` to `RunOptions`**

The `RunOptions` interface (currently around lines 164–170) looks like:
```ts
export interface RunOptions {
  environment?: string;
  variables?: Record<string, string>;
  verbose?: boolean;
  client?: HttpClientRunner;
  baseDir?: string;
}
```

Replace it with:
```ts
export interface RunOptions {
  environment?: string;
  variables?: Record<string, string>;
  verbose?: boolean;
  client?: HttpClientRunner;
  baseDir?: string;
  requestFn?: RequestFn;
}
```

- [ ] **Step 4: Add `requestFn?` to `ExecuteOptions`**

The `ExecuteOptions` interface (currently around lines 172–175) looks like:
```ts
export interface ExecuteOptions {
  verbose?: boolean;
  baseDir?: string;
}
```

Replace it with:
```ts
export interface ExecuteOptions {
  verbose?: boolean;
  baseDir?: string;
  requestFn?: RequestFn;
}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/hkrstjan/work/preskok/http-client && npm run build
```

Expected: no errors, `dist/` updated.

- [ ] **Step 6: Commit**

```bash
cd /Users/hkrstjan/work/preskok/http-client
git add src/types.ts
git commit -m "feat: add RequestFn type and requestFn? to RunOptions and ExecuteOptions"
```

---

## Task 2: Write verification example (failing baseline)

**Files:**
- Create: `http-client/examples/run-custom-request.ts`

- [ ] **Step 1: Create the verification example**

Create `http-client/examples/run-custom-request.ts`:
```ts
import { runString } from '../src/index';
import type { RequestFn } from '../src/index';
import axios from 'axios';

let callCount = 0;

const requestFn: RequestFn = async (config) => {
  callCount++;
  console.log(`[spy] ${String(config.method).toUpperCase()} ${config.url}`);
  return axios(config);
};

const content = `
GET https://httpbin.org/get
`;

const { results } = await runString(content, { requestFn });

if (results[0].status !== 200) {
  throw new Error(`Expected status 200, got ${results[0].status}`);
}
if (callCount !== 1) {
  throw new Error(`Expected requestFn to be called once, got ${callCount}`);
}
console.log('✓ requestFn was called once');
console.log('✓ response status:', results[0].status);
```

- [ ] **Step 2: Run to confirm it fails (requestFn is not wired yet)**

```bash
cd /Users/hkrstjan/work/preskok/http-client && tsx examples/run-custom-request.ts
```

Expected: The script runs but `callCount` is `0` — the spy is never called because `executor.ts` still calls axios directly. You should see:
```
Error: Expected requestFn to be called once, got 0
```

---

## Task 3: Update `executor.ts` to use `requestFn` with axios fallback

**Files:**
- Modify: `http-client/src/executor.ts`

- [ ] **Step 1: Destructure `requestFn` from options**

In `executor.ts`, the current destructure on line 31 is:
```ts
const { verbose = false, baseDir = process.cwd() } = options;
```

Replace with:
```ts
const { verbose = false, baseDir = process.cwd(), requestFn } = options;
```

- [ ] **Step 2: Replace the `axios()` call with fallback**

Around line 208–211, the current block is:
```ts
  try {
    const axiosResp = await axios(axiosConfig);
    response = new HttpResponse(axiosResp);
  } catch (err) {
```

Replace with:
```ts
  try {
    const axiosResp = requestFn ? await requestFn(axiosConfig) : await axios(axiosConfig);
    response = new HttpResponse(axiosResp);
  } catch (err) {
```

- [ ] **Step 3: Run the verification example to confirm it passes**

```bash
cd /Users/hkrstjan/work/preskok/http-client && tsx examples/run-custom-request.ts
```

Expected output:
```
[spy] GET https://httpbin.org/get
✓ requestFn was called once
✓ response status: 200
```

- [ ] **Step 4: Run the existing test suite to confirm no regressions**

```bash
cd /Users/hkrstjan/work/preskok/http-client && npm test
```

Expected: all existing examples pass (run-chain, run-import, run-econnrefused, run-cache).

- [ ] **Step 5: Commit**

```bash
cd /Users/hkrstjan/work/preskok/http-client
git add src/executor.ts examples/run-custom-request.ts
git commit -m "feat: use injected requestFn in executor, fall back to axios"
```

---

## Task 4: Thread `requestFn` through `runner.ts`

**Files:**
- Modify: `http-client/src/runner.ts`

Right now `requestFn` is passed in `RunOptions` and reaches `executeRequest` via `ExecuteOptions`, but `_runEntries` and `_executeRunDirective` don't yet extract or forward it.

- [ ] **Step 1: Extract `requestFn` in `_runEntries`**

In `runner.ts`, the destructure at the start of `_runEntries` (around line 94–98) currently is:
```ts
  const {
    environment: envName,
    variables: extraVars = {},
  } = options;
```

Replace with:
```ts
  const {
    environment: envName,
    variables: extraVars = {},
    requestFn,
  } = options;
```

- [ ] **Step 2: Pass `requestFn` to the direct `executeRequest` call**

Still in `_runEntries`, the direct `executeRequest` call (around line 175) currently is:
```ts
        const result = await executeRequest(req, client, envVars, {
          verbose: shouldLog,
          baseDir,
        });
```

Replace with:
```ts
        const result = await executeRequest(req, client, envVars, {
          verbose: shouldLog,
          baseDir,
          requestFn,
        });
```

- [ ] **Step 3: Pass `requestFn` to `_executeRunDirective`**

The `_executeRunDirective` call in `_runEntries` (around line 148) currently is:
```ts
        const runResults = await _executeRunDirective(
          entry,
          registry,
          client,
          envVars,
          baseDir,
          verbose,
        );
```

Replace with:
```ts
        const runResults = await _executeRunDirective(
          entry,
          registry,
          client,
          envVars,
          baseDir,
          verbose,
          requestFn,
        );
```

- [ ] **Step 4: Add `requestFn` parameter to `_executeRunDirective`**

The function signature (around line 231) currently is:
```ts
async function _executeRunDirective(
  directive: RunDirective,
  registry: ImportRegistry,
  client: HttpClientRunner,
  envVars: Record<string, string>,
  baseDir: string,
  verbose: boolean,
): Promise<RequestResult[]>
```

Replace with:
```ts
async function _executeRunDirective(
  directive: RunDirective,
  registry: ImportRegistry,
  client: HttpClientRunner,
  envVars: Record<string, string>,
  baseDir: string,
  verbose: boolean,
  requestFn?: RequestFn,
): Promise<RequestResult[]>
```

Also add the import at the top of the function body — actually `RequestFn` is already available since it's imported from `./types` alongside other types. Confirm the types import block at the top of `runner.ts` includes `RequestFn` (add it if not present):
```ts
import type {
  RequestDescriptor,
  RunOptions,
  RunResult,
  RequestResult,
  TestResult,
  ParsedEntry,
  ImportDirective,
  RunDirective,
  VariablesEntry,
  RequestFn,           // ← add this
} from './types';
```

- [ ] **Step 5: Pass `requestFn` to `executeRequest` inside `_executeRunDirective`**

Inside `_executeRunDirective` there is one `executeRequest` call (inside the `for (const req of requests)` loop, around line 306). It currently is:
```ts
    const result = await executeRequest(req, client, scopedEnvVars, {
      verbose,
      baseDir: runBaseDir,
    });
```

Replace with:
```ts
    const result = await executeRequest(req, client, scopedEnvVars, {
      verbose,
      baseDir: runBaseDir,
      requestFn,
    });
```

- [ ] **Step 6: Build to verify no TypeScript errors**

```bash
cd /Users/hkrstjan/work/preskok/http-client && npm run build
```

Expected: clean build.

- [ ] **Step 7: Run full test suite**

```bash
cd /Users/hkrstjan/work/preskok/http-client && npm test
```

Expected: all examples pass.

- [ ] **Step 8: Commit**

```bash
cd /Users/hkrstjan/work/preskok/http-client
git add src/runner.ts
git commit -m "feat: thread requestFn through runner to executeRequest"
```

---

## Task 5: Export `RequestFn` from `index.ts`

**Files:**
- Modify: `http-client/src/index.ts`

- [ ] **Step 1: Add `RequestFn` to the re-export block**

In `src/index.ts`, the `export type { ... }` block currently ends with `CacheDirective,`. Add `RequestFn` to the list:

```ts
export type {
  RequestDescriptor,
  ResponseRedirect,
  ContentType,
  ResponseHeaders,
  IHttpResponse,
  ClientGlobal,
  ClientGlobalHeaders,
  TestResult,
  RequestProxy,
  ScriptSandbox,
  ExecutionResult,
  RequestResult,
  RunSummary,
  RunResult,
  RunOptions,
  ExecuteOptions,
  HttpClientRunnerOptions,
  EnvironmentFile,
  ImportDirective,
  RunDirective,
  ParsedEntry,
  CacheAdapter,
  CachedResponse,
  CacheDirective,
  RequestFn,
} from './types';
```

- [ ] **Step 2: Build and run the verification example**

```bash
cd /Users/hkrstjan/work/preskok/http-client && npm run build && tsx examples/run-custom-request.ts
```

Expected: clean build and the same passing output as before:
```
[spy] GET https://httpbin.org/get
✓ requestFn was called once
✓ response status: 200
```

- [ ] **Step 3: Commit**

```bash
cd /Users/hkrstjan/work/preskok/http-client
git add src/index.ts examples/run-custom-request.ts
git commit -m "feat: export RequestFn type from package index"
```

---

## Task 6: Update README

**Files:**
- Modify: `http-client/README.md`

- [ ] **Step 1: Add `requestFn` row to the RunOptions table**

The `RunOptions` table is under the `### runFile` section (around line 88–95). It currently is:

```markdown
| Option | Type | Description |
|---|---|---|
| `environment` | `string` | Environment name to load from `http-client.env.json` |
| `variables` | `Record<string, string>` | Additional variables to inject (e.g. `{ host: 'http://localhost:3000' }`) |
| `verbose` | `boolean` | Print request/response info to stdout |
| `client` | `HttpClientRunner` | Reuse an existing client instance (shares global variables across runs) |
```

Replace with:
```markdown
| Option | Type | Description |
|---|---|---|
| `environment` | `string` | Environment name to load from `http-client.env.json` |
| `variables` | `Record<string, string>` | Additional variables to inject (e.g. `{ host: 'http://localhost:3000' }`) |
| `verbose` | `boolean` | Print request/response info to stdout |
| `client` | `HttpClientRunner` | Reuse an existing client instance (shares global variables across runs) |
| `requestFn` | `RequestFn` | Custom HTTP transport — replaces the built-in axios call. Falls back to axios if omitted. |
```

- [ ] **Step 2: Add `RequestFn` to the exported types example**

The exported types block (around line 163–182) lists available imports. Add `RequestFn`:

```ts
import type {
  RunResult,
  RunOptions,
  RunSummary,
  RequestResult,
  RequestDescriptor,
  TestResult,
  IHttpResponse,
  HttpClientRunnerOptions,
  ParsedEntry,
  ImportDirective,
  RunDirective,
  CacheAdapter,
  CachedResponse,
  CacheDirective,
  RequestFn,
} from 'http-client-runner';
```

- [ ] **Step 3: Add "Custom request function" subsection**

After the `HttpClientRunner` section (ends around line 159) and before the `### Exported Types` section, insert the following new subsection:

```markdown
### Custom request function

Inject a custom HTTP transport via `requestFn`. The executor calls it instead of the built-in axios call — useful for adding structured logging, auth strategies, or instrumentation from your existing HTTP layer:

```ts
import { runFile } from 'http-client-runner';
import type { RequestFn } from 'http-client-runner';

// Example: use a NestJS RequestService for logging + auth
const requestFn: RequestFn = (config) => requestService.request(config);

await runFile('./vendor.http', {
  client,
  variables,
  requestFn,
});
```

Falls back to the built-in axios call when `requestFn` is omitted — fully backward-compatible.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/hkrstjan/work/preskok/http-client
git add README.md
git commit -m "docs: document requestFn option in README"
```

---

## Task 7: Wire `requestFn` in rabbitmq-worker

**Files:**
- Modify: `rabbitmq-worker/src/workflow/workflow-runner.service.ts`

- [ ] **Step 1: Pass `requestFn` to `runFile`**

In `workflow-runner.service.ts`, the `runFile` call (around line 41–45) currently is:
```ts
            const result: RunResult = await runFile(filePath, {
                client: this.client,
                environment: workflowConfig.environment,
                variables,
            });
```

Replace with:
```ts
            const result: RunResult = await runFile(filePath, {
                client: this.client,
                environment: workflowConfig.environment,
                variables,
                requestFn: (config) => this.requestService.request(config),
            });
```

- [ ] **Step 2: Inject `RequestService` into `WorkflowRunnerService`**

`WorkflowRunnerService` currently only injects `ConfigService` and `Logger`. Add `RequestService`.

The constructor (around lines 13–18) currently is:
```ts
    constructor(
        private configService: ConfigService,
        private logger: Logger,
    ) {
        this.client = new HttpClientRunner({ verbose: this.configService.get('WORKFLOWS_VERBOSE') });
    }
```

Replace with:
```ts
    constructor(
        private configService: ConfigService,
        private logger: Logger,
        private requestService: RequestService,
    ) {
        this.client = new HttpClientRunner({ verbose: this.configService.get('WORKFLOWS_VERBOSE') });
    }
```

- [ ] **Step 3: Add `RequestService` import**

At the top of `workflow-runner.service.ts`, the imports currently are:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClientRunner, runFile, RunResult, RequestResult } from 'http-client-runner';
import * as path from 'path';
import { HttpWorkflowConfig } from './workflow-config.interface';
import { RequestError } from '../request/request.error';
import { HttpResponse } from '../request/request.interface';
```

Add the `RequestService` import:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpClientRunner, runFile, RunResult, RequestResult } from 'http-client-runner';
import * as path from 'path';
import { HttpWorkflowConfig } from './workflow-config.interface';
import { RequestError } from '../request/request.error';
import { HttpResponse } from '../request/request.interface';
import { RequestService } from '../request/request.service';
```

- [ ] **Step 4: Register `RequestModule` in `WorkflowModule`**

`rabbitmq-worker/src/workflow/workflow.module.ts` currently is:
```ts
import { Logger, Module } from '@nestjs/common';
import { WorkflowRunnerService } from './workflow-runner.service';

@Module({
    providers: [WorkflowRunnerService, Logger],
    exports: [WorkflowRunnerService],
})
export class WorkflowModule {}
```

Replace with:
```ts
import { Logger, Module } from '@nestjs/common';
import { WorkflowRunnerService } from './workflow-runner.service';
import { RequestModule } from '../request/request.module';

@Module({
    imports: [RequestModule],
    providers: [WorkflowRunnerService, Logger],
    exports: [WorkflowRunnerService],
})
export class WorkflowModule {}
```

- [ ] **Step 5: Build rabbitmq-worker to verify no TypeScript errors**

```bash
cd /Users/hkrstjan/work/preskok/rabbitmq-worker && npm run build
```

Expected: clean build.

- [ ] **Step 6: Commit**

```bash
cd /Users/hkrstjan/work/preskok/rabbitmq-worker
git add src/workflow/workflow-runner.service.ts src/workflow/workflow.module.ts
git commit -m "feat: inject requestFn into runFile so workflow HTTP calls go through RequestService"
```
