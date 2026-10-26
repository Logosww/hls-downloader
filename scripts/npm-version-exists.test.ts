import { test } from 'node:test';
import assert from 'node:assert/strict';
import { npmVersionExists } from './npm-version-exists.ts';

const name = '@hls-downloader/rust-native-linux-x64-gnu';
const version = '4.0.0';
const respond = (status: number, body: unknown = {}) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

test('checks the exact scoped package version', async () => {
  const request = (async (url: string) => {
    assert.equal(
      url,
      'https://registry.npmjs.org/%40hls-downloader%2Frust-native-linux-x64-gnu/4.0.0',
    );
    return Response.json({ name, version });
  }) as typeof fetch;
  assert.equal(await npmVersionExists(name, version, request), true);
});

test('only 404 permits a new publication', async () => {
  assert.equal(await npmVersionExists(name, version, respond(404)), false);
  for (const status of [401, 403, 429, 500])
    await assert.rejects(npmVersionExists(name, version, respond(status)), /registry returned/);
});

test('rejects unexpected versions, invalid JSON and connection failures', async () => {
  await assert.rejects(
    npmVersionExists(name, version, respond(200, { name, version: '3.7.0' })),
    /Unexpected registry metadata/,
  );
  await assert.rejects(
    npmVersionExists(name, version, respond(200, { name: 'another-package', version })),
    /Unexpected registry metadata/,
  );
  await assert.rejects(
    npmVersionExists(name, version, (async () => new Response('invalid')) as typeof fetch),
  );
  await assert.rejects(
    npmVersionExists(name, version, (async () => {
      throw new Error('offline');
    }) as typeof fetch),
    /offline/,
  );
});
