import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';
import * as vm from 'vm';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { HttpResponse, HttpErrorResponse, CachedHttpResponse } from './response';
import { substituteVariables } from './environment';
import { computeCacheKey } from './cache';
import { HttpClientRunner } from './client';
import type {
  RequestDescriptor,
  ExecutionResult,
  ExecuteOptions,
  ScriptSandbox,
  RequestProxy,
  IHttpResponse,
  CacheAdapter,
  CachedResponse,
  TestResult,
} from './types';

/**
 * Execute a single parsed request descriptor.
 */
export async function executeRequest(
  request: RequestDescriptor,
  client: HttpClientRunner,
  envVars: Record<string, string>,
  options: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const { verbose = false, baseDir = process.cwd() } = options;
  const clientVars = client.getVariables();

  // --- Variable substitution on URL, headers, body ---
  let url = substituteVariables(request.url, clientVars, envVars);
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(request.headers)) {
    headers[substituteVariables(key, clientVars, envVars)] =
      substituteVariables(val, clientVars, envVars);
  }
  let body: string | undefined = request.body
    ? substituteVariables(request.body, clientVars, envVars)
    : undefined;

  // Merge global headers (set via client.global.headers.set)
  const globalHeaders = client.getGlobalHeaders();
  for (const [key, val] of Object.entries(globalHeaders)) {
    if (!headers[key]) {
      headers[key] = val;
    }
  }

  // --- Pre-request script ---
  if (request.preRequestScript) {
    const requestProxy: RequestProxy = {
      variables: {
        set: (name: string, value: string): void => {
          envVars[name] = value;
        },
        get: (name: string): string | undefined => envVars[name],
      },
      body: {
        getRaw: (): string | undefined => body,
        tryGetSubstituted: (): string | undefined => body,
      },
      headers: {
        findByName: (name: string): string | null => headers[name] || null,
      },
      url: {
        tryGetSubstituted: (): string => url,
      },
      environment: {
        get: (name: string): string | undefined => envVars[name],
      },
    };

    client.resetExit();
    runScript(request.preRequestScript, { client, request: requestProxy }, baseDir);
    await client.flushCacheOps();
    if (client.exited) {
      return {
        response: null,
        testResults: [],
        logs: [...client._logs],
        skipped: true,
        networkError: null,
        cached: false,
      };
    }

    // Re-substitute in case pre-request script changed variables
    const updatedClientVars = client.getVariables();
    url = substituteVariables(request.url, updatedClientVars, envVars);
    const reSubHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(request.headers)) {
      reSubHeaders[substituteVariables(key, updatedClientVars, envVars)] =
        substituteVariables(val, updatedClientVars, envVars);
    }
    Object.assign(headers, reSubHeaders);
    body = request.body
      ? substituteVariables(request.body, updatedClientVars, envVars)
      : undefined;
  }

  // --- Cache check (after pre-request script, using resolved values) ---
  let cacheKey: string | undefined;
  let cacheAdapter: CacheAdapter | undefined;
  if (request.cache) {
    if (verbose) {
      console.log(`  [cache] Cache directive detected (ttl=${request.cache.ttl}ms${request.cache.key ? `, key=${request.cache.key}` : ''})`);
    }
    cacheAdapter = client.getCacheAdapter();
    cacheKey = request.cache.key
      ? substituteVariables(request.cache.key, client.getVariables(), envVars)
      : computeCacheKey(request.method, url, headers, body);
    const hit = await cacheAdapter.get(cacheKey);
    if (hit) {
      const response: IHttpResponse = new CachedHttpResponse(hit);
      if (verbose) {
        console.log(`\n→ ${request.method} ${url}`);
        console.log(`  [cached] Using cached response for ${url}`);
        console.log(`  ← ${response.status} ${response.contentType.mimeType}`);
      }

      // Response redirect still runs on cache hit
      if (request.responseRedirect) {
        writeResponseRedirect(request, response, client, envVars, baseDir);
      }

      // Post-response handler still runs on cache hit
      let testResults: TestResult[] = [];
      if (request.responseHandler) {
        client.resetExit();
        runScript(request.responseHandler, { client, response }, baseDir);
        await client.flushCacheOps();
        testResults = await client.runTests();
      }

      return {
        response,
        testResults,
        logs: [...client._logs],
        skipped: false,
        networkError: null,
        cached: true,
      };
    }
  }

  // --- Detect JSON body ---
  if (body) {
    try {
      JSON.parse(body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    } catch {
      // Not JSON, leave as-is
    }
  }

  // --- Build axios config ---
  const axiosConfig: AxiosRequestConfig = {
    method: request.method as AxiosRequestConfig['method'],
    url,
    headers,
    maxRedirects: request.directives.has('no-redirect') ? 0 : 5,
    validateStatus: () => true, // Don't throw on non-2xx
  };

  // @no-cookie-jar — disable credential / cookie handling
  if (request.directives.has('no-cookie-jar')) {
    axiosConfig.withCredentials = false;
  }

  // @no-auto-encoding — don't auto-decompress responses
  if (request.directives.has('no-auto-encoding')) {
    axiosConfig.decompress = false;
  }

  if (body !== undefined) {
    // If content-type is JSON, parse it for axios
    const ct = headers['Content-Type'] || headers['content-type'] || '';
    if (ct.includes('application/json')) {
      try {
        axiosConfig.data = JSON.parse(body);
      } catch {
        axiosConfig.data = body;
      }
    } else {
      axiosConfig.data = body;
    }
  }

  if (request.timeout) axiosConfig.timeout = request.timeout;
  // @connection-timeout — use as timeout fallback when no request timeout is set
  if (request.connectionTimeout && !axiosConfig.timeout) {
    axiosConfig.timeout = request.connectionTimeout;
  }

  if (verbose) {
    console.log(`\n→ ${request.method} ${url}`);
  }

  // --- Execute request ---
  let response: IHttpResponse;
  let networkError: string | null = null;
  try {
    const axiosResp = await axios(axiosConfig);
    response = new HttpResponse(axiosResp);
  } catch (err) {
    const axiosError = err as AxiosError;
    response = new HttpErrorResponse(axiosError);
    const message = err instanceof Error ? err.message : String(err);
    if (!axiosError.response) {
      // Network-level failure — no HTTP response was received at all
      networkError = message;
    }
    if (verbose) {
      console.error(`  ✗ Request error: ${message}`);
    }
  }

  if (verbose) {
    console.log(`  ← ${response.status} ${response.contentType.mimeType}`);
  }

  // --- Cache store (only 2xx, no network error) ---
  if (
    cacheKey &&
    cacheAdapter &&
    request.cache &&
    !networkError &&
    response.status >= 200 &&
    response.status < 300 &&
    response instanceof HttpResponse
  ) {
    const toCache: CachedResponse = {
      status: response.status,
      body: response.body,
      headers: response.getRawHeaders(),
      contentType: response.contentType,
    };
    await cacheAdapter.set(cacheKey, toCache, request.cache.ttl);
    if (verbose) {
      console.log(`  [cache] Stored response in cache (ttl=${request.cache.ttl}ms)`);
    }
  }

  // --- Response redirect (>> file) ---
  if (request.responseRedirect) {
    writeResponseRedirect(request, response, client, envVars, baseDir);
  }

  // --- Response handler script ---
  let testResults: TestResult[] = [];
  if (request.responseHandler) {
    client.resetExit();
    runScript(request.responseHandler, { client, response }, baseDir);
    await client.flushCacheOps();
    testResults = await client.runTests();
  }

  return {
    response,
    testResults,
    logs: [...client._logs],
    skipped: false,
    networkError,
    cached: false,
  };
}

/**
 * Write response body to a file (>> redirect).
 */
function writeResponseRedirect(
  request: RequestDescriptor,
  response: IHttpResponse,
  client: HttpClientRunner,
  envVars: Record<string, string>,
  baseDir: string,
): void {
  if (!request.responseRedirect) return;
  const outPath = path.resolve(
    baseDir,
    substituteVariables(
      request.responseRedirect.path,
      client.getVariables(),
      envVars,
    ),
  );
  const content =
    typeof response.body === 'object'
      ? JSON.stringify(response.body, null, 2)
      : String(response.body);
  if (request.responseRedirect.overwrite || !fs.existsSync(outPath)) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content, 'utf-8');
  } else {
    const ext = path.extname(outPath);
    const base = outPath.slice(0, -ext.length || undefined);
    let i = 1;
    let candidate = `${base}_${i}${ext}`;
    while (fs.existsSync(candidate)) {
      i++;
      candidate = `${base}_${i}${ext}`;
    }
    fs.writeFileSync(candidate, content, 'utf-8');
  }
}

/**
 * Transform ES import statements to require() calls.
 */
function transformImports(script: string): string {
  // Side-effect import: import './mod'
  script = script.replace(
    /import\s+(['"])([^'"]+)\1\s*;?/g,
    (_, quote, specifier) => `require(${quote}${specifier}${quote});`,
  );

  // Named imports (possibly multi-line): import { a, b } from './mod'
  script = script.replace(
    /import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, names, quote, specifier) => {
      const cleaned = names.replace(/\s+/g, ' ').trim();
      return `const { ${cleaned} } = require(${quote}${specifier}${quote});`;
    },
  );

  // Default import: import foo from './mod'
  script = script.replace(
    /import\s+([a-zA-Z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, name, quote, specifier) => {
      const req = `require(${quote}${specifier}${quote})`;
      return `const ${name} = ${req}.default ?? ${req};`;
    },
  );

  // Namespace import: import * as ns from './mod'
  script = script.replace(
    /import\s*\*\s*as\s+([a-zA-Z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2\s*;?/g,
    (_, name, quote, specifier) =>
      `const ${name} = require(${quote}${specifier}${quote});`,
  );

  return script;
}

/**
 * Transform ES export syntax to CJS module.exports assignments.
 */
function transformExports(content: string): string {
  const deferred: string[] = [];

  // export default ...
  content = content.replace(
    /export\s+default\s+/g,
    'module.exports.default = ',
  );

  // export { a, b }
  content = content.replace(
    /export\s*\{([^}]*)\}\s*;?/g,
    (_, names: string) => {
      return names
        .split(',')
        .map((n: string) => n.trim())
        .filter(Boolean)
        .map((n: string) => `module.exports.${n} = ${n};`)
        .join(' ');
    },
  );

  // export function foo(...)
  content = content.replace(
    /export\s+function\s+([a-zA-Z_$][\w$]*)/g,
    (_, name) => {
      deferred.push(`module.exports.${name} = ${name};`);
      return `function ${name}`;
    },
  );

  // export class Foo
  content = content.replace(
    /export\s+class\s+([a-zA-Z_$][\w$]*)/g,
    (_, name) => {
      deferred.push(`module.exports.${name} = ${name};`);
      return `class ${name}`;
    },
  );

  // export const/let/var x = ...
  content = content.replace(
    /export\s+(const|let|var)\s+([a-zA-Z_$][\w$]*)/g,
    (_, kind, name) => {
      deferred.push(`module.exports.${name} = ${name};`);
      return `${kind} ${name}`;
    },
  );

  if (deferred.length > 0) {
    content += '\n' + deferred.join('\n');
  }

  return content;
}

/**
 * Check if source code contains ES module syntax.
 */
function hasESMSyntax(source: string): boolean {
  return /\b(import\s+|export\s+(default\s+|function\s+|class\s+|const\s+|let\s+|var\s+|\{))/.test(source);
}

/**
 * Create a require function for the VM sandbox that can load local files
 * with ESM syntax and delegate bare specifiers to Node's require.
 */
function createSandboxRequire(baseDir: string): (specifier: string) => unknown {
  const nodeRequire = createRequire(path.resolve(baseDir, '__placeholder.js'));

  return function sandboxRequire(specifier: string): unknown {
    // Relative paths: load and optionally transform ESM → CJS
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const resolved = path.resolve(baseDir, specifier);
      // Try with .js extension if no extension
      let filePath = resolved;
      if (!fs.existsSync(filePath) && !path.extname(filePath)) {
        filePath = resolved + '.js';
      }
      if (!fs.existsSync(filePath) && path.extname(resolved) === '.js') {
        // Try .ts as well
        filePath = resolved.replace(/\.js$/, '.ts');
      }

      const source = fs.readFileSync(filePath, 'utf-8');

      if (hasESMSyntax(source)) {
        let transformed = transformImports(source);
        transformed = transformExports(transformed);

        const moduleObj = { exports: {} as Record<string, unknown> };
        const childCtx = vm.createContext({
          module: moduleObj,
          exports: moduleObj.exports,
          require: createSandboxRequire(path.dirname(filePath)),
          __filename: filePath,
          __dirname: path.dirname(filePath),
          console,
        });
        vm.runInContext(transformed, childCtx, { timeout: 10000 });
        return moduleObj.exports;
      }

      // Plain CJS — delegate to Node's require
      return nodeRequire(specifier);
    }

    // Bare specifiers (node_modules, built-ins) — delegate to Node
    return nodeRequire(specifier);
  };
}

/**
 * Run a JS script string in a sandboxed VM context.
 */
function runScript(
  script: string,
  sandbox: ScriptSandbox,
  baseDir?: string,
): void {
  const transformed = transformImports(script);

  const ctx = vm.createContext({
    ...sandbox,
    ...(baseDir ? { require: createSandboxRequire(baseDir) } : {}),
    console: {
      log: (...args: unknown[]) =>
        sandbox.client.log(args.map(String).join(' ')),
      error: (...args: unknown[]) =>
        sandbox.client.log('[ERROR] ' + args.map(String).join(' ')),
      warn: (...args: unknown[]) =>
        sandbox.client.log('[WARN] ' + args.map(String).join(' ')),
    },
  });

  try {
    vm.runInContext(transformed, ctx, { timeout: 10000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sandbox.client.log(`[Script error] ${message}`);
    throw err;
  }
}
