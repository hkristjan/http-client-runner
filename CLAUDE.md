# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build        # Compile TypeScript → dist/
npm run clean        # Remove dist/
npm test             # Run both example runners against httpbin.org (integration tests)
npm run test:chain   # Run chain example only
npm run test:import  # Run import example only
```

Tests use `tsx` to run TypeScript example files directly (`examples/run-chain.ts`, `examples/run-import.ts`) against httpbin.org — there are no unit tests.

## Architecture

The library executes JetBrains-style `.http` files. The pipeline is:

```
.http file → Parser → Runner → Executor → Response
```

**`parser.ts`** — Parses `.http` format into `ParsedEntry[]`. Three entry kinds: `request`, `import`, `run`. Extracts directives, inline JS scripts (`< {%...%}` pre-request, `> {%...%}` post-response), headers, body, and variable overrides (`(@key=value)` syntax).

**`runner.ts`** — Orchestrates execution. Handles `import`/`run` directives, loads environment files, manages variable scoping (run directive overrides are scoped and don't leak to `client.global`). `ImportRegistry` caches parsed imported files.

**`executor.ts`** — Executes individual requests via axios. Substitutes variables in URLs/headers/body, runs pre/post scripts in `vm.createContext()`, handles response file redirects (`>>` / `>>!`).

**`client.ts`** — `HttpClient` class holds shared mutable state across all requests: `client.global` variables, headers, test results, logs. A single instance is shared across multiple file runs for state preservation.

**`environment.ts`** — Loads `http-client.env.json` / `http-client.private.env.json`. Variable resolution priority: client globals → env file → built-in dynamics (`$uuid`, `$timestamp`, `$isoTimestamp`, `$randomInt`) → `process.env`.

**`response.ts`** — Wraps axios responses into `IHttpResponse` / `IHttpErrorResponse`. HTTP errors (4xx/5xx) don't throw; network errors are converted to error responses.

**`index.ts`** — Public API: `runFile`, `runString`, `parseHttpFile`, `parseHttpString`, `parseHttpFileEntries`, `parseHttpStringEntries`, `HttpClient`, `loadEnvironment`, `substituteVariables`.

**`cli.ts`** — CLI entry point (`http-client-runner` bin). Creates a single `HttpClient` instance shared across all input files. Exits with code 1 if any tests fail.

## Key design notes

- JS handlers run in `vm.createContext()` — not a security sandbox; treat `.http` files as executable code.
- Scripts run with a 10-second timeout. `client.exit()` halts handler execution early.
- `run` directive variable overrides are scoped: they don't persist to `client.global` after that request completes.
- The `dist/` output is what gets published to npm; TypeScript source stays in `src/`.
- Environment file `http-client.private.env.json` overrides `http-client.env.json` and is git-ignored.
