import { MemoryCacheAdapter } from './cache';
import type {
  CacheAdapter,
  ClientGlobal,
  ClientGlobalHeaders,
  HttpClientRunnerRunnerOptions,
  TestResult,
} from './types';

/**
 * Mimics the JetBrains HTTP Client `client` object available in JS handlers.
 *
 * API:
 *   client.global.set(name, value)
 *   client.global.get(name)
 *   client.global.isEmpty()
 *   client.global.clear(name)
 *   client.global.clearAll()
 *   client.global.headers.set(name, value)
 *   client.global.headers.clear(name)
 *   client.test(name, fn)
 *   client.assert(condition, message)
 *   client.log(text)
 *   client.exit()
 */
export class HttpClientRunner {
  private _variables: Map<string, unknown> = new Map();
  private _headers: Map<string, string> = new Map();
  private _tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];
  public _logs: string[] = [];
  private _verbose: boolean;
  private _exited: boolean = false;
  private _cacheAdapter: CacheAdapter;

  public global: ClientGlobal;

  /** Restricted cache access for script sandboxes. */
  public cache: {
    delete(key: string): Promise<boolean>;
    clear(): Promise<void>;
  };

  constructor(options: HttpClientRunnerRunnerOptions = {}) {
    this._verbose = options.verbose ?? false;
    this._cacheAdapter = options.cacheAdapter ?? new MemoryCacheAdapter();
    this.cache = {
      delete: (key: string) => this._cacheAdapter.delete(key),
      clear: () => this._cacheAdapter.clear(),
    };

    this.global = {
      set: (name: string, value: unknown): void => {
        this._variables.set(name, value);
      },
      get: (name: string): unknown => {
        return this._variables.get(name);
      },
      isEmpty: (): boolean => {
        return this._variables.size === 0;
      },
      clear: (name: string): void => {
        this._variables.delete(name);
      },
      clearAll: (): void => {
        this._variables.clear();
      },
      headers: {
        set: (name: string, value: string): void => {
          this._headers.set(name, value);
        },
        clear: (name: string): void => {
          this._headers.delete(name);
        },
      } as ClientGlobalHeaders,
    };
  }

  test(name: string, fn: () => void | Promise<void>): void {
    this._tests.push({ name, fn });
  }

  assert(condition: boolean, message?: string): void {
    if (!condition) {
      throw new Error(`Assertion failed: ${message || '(no message)'}`);
    }
  }

  log(text: string): void {
    this._logs.push(text);
    if (this._verbose) {
      console.log(`[http-client] ${text}`);
    }
  }

  exit(): void {
    this._exited = true;
  }

  /** Run accumulated tests after response handler completes. */
  async runTests(): Promise<TestResult[]> {
    const results: TestResult[] = [];
    for (const { name, fn } of this._tests) {
      try {
        await fn();
        results.push({ name, passed: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ name, passed: false, error: message });
      }
    }
    // Clear tests for next request
    this._tests = [];
    return results;
  }

  /** Return all global variables as a plain object (for variable substitution). */
  getVariables(): Record<string, unknown> {
    return Object.fromEntries(this._variables);
  }

  /** Return all global headers as a plain object. */
  getGlobalHeaders(): Record<string, string> {
    return Object.fromEntries(this._headers);
  }

  /** Check if exit() was called. */
  get exited(): boolean {
    return this._exited;
  }

  /** Reset exit flag for next request. */
  resetExit(): void {
    this._exited = false;
  }

  /** Get the cache adapter (used by executor). */
  getCacheAdapter(): CacheAdapter {
    return this._cacheAdapter;
  }
}
