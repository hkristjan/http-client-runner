import { runFile } from '../src/index';

(async () => {
  try {
    const { results, summary } = await runFile(__dirname + '/cache-test.http', {
      variables: { host: 'https://httpbin.org' },
      verbose: true,
    });

    console.log('\n' + '='.repeat(60));
    console.log('  CACHE TEST RESULTS');
    console.log('='.repeat(60));

    for (const r of results) {
      const tag = r.cached ? ' (cached)' : '';
      console.log(`\n  ${r.name}: ${r.status}${tag}`);
      for (const t of r.testResults) {
        console.log(`    ${t.passed ? '✓' : '✗'} ${t.name}${t.error ? ' — ' + t.error : ''}`);
      }
    }

    // Verify caching behavior
    const cachedCount = results.filter((r) => r.cached).length;
    console.log(`\n  Cached responses: ${cachedCount}`);

    console.log('\n' + '-'.repeat(60));
    console.log(`  Requests: ${summary.executedRequests}/${summary.totalRequests}`);
    console.log(`  Tests: ${summary.passedTests} passed, ${summary.failedTests} failed`);
    console.log('-'.repeat(60));

    // We expect exactly 2 cached responses (auto-key repeat + named-key repeat)
    if (cachedCount !== 2) {
      console.error(`  ✗ Expected 2 cached responses, got ${cachedCount}`);
      process.exit(1);
    }

    process.exit(summary.failedTests > 0 ? 1 : 0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
