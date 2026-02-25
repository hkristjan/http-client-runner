import { runFile } from '../src/index';

(async () => {
  try {
    const { results, summary } = await runFile('./examples/test.http', {
      variables: { host: 'https://httpbin.org' },
      verbose: true,
    });

    process.exit(summary.failedTests > 0 ? 1 : 0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
