import * as path from 'path';
import {
  parseHttpFile,
  parseHttpString,
  parseHttpFileEntries,
  parseHttpStringEntries,
} from './parser';
import { HttpClient } from './client';
import { loadEnvironment, substituteVariables } from './environment';
import { executeRequest } from './executor';
import type {
  RequestDescriptor,
  RunOptions,
  RunResult,
  RequestResult,
  TestResult,
  ParsedEntry,
  ImportDirective,
  RunDirective,
} from './types';

// ---------------------------------------------------------------------------
// Import registry — keeps parsed named requests from `import` directives
// ---------------------------------------------------------------------------
class ImportRegistry {
  /** filePath → RequestDescriptor[] */
  private _files = new Map<string, RequestDescriptor[]>();

  /** Register all requests from a file. */
  register(filePath: string, requests: RequestDescriptor[]): void {
    this._files.set(filePath, requests);
  }

  /** Look up a named request across all imported files. */
  findByName(name: string): RequestDescriptor | null {
    for (const requests of this._files.values()) {
      const found = requests.find((r) => r.name === name);
      if (found) return found;
    }
    return null;
  }

  /** Get all requests from a specific imported file. */
  getFileRequests(filePath: string): RequestDescriptor[] | null {
    return this._files.get(filePath) ?? null;
  }
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Run all requests from a .http file sequentially.
 *
 * Supports `import` and `run` directives to include/execute requests from
 * other .http files. Each request receives the response from the previous
 * request via `client.global` variables.
 */
export async function runFile(
  filePath: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const resolvedPath = path.resolve(filePath);
  const baseDir = path.dirname(resolvedPath);
  const entries = parseHttpFileEntries(resolvedPath);

  return _runEntries(entries, baseDir, options);
}

/**
 * Run all requests from an .http format string.
 */
export async function runString(
  content: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const baseDir = options.baseDir || process.cwd();
  const entries = parseHttpStringEntries(content, baseDir);

  return _runEntries(entries, baseDir, options);
}

// ===========================================================================
// Internal runner
// ===========================================================================

async function _runEntries(
  entries: ParsedEntry[],
  baseDir: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const {
    environment: envName,
    variables: extraVars = {},
    verbose = false,
  } = options;

  const client = options.client || new HttpClient({ verbose });

  // Load environment variables
  const envVars: Record<string, string> = {
    ...loadEnvironment(baseDir, envName),
    ...extraVars,
  };

  // Seed any extra variables into the client globals
  for (const [k, v] of Object.entries(extraVars)) {
    client.global.set(k, v);
  }

  const registry = new ImportRegistry();
  const results: RequestResult[] = [];
  let requestCounter = 0;

  for (const entry of entries) {
    switch (entry.kind) {
      // ---------------------------------------------------------------
      // import other-file.http
      // ---------------------------------------------------------------
      case 'import': {
        const importPath = entry.filePath;
        if (verbose) {
          console.log(`\n⬇  import ${path.relative(baseDir, importPath)}`);
        }
        const imported = parseHttpFile(importPath);
        registry.register(importPath, imported);
        break;
      }

      // ---------------------------------------------------------------
      // run #RequestName  or  run ./file.http
      // ---------------------------------------------------------------
      case 'run': {
        const runResults = await _executeRunDirective(
          entry,
          registry,
          client,
          envVars,
          baseDir,
          verbose,
        );
        results.push(...runResults);
        requestCounter += runResults.length;
        break;
      }

      // ---------------------------------------------------------------
      // Regular HTTP request
      // ---------------------------------------------------------------
      case 'request': {
        requestCounter++;
        const req = entry.descriptor;
        const label = req.name || `Request #${requestCounter}`;
        const shouldLog = verbose && !req.directives.has('no-log');

        if (shouldLog) {
          console.log(`\n${'='.repeat(60)}`);
          console.log(`  ${label}`);
          console.log(`${'='.repeat(60)}`);
        }

        const result = await executeRequest(req, client, envVars, {
          verbose: shouldLog,
          baseDir,
        });

        results.push({
          name: label,
          request: {
            method: req.method,
            url: substituteVariables(
              req.url,
              client.getVariables(),
              envVars,
            ),
          },
          status: result.response ? result.response.status : null,
          response: result.response,
          testResults: result.testResults,
          logs: result.logs,
          skipped: result.skipped || false,
        });

        // Clear logs for next entry
        client._logs = [];
        break;
      }
    }
  }

  // Summary
  const allTests: TestResult[] = results.flatMap((r) => r.testResults);
  const passed = allTests.filter((t) => t.passed).length;
  const failed = allTests.filter((t) => !t.passed).length;

  return {
    results,
    summary: {
      totalRequests: results.length,
      executedRequests: results.filter((r) => !r.skipped).length,
      skippedRequests: results.filter((r) => r.skipped).length,
      totalTests: allTests.length,
      passedTests: passed,
      failedTests: failed,
    },
    client,
  };
}

// ---------------------------------------------------------------------------
// Execute a `run` directive
// ---------------------------------------------------------------------------
async function _executeRunDirective(
  directive: RunDirective,
  registry: ImportRegistry,
  client: HttpClient,
  envVars: Record<string, string>,
  baseDir: string,
  verbose: boolean,
): Promise<RequestResult[]> {
  const results: RequestResult[] = [];

  // Build scoped env vars with any (@key=value) overrides.
  // These are intentionally NOT written to client.global so they
  // stay scoped to this run directive and don't leak into later requests.
  const scopedEnvVars: Record<string, string> = { ...envVars };
  for (const [k, v] of Object.entries(directive.variableOverrides)) {
    scopedEnvVars[k] = v;
  }

  // Collect the request(s) to execute
  let requests: RequestDescriptor[];

  if (directive.requestName) {
    // --- run #RequestName ---
    const found = registry.findByName(directive.requestName);
    if (!found) {
      const msg = `[http-client] run: named request "${directive.requestName}" not found in imports`;
      if (verbose) console.error(msg);
      client.log(msg);
      return results;
    }
    requests = [found];
  } else if (directive.filePath) {
    // --- run ./file.http ---
    // Check registry first (maybe it was already imported)
    let fileRequests = registry.getFileRequests(directive.filePath);
    if (!fileRequests) {
      // Parse and register on the fly
      fileRequests = parseHttpFile(directive.filePath);
      registry.register(directive.filePath, fileRequests);
    }
    requests = fileRequests;
  } else {
    return results;
  }

  // Execute each request
  for (const req of requests) {
    const label = req.name
      ? `[run] ${req.name}`
      : `[run] ${req.method} ${req.url}`;

    if (verbose) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`  ${label}`);
      console.log(`${'='.repeat(60)}`);
    }

    const runBaseDir = directive.filePath
      ? path.dirname(directive.filePath)
      : baseDir;

    const result = await executeRequest(req, client, scopedEnvVars, {
      verbose,
      baseDir: runBaseDir,
    });

    results.push({
      name: label,
      request: {
        method: req.method,
        url: substituteVariables(
          req.url,
          client.getVariables(),
          scopedEnvVars,
        ),
      },
      status: result.response ? result.response.status : null,
      response: result.response,
      testResults: result.testResults,
      logs: result.logs,
      skipped: result.skipped || false,
    });

    // Clear logs for next request
    client._logs = [];
  }

  return results;
}
