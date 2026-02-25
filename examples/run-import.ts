import { runFile } from '../src/index';

(async () => {
  try {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  import / run  example                                  ║');
    console.log('╚══════════════════════════════════════════════════════════╝');

    const { results, summary } = await runFile(__dirname + '/import-run.http', {
      variables: { host: 'https://httpbin.org' },
      verbose: true,
    });

    console.log('\n' + '='.repeat(60));
    console.log('  RESULTS');
    console.log('='.repeat(60));

    for (const r of results) {
      const icon = r.skipped ? '⊘' : r.status && r.status < 400 ? '✓' : '✗';
      console.log(`\n  ${icon} ${r.name}: ${r.status ?? 'skipped'}`);
      for (const t of r.testResults) {
        console.log(
          `    ${t.passed ? '✓' : '✗'} ${t.name}${t.error ? ' — ' + t.error : ''}`,
        );
      }
    }

    console.log('\n' + '-'.repeat(60));
    console.log(
      `  Requests: ${summary.executedRequests}/${summary.totalRequests}`,
    );
    console.log(
      `  Tests: ${summary.passedTests} passed, ${summary.failedTests} failed`,
    );
    console.log('-'.repeat(60));

    process.exit(summary.failedTests > 0 ? 1 : 0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
