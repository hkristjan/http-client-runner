#!/usr/bin/env node

import * as path from 'path';
import { runFile } from './runner';
import { HttpClient } from './client';

// ---------------------------------------------------------------------------
// CLI — run .http files from the terminal
//
//   http-client-runner <file.http> [options]
//
// Options:
//   --env, -e <name>       Environment name from http-client.env.json
//   --var, -v <key=value>  Set a variable (repeatable)
//   --verbose              Print request/response details
//   --help, -h             Show help
// ---------------------------------------------------------------------------

interface CliArgs {
  files: string[];
  environment?: string;
  variables: Record<string, string>;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { files: [], variables: {}, verbose: false };
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--env' || arg === '-e') {
      i++;
      if (!argv[i] || argv[i].startsWith('-')) {
        console.error('Error: --env requires a value (e.g. --env development)');
        process.exit(1);
      }
      args.environment = argv[i];
    } else if (arg === '--var' || arg === '-v') {
      i++;
      const kv = argv[i];
      if (!kv || !kv.includes('=')) {
        console.error('Error: --var requires key=value format (e.g. --var host=localhost)');
        process.exit(1);
      }
      const eqIdx = kv.indexOf('=');
      args.variables[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1);
    } else if (!arg.startsWith('-')) {
      args.files.push(arg);
    } else {
      console.error(`Unknown option: ${arg}`);
      printHelp();
      process.exit(1);
    }

    i++;
  }

  return args;
}

function printHelp(): void {
  console.log(`
http-client-runner — Execute JetBrains-style .http files from the terminal

Usage:
  http-client-runner <file.http> [file2.http ...] [options]

Options:
  --env,  -e <name>        Environment name (from http-client.env.json)
  --var,  -v <key=value>   Set a variable (repeatable)
  --verbose                Print request/response details
  --help, -h               Show this help

Examples:
  http-client-runner api-tests.http --env development --verbose
  http-client-runner auth.http api.http -e staging -v host=https://api.example.com
  http-client-runner tests.http -v token=abc123 -v userId=42
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.files.length) {
    console.error('Error: No .http file specified.\n');
    printHelp();
    process.exit(1);
  }

  const client = new HttpClient({ verbose: args.verbose });
  let totalPassed = 0;
  let totalFailed = 0;
  let totalRequests = 0;

  for (const file of args.files) {
    const resolvedFile = path.resolve(file);

    if (args.verbose || args.files.length > 1) {
      console.log(`\n╔${'═'.repeat(58)}╗`);
      console.log(`║  ${path.basename(resolvedFile).padEnd(56)}║`);
      console.log(`╚${'═'.repeat(58)}╝`);
    }

    const { results, summary } = await runFile(resolvedFile, {
      environment: args.environment,
      variables: args.variables,
      verbose: args.verbose,
      client,
    });

    totalPassed += summary.passedTests;
    totalFailed += summary.failedTests;
    totalRequests += summary.executedRequests;

    // Print results
    for (const r of results) {
      const icon = r.skipped ? '⊘' : r.status && r.status < 400 ? '✓' : '✗';
      if (!args.verbose) {
        console.log(`  ${icon} ${r.name} — ${r.status ?? 'skipped'}`);
      }
      for (const t of r.testResults) {
        console.log(`    ${t.passed ? '✓' : '✗'} ${t.name}${t.error ? ' — ' + t.error : ''}`);
      }
    }
  }

  // Summary line
  const testLine =
    totalPassed + totalFailed > 0
      ? ` | Tests: ${totalPassed} passed, ${totalFailed} failed`
      : '';
  console.log(`\n  Requests: ${totalRequests}${testLine}\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message || err);
  process.exit(1);
});
