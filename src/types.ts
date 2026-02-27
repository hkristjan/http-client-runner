import type { AxiosResponse } from 'axios';
import type { HttpClient } from './client';

/** Parsed request descriptor from an .http file */
export interface RequestDescriptor {
  name: string | null;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  preRequestScript: string | null;
  responseHandler: string | null;
  responseRedirect: ResponseRedirect | null;
  directives: Set<string>;
  timeout: number | null;
  connectionTimeout: number | null;
}

export interface ResponseRedirect {
  path: string;
  overwrite: boolean;
}

/** Content type info extracted from response headers */
export interface ContentType {
  mimeType: string;
  charset: string | null;
}

/** Response headers accessor */
export interface ResponseHeaders {
  valueOf(name: string): string | null;
  valuesOf(name: string): string[];
}

/** Unified response interface (both success and error) */
export interface IHttpResponse {
  status: number;
  body: unknown;
  contentType: ContentType;
  headers: ResponseHeaders;
}

/** Client global variable/header storage */
export interface ClientGlobalHeaders {
  set(name: string, value: string): void;
  clear(name: string): void;
}

export interface ClientGlobal {
  set(name: string, value: unknown): void;
  get(name: string): unknown;
  isEmpty(): boolean;
  clear(name: string): void;
  clearAll(): void;
  headers: ClientGlobalHeaders;
}

/** Test result from response handler */
export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

/** Request proxy available in pre-request scripts */
export interface RequestProxy {
  variables: {
    set(name: string, value: string): void;
    get(name: string): string | undefined;
  };
  body: {
    getRaw(): string | undefined;
    tryGetSubstituted(): string | undefined;
  };
  headers: {
    findByName(name: string): string | null;
  };
  url: {
    tryGetSubstituted(): string;
  };
  environment: {
    get(name: string): string | undefined;
  };
}

/** Script sandbox context */
export interface ScriptSandbox {
  client: HttpClient;
  response?: IHttpResponse;
  request?: RequestProxy;
}

/** Result of executing a single request */
export interface ExecutionResult {
  response: IHttpResponse | null;
  testResults: TestResult[];
  logs: string[];
  skipped: boolean;
  /** Non-null when the request failed at the network level (e.g. ECONNREFUSED, ETIMEDOUT). */
  networkError: string | null;
}

/** Per-request result in a run */
export interface RequestResult {
  name: string;
  request: {
    method: string;
    url: string;
  };
  status: number | null;
  response: IHttpResponse | null;
  testResults: TestResult[];
  logs: string[];
  skipped: boolean;
  /** Non-null when the request failed at the network level (e.g. ECONNREFUSED, ETIMEDOUT). */
  networkError: string | null;
}

/** Summary of an entire run */
export interface RunSummary {
  totalRequests: number;
  executedRequests: number;
  skippedRequests: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  /** Requests that failed at the network level (no HTTP response received). */
  failedRequests: number;
}

/** Full result of runFile / runString */
export interface RunResult {
  results: RequestResult[];
  summary: RunSummary;
  client: HttpClient;
}

/** Options for runFile / runString */
export interface RunOptions {
  environment?: string;
  variables?: Record<string, string>;
  verbose?: boolean;
  client?: HttpClient;
  baseDir?: string;
}

/** Options for executeRequest */
export interface ExecuteOptions {
  verbose?: boolean;
  baseDir?: string;
}

/** Options for HttpClient constructor */
export interface HttpClientOptions {
  verbose?: boolean;
}

/** Environment file structure */
export interface EnvironmentFile {
  [envName: string]: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Import / Run directives
// ---------------------------------------------------------------------------

/** `import other-file.http` — makes named requests available for `run #name` */
export interface ImportDirective {
  kind: 'import';
  filePath: string;
}

/**
 * `run ./file.http`              — execute all requests from a file
 * `run #Request Name`            — execute a named request from an imported file
 * `run #Name (@var=val, @b=val)` — execute with variable overrides
 */
export interface RunDirective {
  kind: 'run';
  /** Non-null when running a named request (the part after `#`). */
  requestName: string | null;
  /** Non-null when running an entire file. */
  filePath: string | null;
  /** `(@key=value)` overrides parsed from the directive line. */
  variableOverrides: Record<string, string>;
}

/**
 * File-level variable definitions: `@varName = value`
 * These set variables in scope for all subsequent requests in the file.
 */
export interface VariablesEntry {
  kind: 'variables';
  values: Record<string, string>;
}

/** A parsed entry in an .http file — either a real request or a directive. */
export type ParsedEntry =
  | { kind: 'request'; descriptor: RequestDescriptor }
  | ImportDirective
  | RunDirective
  | VariablesEntry;
