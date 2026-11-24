import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';
const env = {SITE_USERNAME: 'friends', SITE_PASSWORD: 'test-only-password-123456789'};
const good = 'Basic ' + btoa(env.SITE_USERNAME + ':' + env.SITE_PASSWORD);
const request = (path = '/', auth, method = 'GET') => new Request('https://example.test' + path, {method, headers: auth ? {Authorization: auth} : {}});
test('all anonymous paths are protected without leaking game HTML', async () => {
  for (const path of ['/', '/index.html', '/worker/index.js', '/.env', '/dist/server/index.js', '/%2e%2e/index.html']) {
    const r = await worker.fetch(request(path), env);
    assert.equal(r.status, 401);
    assert.match(r.headers.get('WWW-Authenticate'), /^Basic /);
    assert.match(r.headers.get('Cache-Control'), /no-store/);
    assert.doesNotMatch(await r.text(), /<script|<svg|Шашки/);
  }
});
test('wrong, malformed and oversized credentials fail', async () => {
  for (const auth of ['Basic !!!', 'Bearer secret', 'Basic ' + btoa('friends:wrong'), 'Basic ' + 'A'.repeat(3000)]) {
    assert.equal((await worker.fetch(request('/', auth), env)).status, 401);
  }
});
test('missing or weak server secret fails closed', async () => {
  for (const e of [{}, {...env, SITE_PASSWORD: ''}, {...env, SITE_PASSWORD: 'short'}]) {
    assert.equal((await worker.fetch(request('/', good), e)).status, 503);
  }
});
test('valid credentials unlock games; source paths stay unavailable', async () => {
  const r = await worker.fetch(request('/', good), env);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Шашки/);
  assert.match(r.headers.get('X-Robots-Tag'), /noindex/);
  assert.equal((await worker.fetch(request('/.env', good), env)).status, 404);
  assert.equal((await worker.fetch(request('/', good, 'POST'), env)).status, 405);
  const head = await worker.fetch(request('/', good, 'HEAD'), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
