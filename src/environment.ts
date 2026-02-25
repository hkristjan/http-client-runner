import * as fs from 'fs';
import * as path from 'path';
import type { EnvironmentFile } from './types';

/**
 * Load environment variables from http-client.env.json or http-client.private.env.json.
 *
 * File format (JetBrains convention):
 * {
 *   "development": {
 *     "host": "http://localhost:3000",
 *     "token": "dev-token"
 *   },
 *   "production": {
 *     "host": "https://api.example.com",
 *     "token": "prod-token"
 *   }
 * }
 *
 * Returns a flat object of variables for the chosen environment name.
 */
export function loadEnvironment(
  baseDir: string,
  envName?: string,
): Record<string, string> {
  const vars: Record<string, string> = {};

  if (!envName) return vars;

  // Load in order: public env, then private env (private overrides public)
  const files = ['http-client.env.json', 'http-client.private.env.json'];

  for (const file of files) {
    const filePath = path.resolve(baseDir, file);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content: EnvironmentFile = JSON.parse(
        fs.readFileSync(filePath, 'utf-8'),
      );
      const envVars = content[envName];
      if (envVars && typeof envVars === 'object') {
        Object.assign(vars, envVars);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[http-client] Warning: failed to parse ${file}: ${message}`,
      );
    }
  }

  return vars;
}

/**
 * Substitute {{variable}} placeholders in a string.
 *
 * Resolution order:
 *   1. client.global variables (set by previous response handlers)
 *   2. Environment variables from env files
 *   3. Built-in dynamic variables ($uuid, $timestamp, $randomInt, $isoTimestamp)
 *   4. Process environment variables (process.env)
 */
export function substituteVariables(
  str: string,
  clientVars: Record<string, unknown>,
  envVars: Record<string, string>,
): string;
export function substituteVariables(
  str: string | null,
  clientVars: Record<string, unknown>,
  envVars: Record<string, string>,
): string | null;
export function substituteVariables(
  str: string | null,
  clientVars: Record<string, unknown>,
  envVars: Record<string, string>,
): string | null {
  if (!str) return str;

  return str.replace(/\{\{(.+?)\}\}/g, (_match: string, varName: string) => {
    const name = varName.trim();

    // Dynamic built-in variables
    if (name === '$uuid') return generateUuid();
    if (name === '$timestamp')
      return Math.floor(Date.now() / 1000).toString();
    if (name === '$isoTimestamp') return new Date().toISOString();
    if (name === '$randomInt')
      return Math.floor(Math.random() * 1000).toString();

    // Client globals (from previous handlers)
    if (clientVars[name] !== undefined) return String(clientVars[name]);

    // Environment file variables
    if (envVars[name] !== undefined) return String(envVars[name]);

    // Process env
    if (process.env[name] !== undefined) return process.env[name]!;

    // Leave unresolved
    return `{{${name}}}`;
  });
}

function generateUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
    /[xy]/g,
    (c: string) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    },
  );
}
