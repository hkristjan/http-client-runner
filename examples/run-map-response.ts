/**
 * Verifies client.mapResponse() records intent without performing work.
 */
import { HttpClientRunner, runString } from '../src/index';

async function main() {
  const client = new HttpClientRunner();

  if (client.takePendingMap() !== undefined) {
    throw new Error('a fresh client must have no pending map');
  }

  client.mapResponse('some/mapping.json', { locale: 'en-GB' });
  const pending = client.takePendingMap();
  if (pending?.mappingPath !== 'some/mapping.json') {
    throw new Error(`expected the recorded mapping path, got ${JSON.stringify(pending)}`);
  }
  if ((pending.extraContext as { locale?: string }).locale !== 'en-GB') {
    throw new Error('extraContext was not recorded');
  }

  if (client.takePendingMap() !== undefined) {
    throw new Error('takePendingMap must clear the pending map');
  }

  client.mapResponse('first.json', {});
  client.mapResponse('second.json', {});
  if (client.takePendingMap()?.mappingPath !== 'second.json') {
    throw new Error('a second mapResponse call must replace the first');
  }

  client.mapResponse('defaulted.json');
  if (JSON.stringify(client.takePendingMap()?.extraContext) !== '{}') {
    throw new Error('extraContext must default to an empty object');
  }

  console.log('✓ client.mapResponse records intent correctly');

  const httpFile = `
GET https://httpbin.org/xml
Accept: application/xml

> {%
    client.mapResponse("test/mapping.json", { marker: "from-handler" });
    client.test("body is mapped by the time tests run", () => {
        client.assert(response.body.mapped === true, "expected mapped body inside the test");
    });
%}
`;

  let hookCalls = 0;
  const run = await runString(httpFile, {
    mapResponse: async (mappingPath, response, extraContext) => {
      hookCalls++;
      if (mappingPath !== 'test/mapping.json') {
        throw new Error(`hook got the wrong mapping path: ${mappingPath}`);
      }
      if ((extraContext as { marker?: string }).marker !== 'from-handler') {
        throw new Error('hook did not receive extraContext');
      }
      if (typeof response.body !== 'string') {
        throw new Error('hook must see the raw, unmapped body');
      }
      return { mapped: true };
    },
  });

  const body = run.results[0].response?.body as { mapped?: boolean };
  if (hookCalls !== 1 || body?.mapped !== true) {
    throw new Error(`hook calls: ${hookCalls}, body: ${JSON.stringify(body)}`);
  }
  if (run.results[0].testResults.some((t) => !t.passed)) {
    throw new Error('mapping must be applied BEFORE runTests');
  }

  // A handler that records no mapping must be unaffected.
  const untouched = await runString(
    `
GET https://httpbin.org/xml

> {%
    client.global.set("ran", "yes");
%}
`,
    { mapResponse: async () => ({ mapped: true }) },
  );
  if (typeof untouched.results[0].response?.body !== 'string') {
    throw new Error('a response with no recorded mapping must not be mapped');
  }

  // A recorded mapping with no hook injected is a hard error.
  let threw = false;
  try {
    await runString(httpFile);
  } catch (err) {
    threw = true;
    if (!String(err).includes('mapResponse')) {
      throw new Error(`unhelpful error message: ${String(err)}`);
    }
  }
  if (!threw) {
    throw new Error('a pending map with no hook must throw, not silently skip mapping');
  }

  console.log('✓ runner applies the pending map, before tests, and fails loudly with no hook');

  // --- Cache-hit path: the pending map must be applied on the cached run too ---
  const cachedHttpFile = `
# @cache(ttl=30000)
GET https://httpbin.org/xml
Accept: application/xml

> {%
    client.mapResponse("test/mapping.json", {});
%}
`;

  let cachePathHookCalls = 0;
  const cacheClient = new HttpClientRunner();
  const countingHook = async () => {
    cachePathHookCalls++;
    return { mapped: true };
  };

  const freshRun = await runString(cachedHttpFile, { client: cacheClient, mapResponse: countingHook });
  if (freshRun.results[0].cached) {
    throw new Error('test setup error: expected the first request to be a fresh response');
  }

  const cachedRun = await runString(cachedHttpFile, { client: cacheClient, mapResponse: countingHook });
  if (!cachedRun.results[0].cached) {
    throw new Error('test setup error: expected the second request to be served from cache — the cache-hit path was not exercised');
  }

  const cachedBody = cachedRun.results[0].response?.body as { mapped?: boolean };
  if (cachePathHookCalls !== 2 || cachedBody?.mapped !== true) {
    throw new Error(`cache-path hook calls: ${cachePathHookCalls}, cached body: ${JSON.stringify(cachedBody)}`);
  }

  console.log('✓ pending map is applied on the cache-hit path too');

  // --- A mapping recorded by a pre-request script (no responseHandler on that request) must
  // be drained on THAT request, not leak forward onto the next request in the file. ---
  const leakHttpFile = `
GET https://httpbin.org/get

< {%
    client.mapResponse("leaked/mapping.json", {});
%}

###

GET https://httpbin.org/xml
`;

  let leakHookCalls = 0;
  const leakRun = await runString(leakHttpFile, {
    mapResponse: async () => {
      leakHookCalls++;
      return { mapped: true };
    },
  });

  if (leakHookCalls !== 1) {
    throw new Error(
      `expected the pending map to be applied exactly once, to the request that recorded it — hook called ${leakHookCalls} times`,
    );
  }
  const firstBody = leakRun.results[0].response?.body as { mapped?: boolean };
  if (firstBody?.mapped !== true) {
    throw new Error(`request 1 (which recorded the mapping) should have been mapped: ${JSON.stringify(firstBody)}`);
  }
  const secondBody = leakRun.results[1].response?.body;
  if (typeof secondBody !== 'string') {
    throw new Error(
      `the pending map from request 1 leaked onto request 2's response: ${JSON.stringify(secondBody)}`,
    );
  }

  console.log('✓ a mapping recorded with no response handler is drained on its own request, not leaked forward');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
