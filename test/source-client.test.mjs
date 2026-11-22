import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceClient, PageNotPublishedError, SourceUnavailableError } from '../src/index.mjs';

function stubFetch(handlers) {
  return async (url, options) => {
    const key = url.replace('http://local', '');
    const handler = handlers[key];
    if (!handler) throw new Error('未预期的请求 ' + key);
    const { status, body, headers = {} } = handler;
    return {
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      json: async () => body,
    };
  };
}

test('404 归类为页未发布，503 归类为暂不可用', async () => {
  const client = new SourceClient({
    baseUrl: 'http://local',
    fetchImpl: stubFetch({
      '/v1/interim/east-cert': { status: 404, body: { message: '未发布' } },
      '/v1/interim/north-cert': { status: 503, body: { message: '不可用' } },
    }),
  });
  await assert.rejects(() => client.getResource('interim', 'east-cert'), PageNotPublishedError);
  await assert.rejects(() => client.getResource('interim', 'north-cert'), SourceUnavailableError);

  // fetchPage 不抛错，返回结构化缺口供引擎登记“查不到”。
  const missing = await client.fetchPage('interim', 'east-cert');
  assert.deepEqual(missing, { phase: 'interim', resource: 'east-cert',
    available: false, reason: 'not-published' });
  const down = await client.fetchPage('interim', 'north-cert');
  assert.equal(down.reason, 'unavailable');
  assert.equal(down.status, 503);
});

test('门户 201 首收、200 重放、409 报文冲突均如实区分', async () => {
  const calls = [];
  const client = new SourceClient({
    baseUrl: 'http://local',
    fetchImpl: async (url, options) => {
      calls.push(options);
      const status = calls.length === 1 ? 201 : calls.length === 2 ? 200 : 409;
      return {
        status,
        headers: { get: () => null },
        json: async () => ({ sourceRef: 'confirmed-1', result: 'accepted' }),
      };
    },
  });
  const payload = { action: 'substitute', key: 'K1', facts: { x: 1 } };
  const first = await client.postPortal('confirmed', payload);
  assert.equal(first.status, 201);
  assert.equal(first.duplicated, false);
  const replay = await client.postPortal('confirmed', payload);
  assert.equal(replay.duplicated, true);
  const conflict = await client.postPortal('confirmed', { ...payload, facts: { x: 2 } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.ok, false);
});
