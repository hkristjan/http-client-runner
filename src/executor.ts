import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';
import * as vm from 'vm';
import * as fs from 'fs';
import * as path from 'path';
import { HttpResponse, HttpErrorResponse } from './response';
import { substituteVariables } from './environment';
import { HttpClient } from './client';
import type {
  RequestDescriptor,
  ExecutionResult,
  ExecuteOptions,
  ScriptSandbox,
  RequestProxy,
  IHttpResponse,
  TestResult,
} from './types';

/**
 * Execute a single parsed request descriptor.
 */
export async function executeRequest(
  request: RequestDescriptor,
  client: HttpClient,
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
    runScript(request.preRequestScript, { client, request: requestProxy });
    if (client.exited) {
      return {
        response: null,
        testResults: [],
        logs: [...client._logs],
        skipped: true,
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

  if (verbose) {
    console.log(`\n→ ${request.method} ${url}`);
  }

  // --- Execute request ---
  let response: IHttpResponse;
  try {
    const axiosResp = await axios(axiosConfig);
    response = new HttpResponse(axiosResp);
  } catch (err) {
    response = new HttpErrorResponse(err as AxiosError);
    if (verbose) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ Request error: ${message}`);
    }
  }

  if (verbose) {
    console.log(`  ← ${response.status} ${response.contentType.mimeType}`);
  }

  // --- Response redirect (>> file) ---
  if (request.responseRedirect) {
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
      // Append numeric suffix
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

  // --- Response handler script ---
  let testResults: TestResult[] = [];
  if (request.responseHandler) {
    client.resetExit();
    runScript(request.responseHandler, { client, response });
    testResults = await client.runTests();
  }

  return {
    response,
    testResults,
    logs: [...client._logs],
    skipped: false,
  };
}

/**
 * Run a JS script string in a sandboxed VM context.
 */
function runScript(script: string, sandbox: ScriptSandbox): void {
  const ctx = vm.createContext({
    ...sandbox,
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
    vm.runInContext(script, ctx, { timeout: 10000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sandbox.client.log(`[Script error] ${message}`);
    throw err;
  }
}
