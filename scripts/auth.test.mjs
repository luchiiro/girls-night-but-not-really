import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';
const env = {SITE_PASSWORD: 'test-password', SESSION_SECRET: 'test-session-key-that-is-over-thirty-two-characters'};
const origin = 'https://example.test';
const get = (path = '/', cookie, extra = {}) => new Request(origin + path, {headers: {...(cookie ? {Cookie: cookie} : {}), ...extra}});
function post(password, extra = {}, path = '/login') {
  return new Request(origin + path, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...extra}, body: new URLSearchParams({password})});
}
async function enter() {
  const response = await worker.fetch(post(env.SITE_PASSWORD), env);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/');
  const cookie = response.headers.get('Set-Cookie');
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag));
  assert.ok(!cookie.includes(env.SITE_PASSWORD));
  return cookie.split(';')[0];
}
test('anonymous requests show only a password form, never games or source', async () => {
  for (const path of ['/', '/index.html', '/worker/index.js', '/.env', '/dist/server/index.js']) {
    const r = await worker.fetch(get(path), env), html = await r.text();
    assert.equal(r.status, 200);
    assert.match(html, /name="password"/);
    assert.doesNotMatch(html, /name="username"|Шашки|__SITE_HTML__|test-password/);
    assert.equal(r.headers.get('WWW-Authenticate'), null);
    assert.match(r.headers.get('Cache-Control'), /no-store/);
  }
});
test('correct password opens games and logout clears the cookie', async () => {
  const cookie = await enter();
  const r = await worker.fetch(get('/', cookie), env);
  assert.match(await r.text(), /Шашки/);
  assert.equal((await worker.fetch(get('/.env', cookie), env)).status, 404);
  const out = await worker.fetch(post('', {}, '/logout'), env);
  assert.equal(out.status, 303);
  assert.match(out.headers.get('Set-Cookie'), /Max-Age=0/);
});
test('wrong password and legacy Basic auth never open games', async () => {
  const r = await worker.fetch(post('wrong'), env);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('Set-Cookie'), null);
  assert.match(await r.text(), /Пароль не подошёл/);
  const legacy = await worker.fetch(get('/', null, {Authorization: 'Basic ' + btoa('friends:' + env.SITE_PASSWORD)}), env);
  assert.doesNotMatch(await legacy.text(), /Шашки/);
});
test('forged, expired and password-revoked cookies fail', async () => {
  const cookie = await enter();
  for (const forged of [cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a'), '__Host-gn-session=anything']) {
    assert.doesNotMatch(await (await worker.fetch(get('/', forged), env)).text(), /Шашки/);
  }
  assert.doesNotMatch(await (await worker.fetch(get('/', cookie), {...env, SITE_PASSWORD: 'changed'})).text(), /Шашки/);
  const now = Date.now;
  try { Date.now = () => now() + 8 * 86400000; assert.doesNotMatch(await (await worker.fetch(get('/', cookie), env)).text(), /Шашки/); }
  finally { Date.now = now; }
});
test('missing secrets, cross-origin posts and oversized bodies are rejected', async () => {
  assert.equal((await worker.fetch(get(), {})).status, 503);
  assert.equal((await worker.fetch(post(env.SITE_PASSWORD, {Origin: 'https://attacker.test'}), env)).status, 403);
  assert.equal((await worker.fetch(post('a'.repeat(3000)), env)).status, 413);
});
test('repeated failed attempts are throttled within the worker instance', async () => {
  const ip = {'CF-Connecting-IP': '192.0.2.123'};
  for (let i = 0; i < 10; i++) assert.equal((await worker.fetch(post('wrong', ip), env)).status, 401);
  assert.equal((await worker.fetch(post('wrong', ip), env)).status, 429);
});
