import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';

export const origin = 'https://example.test';
export const testEnv = {SITE_PASSWORD: 'local-test-password', SESSION_SECRET: 'test-secret-that-is-at-least-thirty-two-characters'};
export function createRuntime() {
  return new Miniflare({...convertV4MiniflareOptions({
    name: 'test',
    modules: ['index.js', 'game.js', 'room.js', 'credentials.js'].map(name => ({type: 'ESModule', path: fileURLToPath(new URL('../dist/server/' + name, import.meta.url))})),
    compatibilityDate: '2026-11-01',
    durableObjects: {GAME_ROOMS: {className: 'GameRoom', useSQLite: true}},
    bindings: testEnv, inspectorPort: 0,
  }), unsafeInspectDurableObjects: true});
}
export async function login(mf, room = '') {
  const response = await mf.dispatchFetch(origin + '/login', {
    method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({password: testEnv.SITE_PASSWORD, room}), redirect: 'manual',
  });
  if (response.status !== 303) throw new Error('Login failed: ' + response.status);
  return {cookie: response.headers.get('Set-Cookie').split(';')[0], response};
}
export function post(mf, path, cookie, body = {}) {
  return mf.dispatchFetch(origin + path, {method: 'POST', headers: {Origin: origin, Cookie: cookie, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
}
export async function eventually(check, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}
export async function connect(mf, id, cookie) {
  const response = await mf.dispatchFetch(origin + '/api/rooms/' + id + '/socket', {headers: {Origin: origin, Cookie: cookie, Upgrade: 'websocket'}});
  if (response.status !== 101) throw new Error('Upgrade failed: ' + response.status + ' ' + await response.text());
  const ws = response.webSocket, messages = [];
  ws.addEventListener('message', event => messages.push(JSON.parse(event.data)));
  ws.accept();
  await eventually(() => messages.some(data => data.type === 'state'));
  return {ws, messages, latest: () => messages.filter(data => data.type === 'state').at(-1)};
}
export async function command(client, type, move, revision = client.latest().room.revision) {
  await new Promise(resolve => setTimeout(resolve, 90));
  const start = client.messages.length;
  client.ws.send(JSON.stringify({type, revision, ...(move ? {move} : {})}));
  await eventually(() => client.messages.length > start);
  return client.messages.at(-1);
}
