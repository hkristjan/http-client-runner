/**
 * Verifies the parseXml hook: it must be awaited before the response handler runs, and a
 * hook that declines (returns undefined) must leave behaviour untouched.
 */
import { runString } from '../src/index';

const httpFile = `
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
