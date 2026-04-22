# Injectable Request Function for http-client-runner

## Problem

`executor.ts` calls `axios()` directly — the HTTP transport is hardcoded. `rabbitmq-worker`'s `WorkflowRunnerService` runs `.http` workflows via `runFile`, but the built-in axios call bypasses the worker's `RequestService`, which provides structured logging (method, URL, status, duration) and auth strategy support. There is no way to intercept or replace the transport layer today.

## Goal

Allow callers to inject a custom request function via `RunOptions`. When provided, the executor calls it instead of axios. Falls back to axios when omitted — fully backward-compatible.

## Design

### Type (`types.ts`)

```ts
export type RequestFn = (config: AxiosRequestConfig) => Promise<AxiosResponse>;
```

Add optional `requestFn?: RequestFn` to both `RunOptions` and `ExecuteOptions`.

The axios types are used directly — http-client-runner already depends on axios, and `RequestService.request()` uses `AxiosRequestConfig`/`AxiosResponse`, so the types align without a translation layer.

### Executor (`executor.ts`)

Destructure `requestFn` from `options` alongside the existing `verbose` and `baseDir`. Replace the single `axios(axiosConfig)` call:

```ts
const axiosResp = requestFn
  ? await requestFn(axiosConfig)
  : await axios(axiosConfig);
```

No other changes to the executor. Error handling, cache store, response wrapping, and script execution are untouched — both paths produce an `AxiosResponse`/`AxiosError`.

### Runner (`runner.ts`)

Thread `requestFn` from `RunOptions` down to each `executeRequest` call via `ExecuteOptions`. Also thread it through `_executeRunDirective` so requests triggered by `run` directives use the same transport.

### Consumer (`rabbitmq-worker` — `workflow-runner.service.ts`)

```ts
await runFile(filePath, {
  client: this.client,
  environment: workflowConfig.environment,
  variables,
  requestFn: (config) => this.requestService.request(config),
});
```

No changes to `HttpClientRunner`, `HttpClientRunnerOptions`, or any other class.

### Docs (`README.md`)

- Add `requestFn` row to the `RunOptions` table under `runFile`.
- Add a "Custom request function" subsection with a usage example showing injection of a NestJS `RequestService`.
- Export `RequestFn` type from the package index.

## Files Changed

| File | Change |
|---|---|
| `src/types.ts` | Add `RequestFn` type alias; add `requestFn?` to `RunOptions` and `ExecuteOptions` |
| `src/executor.ts` | Destructure `requestFn` from options; replace `axios()` call with fallback |
| `src/runner.ts` | Thread `requestFn` through `_runEntries` and `_executeRunDirective` to `executeRequest` |
| `src/index.ts` | Export `RequestFn` type |
| `README.md` | Add `requestFn` to options table; add custom request function subsection |
| `rabbitmq-worker: workflow-runner.service.ts` | Pass `requestFn` to `runFile` |

## Non-Goals

- No changes to `HttpClientRunner` constructor or state model.
- No axios abstraction — the function signature uses axios types directly.
- No auth config parameter in `RequestFn` — callers bind any auth via closure.
