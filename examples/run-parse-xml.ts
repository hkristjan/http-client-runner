/**
 * Verifies the parseXml hook: it must be awaited before the response handler runs, and a
 * hook that declines (returns undefined) must leave behaviour untouched. Also verifies the
 * cache-hit path specifically — a cached response still runs the response handler, and the
 * hook must fire (and be honoured/declined) there too, not just on the fresh-response path.
 */
import { runString, HttpClientRunner } from '../src/index';

const httpFile = `
GET https://httpbin.org/xml
Accept: application/xml

> {%
    client.global.set("sawParsedBody", response.parsedBody ? "yes" : "no");
%}
`;

// Same request, but with a cache directive so the second run is served from cache while
// still invoking the response handler (and therefore the parseXml hook).
const cachedHttpFile = `
# @cache(ttl=30000)
GET https://httpbin.org/xml
Accept: application/xml

> {%
    client.global.set("sawParsedBody", response.parsedBody ? "yes" : "no");
%}
`;

async function main() {
  let hookCalls = 0;

  const withHook = await runString(httpFile, {
    parseXml: async (xml, mimeType) => {
      hookCalls++;
      console.log(`  hook called: ${xml.length} bytes, mime=${mimeType}`);
      return { marker: 'parsed-by-hook' };
    },
  });

  const sawParsedBody = withHook.client.global.get('sawParsedBody');
  console.log(`hook calls: ${hookCalls}, handler saw parsedBody: ${sawParsedBody}`);
  if (hookCalls !== 1 || sawParsedBody !== 'yes') {
    throw new Error('parseXml hook was not awaited before the response handler ran');
  }

  const declining = await runString(httpFile, { parseXml: async () => undefined });
  if (declining.client.global.get('sawParsedBody') !== 'no') {
    throw new Error('a declining hook must leave parsedBody unset');
  }

  const noHook = await runString(httpFile);
  if (noHook.client.global.get('sawParsedBody') !== 'no') {
    throw new Error('behaviour must be unchanged when no hook is supplied');
  }

  console.log('✓ parseXml hook behaves correctly in all three modes');

  // --- Cache-hit path: a parsing hook must fire on the cached (second) request too ---
  let hookCallsOnCachedPath = 0;
  const parsingClient = new HttpClientRunner();
  const parsingHook = async (xml: string, mimeType: string) => {
    hookCallsOnCachedPath++;
    console.log(`  [cache-path] hook called: ${xml.length} bytes, mime=${mimeType}`);
    return { marker: 'parsed-by-hook' };
  };

  const firstRun = await runString(cachedHttpFile, { client: parsingClient, parseXml: parsingHook });
  if (firstRun.results[0].cached) {
    throw new Error('test setup error: expected the first request to be a fresh (non-cached) response');
  }
  const sawOnFresh = parsingClient.global.get('sawParsedBody');

  const secondRun = await runString(cachedHttpFile, { client: parsingClient, parseXml: parsingHook });
  if (!secondRun.results[0].cached) {
    throw new Error('test setup error: expected the second request to be served from cache — the cache-hit path was not actually exercised');
  }
  const sawOnCached = parsingClient.global.get('sawParsedBody');

  console.log(
    `cache-path hook calls: ${hookCallsOnCachedPath}, fresh saw parsedBody: ${sawOnFresh}, cached saw parsedBody: ${sawOnCached}`,
  );
  if (hookCallsOnCachedPath !== 2 || sawOnFresh !== 'yes' || sawOnCached !== 'yes') {
    throw new Error('parseXml hook must be awaited and populate parsedBody on the cache-hit path, not just the fresh-response path');
  }

  // --- Cache-hit path: a declining hook must leave parsedBody unset on the cached run too ---
  const decliningClient = new HttpClientRunner();
  const decliningFirstRun = await runString(cachedHttpFile, { client: decliningClient, parseXml: async () => undefined });
  if (decliningFirstRun.results[0].cached) {
    throw new Error('test setup error: expected the first declining-hook request to be fresh');
  }
  const decliningSecondRun = await runString(cachedHttpFile, { client: decliningClient, parseXml: async () => undefined });
  if (!decliningSecondRun.results[0].cached) {
    throw new Error('test setup error: expected the second declining-hook request to be served from cache');
  }
  if (decliningClient.global.get('sawParsedBody') !== 'no') {
    throw new Error('a declining hook must leave parsedBody unset on the cached run too');
  }

  console.log('✓ parseXml hook correctly reaches the cache-hit response-handler path, in both parsing and declining modes');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
