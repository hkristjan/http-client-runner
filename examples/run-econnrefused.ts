import * as net from 'net';
import { runString } from '../src/index';

/**
 * Finds a free OS-assigned port by briefly binding to it, then closes the
 * server before returning. Connecting to that port afterwards guarantees
 * ECONNREFUSED because nothing is listening.
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

(async () => {
  try {
    const port = await getFreePort();
    const content = `
### ECONNREFUSED request
GET http://127.0.0.1:${port}/test
`;

    const { results, summary } = await runString(content, { verbose: true });

    let pass = true;

    if (results.length !== 1) {
      console.error(`FAIL: expected 1 result, got ${results.length}`);
      pass = false;
    }

    const r = results[0];

    if (r.networkError == null) {
      console.error('FAIL: expected networkError to be set, got null');
      pass = false;
    } else {
      console.log(`  ✓ networkError captured: "${r.networkError}"`);
    }

    if (r.status !== 0) {
      console.error(`FAIL: expected status 0, got ${r.status}`);
      pass = false;
    } else {
      console.log(`  ✓ status is 0`);
    }

    if (summary.failedRequests !== 1) {
      console.error(`FAIL: expected summary.failedRequests = 1, got ${summary.failedRequests}`);
      pass = false;
    } else {
      console.log(`  ✓ summary.failedRequests = 1`);
    }

    if (summary.executedRequests !== 1) {
      console.error(`FAIL: expected summary.executedRequests = 1, got ${summary.executedRequests}`);
      pass = false;
    } else {
      console.log(`  ✓ summary.executedRequests = 1`);
    }

    console.log(pass ? '\n  All assertions passed.\n' : '\n  Some assertions FAILED.\n');
    process.exit(pass ? 0 : 1);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
