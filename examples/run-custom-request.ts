import { runString } from '../src/index';
import type { RequestFn } from '../src/index';
import axios from 'axios';

(async () => {
  let callCount = 0;

  const requestFn: RequestFn = async (config) => {
    callCount++;
    console.log(`[spy] ${String(config.method).toUpperCase()} ${config.url}`);
    return axios(config);
  };

  const content = `
GET https://httpbin.org/get
`;

  const { results } = await runString(content, { requestFn });

  if (results[0].status !== 200) {
    throw new Error(`Expected status 200, got ${results[0].status}`);
  }
  if (callCount !== 1) {
    throw new Error(`Expected requestFn to be called once, got ${callCount}`);
  }
  console.log('✓ requestFn was called once');
  console.log('✓ response status:', results[0].status);
})();
