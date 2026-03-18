import * as fs from 'fs';
import * as path from 'path';
import type {
  RequestDescriptor,
  ResponseRedirect,
  CacheDirective,
  ParsedEntry,
  ImportDirective,
  RunDirective,
  VariablesEntry,
} from './types';

// ===========================================================================
// Public API — entry-level parsers
// ===========================================================================

/**
 * Parse a .http file into an array of entries (requests + import/run directives).
 */
export function parseHttpFileEntries(filePath: string): ParsedEntry[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const baseDir = path.dirname(filePath);
  return parseHttpStringEntries(content, baseDir);
}

/**
 * Parse .http content string into entries.
 */
export function parseHttpStringEntries(
  content: string,
  baseDir: string = process.cwd(),
): ParsedEntry[] {
  const blocks = splitRequests(content);
  const entries: ParsedEntry[] = [];

  for (const block of blocks) {
    // Split block into leading directives vs request content.
    // Only lines BEFORE the first request-like line can be directives;
    // anything after (headers, body) must be preserved even if it
    // happens to start with "import" or "run".
    const directiveLines: string[] = [];
    const requestLines: string[] = [];
    let seenRequestLine = false;

    for (const line of block) {
      const trimmed = line.trim();
      if (!seenRequestLine && isDirectiveLine(trimmed)) {
        directiveLines.push(line);
      } else {
        // A non-blank, non-comment line marks the start of request content
        if (
          !seenRequestLine &&
          trimmed &&
          !trimmed.startsWith('#') &&
          !trimmed.startsWith('//')
        ) {
          seenRequestLine = true;
        }
        requestLines.push(line);
      }
    }

    const directiveEntries = extractDirectives(directiveLines, baseDir);
    if (directiveEntries.length) {
      entries.push(...directiveEntries);
    }

    if (requestLines.length) {
      // Extract @variable = value file-level definitions. These appear before
      // the HTTP method line (before seenMethod turns true) and are JetBrains-
      // style file variables that set context for subsequent requests.
      const fileVars: Record<string, string> = {};
      const nonVarLines: string[] = [];
      let seenMethod = false;
      for (const line of requestLines) {
        if (!seenMethod) {
          const trimmed = line.trim();
          const varMatch = trimmed.match(FILE_VAR_RE);
          if (varMatch) {
            fileVars[varMatch[1]] = varMatch[2].trim();
            continue;
          }
          // Any non-blank, non-comment, non-@var line is the start of the request
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//')) {
            seenMethod = true;
          }
        }
        nonVarLines.push(line);
      }

      if (Object.keys(fileVars).length) {
        entries.push({ kind: 'variables', values: fileVars } satisfies VariablesEntry);
      }

      const desc = parseRequestBlock(nonVarLines, baseDir);
      if (desc) {
        entries.push({ kind: 'request', descriptor: desc });
      }
    }
  }

  return entries;
}

/**
 * Parse a .http file returning only request descriptors (backward-compat).
 */
export function parseHttpFile(filePath: string): RequestDescriptor[] {
  return parseHttpFileEntries(filePath)
    .filter((e): e is Extract<ParsedEntry, { kind: 'request' }> => e.kind === 'request')
    .map((e) => e.descriptor);
}

/**
 * Parse .http content string returning only request descriptors (backward-compat).
 */
export function parseHttpString(
  content: string,
  baseDir: string = process.cwd(),
): RequestDescriptor[] {
  return parseHttpStringEntries(content, baseDir)
    .filter((e): e is Extract<ParsedEntry, { kind: 'request' }> => e.kind === 'request')
    .map((e) => e.descriptor);
}

// ===========================================================================
// Directive detection helpers
// ===========================================================================

const IMPORT_RE = /^import\s+(.+\.http)\s*$/;
const RUN_RE = /^run\s+(.+)$/;
// JetBrains-style file-level variable: @varName = value
const FILE_VAR_RE = /^@(\w+)\s*=\s*(.+)$/;

function isDirectiveLine(line: string): boolean {
  const trimmed = line.trim();
  return IMPORT_RE.test(trimmed) || RUN_RE.test(trimmed);
}

/**
 * Extract `import` and `run` directives from a block of lines.
 */
function extractDirectives(
  lines: string[],
  baseDir: string,
): ParsedEntry[] {
  const entries: ParsedEntry[] = [];

  for (const raw of lines) {
    const line = raw.trim();

    // --- import directive ---
    const importMatch = line.match(IMPORT_RE);
    if (importMatch) {
      entries.push({
        kind: 'import',
        filePath: path.resolve(baseDir, importMatch[1].trim()),
      } satisfies ImportDirective);
      continue;
    }

    // --- run directive ---
    const runMatch = line.match(RUN_RE);
    if (runMatch) {
      const runEntry = parseRunDirective(runMatch[1].trim(), baseDir);
      if (runEntry) entries.push(runEntry);
    }
  }

  return entries;
}

/**
 * Parse the argument of a `run` directive.
 *
 * Supported forms:
 *   run ./file.http
 *   run ./file.http (@host=example.com)
 *   run #Request Name
 *   run #Request Name (@host=example.com, @user=joe)
 */
function parseRunDirective(
  arg: string,
  baseDir: string,
): RunDirective {
  const { cleaned, overrides } = extractVariableOverrides(arg);

  if (cleaned.startsWith('#')) {
    return {
      kind: 'run',
      requestName: cleaned.slice(1).trim(),
      filePath: null,
      variableOverrides: overrides,
    };
  }

  return {
    kind: 'run',
    requestName: null,
    filePath: path.resolve(baseDir, cleaned),
    variableOverrides: overrides,
  };
}

/**
 * Extract `(@var=value, @var2=value2)` from the end of a string.
 */
function extractVariableOverrides(
  input: string,
): { cleaned: string; overrides: Record<string, string> } {
  const overrides: Record<string, string> = {};

  // Match trailing  (...)
  const parenMatch = input.match(/\(([^)]+)\)\s*$/);
  if (!parenMatch) {
    return { cleaned: input.trim(), overrides };
  }

  const cleaned = input.slice(0, parenMatch.index).trim();
  const inner = parenMatch[1];

  // Split on comma and parse each @key=value pair
  for (const part of inner.split(',')) {
    const kvMatch = part.trim().match(/^@(\w[\w-]*)=(.+)$/);
    if (kvMatch) {
      overrides[kvMatch[1]] = kvMatch[2].trim();
    }
  }

  return { cleaned, overrides };
}

// ===========================================================================
// Split file content on ### separators
// ===========================================================================
function splitRequests(content: string): string[][] {
  const lines = content.split(/\r?\n/);
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^###\s*/.test(line)) {
      if (current.length) blocks.push(current);
      // The text after ### may be a request name – keep it as first line of new block
      const nameAfterSep = line.replace(/^###\s*/, '').trim();
      current = nameAfterSep ? [`### ${nameAfterSep}`] : [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

// ===========================================================================
// Parse a single request block
// ===========================================================================
function parseRequestBlock(
  lines: string[],
  baseDir: string,
): RequestDescriptor | null {
  let name: string | null = null;
  const directives = new Set<string>();
  let timeout: number | null = null;
  let connectionTimeout: number | null = null;
  let cache: CacheDirective | null = null;
  let preRequestScript: string | null = null;
  let responseHandler: string | null = null;
  let responseRedirect: ResponseRedirect | null = null;

  // First pass: strip comments, directives, name, pre-request scripts
  const cleaned: string[] = [];
  let i = 0;
  // True once we've seen the first non-comment, non-blank, non-directive line
  // (i.e. the HTTP method/URL line). Until then, blank lines and comment lines
  // are skipped so a block that contains only comments/directives (no real
  // request) correctly yields an empty `cleaned` and returns null.
  let seenRequestContent = false;

  while (i < lines.length) {
    const line = lines[i];

    // Request name from ### Name
    if (/^###\s+/.test(line)) {
      name = line.replace(/^###\s+/, '').trim();
      i++;
      continue;
    }

    // @name directive
    const nameMatch = line.match(/^#\s*@name\s*=?\s*(.+)/);
    if (nameMatch) {
      name = nameMatch[1].trim();
      i++;
      continue;
    }

    // Directive comments: # @no-redirect, # @no-log, etc.
    const directiveMatch = line.match(
      /^[#/]{1,2}\s*@(no-redirect|no-log|no-cookie-jar|no-auto-encoding)\s*$/,
    );
    if (directiveMatch) {
      directives.add(directiveMatch[1]);
      i++;
      continue;
    }

    // @timeout
    const timeoutMatch = line.match(
      /^[#/]{1,2}\s*@timeout\s+(\d+)\s*(ms|s|m)?\s*$/,
    );
    if (timeoutMatch) {
      timeout = parseDuration(timeoutMatch[1], timeoutMatch[2]);
      i++;
      continue;
    }

    // @connection-timeout
    const connTimeoutMatch = line.match(
      /^[#/]{1,2}\s*@connection-timeout\s+(\d+)\s*(ms|s|m)?\s*$/,
    );
    if (connTimeoutMatch) {
      connectionTimeout = parseDuration(
        connTimeoutMatch[1],
        connTimeoutMatch[2],
      );
      i++;
      continue;
    }

    // @cache(ttl=30000) or @cache(ttl=30000, key=foo)
    const cacheMatch = line.match(/^[#/]{1,2}\s*@cache\(([^)]+)\)\s*$/);
    if (cacheMatch) {
      cache = parseCacheDirective(cacheMatch[1]);
      i++;
      continue;
    }

    // Pre-request script: < {% ... %}  (may span multiple lines)
    if (/^<\s*\{%/.test(line)) {
      const result = extractInlineScript(lines, i);
      preRequestScript = result.script;
      i = result.endIndex + 1;
      continue;
    }

    // Pre-request script from file: < path/to/script.js
    const preFileMatch = line.match(/^<\s+(.+\.js)\s*$/);
    if (preFileMatch) {
      const scriptPath = path.resolve(baseDir, preFileMatch[1].trim());
      preRequestScript = fs.readFileSync(scriptPath, 'utf-8');
      i++;
      continue;
    }

    // Skip comment lines and blank lines until we reach actual request content.
    // Any line starting with # (including #GET, #POST, etc.) is a comment here —
    // the specific directive patterns above have already been handled.
    if (!seenRequestContent && (/^\s*(\/\/|#)/.test(line) || !line.trim())) {
      i++;
      continue;
    }

    seenRequestContent = true;
    cleaned.push(line);
    i++;
  }

  // Now parse cleaned lines: method+url, headers, body, response handler
  if (!cleaned.length) return null;

  let idx = 0;

  // Skip leading blank lines
  while (idx < cleaned.length && !cleaned[idx].trim()) idx++;
  if (idx >= cleaned.length) return null;

  // --- Request line (method + url) ---
  const { method, url, endIdx } = parseRequestLine(cleaned, idx);
  idx = endIdx;

  // --- Headers ---
  const headers: Record<string, string> = {};
  while (idx < cleaned.length) {
    const hl = cleaned[idx];
    const headerMatch = hl.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (headerMatch) {
      headers[headerMatch[1]] = headerMatch[2].trim();
      idx++;
    } else {
      break;
    }
  }

  // Blank line separates headers from body
  if (idx < cleaned.length && !cleaned[idx].trim()) idx++;

  // --- Body + response handler ---
  const bodyLines: string[] = [];
  while (idx < cleaned.length) {
    const bl = cleaned[idx];

    // Response handler inline: > {% ... %}
    if (/^>\s*\{%/.test(bl)) {
      const result = extractInlineScript(cleaned, idx);
      responseHandler = result.script;
      idx = result.endIndex + 1;
      continue;
    }

    // Response handler from file: > path/to/handler.js
    const handlerFileMatch = bl.match(/^>\s+(.+\.js)\s*$/);
    if (handlerFileMatch) {
      const handlerPath = path.resolve(baseDir, handlerFileMatch[1].trim());
      responseHandler = fs.readFileSync(handlerPath, 'utf-8');
      idx++;
      continue;
    }

    // Response redirect: >> file or >>! file
    const redirectMatch = bl.match(/^(>>!?)\s+(.+)$/);
    if (redirectMatch) {
      responseRedirect = {
        path: redirectMatch[2].trim(),
        overwrite: redirectMatch[1] === '>>!',
      };
      idx++;
      continue;
    }

    // Body from file: < ./path/to/file
    const bodyFileMatch = bl.match(/^<\s+(.+)$/);
    if (bodyFileMatch && !bl.match(/^<\s*\{%/)) {
      const bodyPath = path.resolve(baseDir, bodyFileMatch[1].trim());
      bodyLines.push(fs.readFileSync(bodyPath, 'utf-8'));
      idx++;
      continue;
    }

    bodyLines.push(bl);
    idx++;
  }

  // Trim trailing blank lines from body
  while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim())
    bodyLines.pop();
  const body = bodyLines.length ? bodyLines.join('\n') : null;

  if (!url) return null;

  return {
    name,
    method: method || 'GET',
    url,
    headers,
    body,
    preRequestScript,
    responseHandler,
    responseRedirect,
    directives,
    timeout,
    connectionTimeout,
    cache,
  };
}

// ===========================================================================
// Parse the request line, handling multi-line URLs (continuation via indent)
// ===========================================================================
interface RequestLineResult {
  method: string;
  url: string;
  endIdx: number;
}

function parseRequestLine(
  lines: string[],
  startIdx: number,
): RequestLineResult {
  const first = lines[startIdx].trim();
  const methodMatch = first.match(
    /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+(.+)/i,
  );

  let method: string;
  let urlParts: string[];
  if (methodMatch) {
    method = methodMatch[1].toUpperCase();
    urlParts = [methodMatch[2].replace(/\s+HTTP\/[\d.]+\s*$/, '').trim()];
  } else {
    // No explicit method – default to GET
    method = 'GET';
    urlParts = [first.replace(/\s+HTTP\/[\d.]+\s*$/, '').trim()];
  }

  let idx = startIdx + 1;
  // Continuation lines for URL (indented lines that don't look like headers)
  while (idx < lines.length) {
    const l = lines[idx];
    if (/^\s+/.test(l) && !l.match(/^[A-Za-z0-9_-]+\s*:/)) {
      urlParts.push(l.trim());
      idx++;
    } else {
      break;
    }
  }

  return { method, url: urlParts.join(''), endIdx: idx };
}

// ===========================================================================
// Extract inline script between {% and %}
// ===========================================================================
interface InlineScriptResult {
  script: string;
  endIndex: number;
}

function extractInlineScript(
  lines: string[],
  startIdx: number,
): InlineScriptResult {
  let joined = '';
  let endIndex = startIdx;
  let started = false;

  for (let j = startIdx; j < lines.length; j++) {
    const l = lines[j];
    endIndex = j;

    // Look for {% to start
    const openPos = l.indexOf('{%');
    if (!started && openPos !== -1) {
      started = true;
      // Everything after {%
      const afterOpen = l.substring(openPos + 2);
      // Check for closing %} on same line
      const closePos = afterOpen.indexOf('%}');
      if (closePos !== -1) {
        joined += afterOpen.substring(0, closePos);
        return { script: joined.trim(), endIndex: j };
      }
      joined += afterOpen + '\n';
      continue;
    }

    if (started) {
      const closePos = l.indexOf('%}');
      if (closePos !== -1) {
        joined += l.substring(0, closePos);
        return { script: joined.trim(), endIndex: j };
      }
      joined += l + '\n';
    }
  }

  return { script: joined.trim(), endIndex };
}

// ===========================================================================
// Parse duration values
// ===========================================================================
function parseDuration(value: string, unit?: string): number {
  const num = parseInt(value, 10);
  switch (unit) {
    case 's':
      return num * 1000;
    case 'm':
      return num * 60 * 1000;
    case 'ms':
    default:
      return num;
  }
}

// ===========================================================================
// Parse @cache directive parameters
// ===========================================================================
function parseCacheDirective(params: string): CacheDirective | null {
  let ttl: number | null = null;
  let key: string | undefined;

  for (const part of params.split(',')) {
    const kvMatch = part.trim().match(/^(\w+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const [, k, v] = kvMatch;
    if (k === 'ttl') {
      ttl = parseInt(v.trim(), 10);
      if (isNaN(ttl)) return null;
    } else if (k === 'key') {
      key = v.trim();
    }
  }

  if (ttl == null) return null;
  return { ttl, ...(key !== undefined && { key }) };
}
