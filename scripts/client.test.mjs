import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
import {newGame, applyMove, legalMoves, owner} from '../worker/game.js';
import {createRuntime, login, eventually, origin} from './runtime.mjs';

const html = (await readFile(new URL('../index.html', import.meta.url), 'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
const code = (await readFile(new URL('../client.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');

// Exercise the actual UI module in isolated DOMs, backed by the real Workers runtime.
function openClient(mf, cookie, url = origin) {
  const window = new Window({url, settings: {disableJavaScriptFileLoading: true, disableCSSFileLoading: true}});
  Object.assign(window, {newGame, applyMove, legalMoves, owner, structuredClone});
  window.fetch = (path, init = {}) => mf.dispatchFetch(new URL(path, window.location.href).href, {
    ...init, headers: {...init.headers, Cookie: cookie, Origin: origin},
  });
  window.WebSocket = class extends window.EventTarget {
    static OPEN = 1;
    readyState = 0;
    constructor(url) {
      super();
      const httpUrl = String(url).replace(/^wss:/, 'https:');
      mf.dispatchFetch(httpUrl, {headers: {Cookie: cookie, Origin: origin, Upgrade: 'websocket'}}).then(response => {
        if (response.status !== 101) throw new Error('Upgrade ' + response.status);
        this.peer = response.webSocket;
        if (this.readyState === 3) { this.peer.accept(); this.peer.close(); return; }
        this.peer.addEventListener('message', event => this.onmessage?.({data: event.data}));
        this.peer.addEventListener('close', event => { this.readyState = 3; this.onclose?.(event); });
        this.readyState = 1;
        this.onopen?.();
        this.peer.accept();
      }).catch(() => { this.readyState = 3; this.onerror?.(); this.onclose?.({code: 1006}); });
    }
    send(data) { this.peer.send(data); }
    close() { this.readyState = 3; this.peer?.close(); }
  };
  window.document.write(html);
  window.eval(code);
  return {window, $: selector => window.document.querySelector(selector), close: () => window.happyDOM.close()};
}

test('UI creates a room, joins by invitation, synchronizes moves and restores after reload', async t => {
  const mf = createRuntime(); t.after(() => mf.dispose());
  const firstCookie = (await login(mf)).cookie;
  const first = openClient(mf, firstCookie); t.after(() => first.close());
  first.$('[data-game=tic]').click();
  assert.equal(first.$('#mode-panel').hidden, false);
  first.$('#create-room').click();
  await eventually(() => first.$('#status').textContent.includes('Ждём подругу'));
  const invitation = first.$('#invite-link').value;
  assert.match(invitation, /\?room=[a-f0-9]{32}$/);
  assert.equal(first.$('#board button').disabled, true);
  const second = openClient(mf, (await login(mf)).cookie, invitation); t.after(() => second.close());
  await eventually(() => first.$('#status').textContent.includes('Твой ход'));
  await eventually(() => second.$('#status').textContent.includes('Ход соперницы'));
  first.$('#board button[data-index="0"]').click();
  await eventually(() => second.$('#board button[data-index="0"]').textContent === '♡');
  await eventually(() => second.$('#status').textContent.includes('Твой ход'));
  second.$('#board button[data-index="3"]').click();
  await eventually(() => first.$('#board button[data-index="3"]').textContent === '×');
  first.$('#back').click();
  assert.equal(first.$('#lobby').hidden, false);
  const restored = openClient(mf, firstCookie, invitation); t.after(() => restored.close());
  await eventually(() => restored.$('#status').textContent.includes('Твой ход'));
  assert.equal(restored.$('#board button[data-index="0"]').textContent, '♡');
  assert.equal(restored.$('#board button[data-index="3"]').textContent, '×');
  restored.$('#restart').click();
  await eventually(() => second.$('#restart').textContent.includes('Принять'));
  assert.equal(restored.$('#board button[data-index="0"]').textContent, '♡');
  second.$('#restart').click();
  await eventually(() => restored.$('#board button[data-index="0"]').textContent === '');
});

test('local play, game selection, theme toggle and invalid invitations remain usable', async t => {
  const mf = createRuntime(); t.after(() => mf.dispose());
  const client = openClient(mf, (await login(mf)).cookie); t.after(() => client.close());
  const {window, $} = client;
  $('#theme').click(); assert.equal(window.document.documentElement.dataset.theme, 'dark');
  for (const [kind, cells] of [['tic', 9], ['connect', 42], ['checkers', 64]]) {
    $(`[data-game=${kind}]`).click(); $('#local-play').click();
    assert.equal(window.document.querySelectorAll('#board button').length, cells);
    assert.equal($('#room-panel').hidden, true);
    assert.equal($('#status').hidden, false);
    if (kind === 'tic') { $('#board button[data-index="0"]').click(); assert.equal($('#board button').textContent, '♡'); }
    if (kind === 'connect') { $('#board button[data-index="0"]').click(); assert.ok($('#board button[data-index="35"]').classList.contains('p1')); }
    if (kind === 'checkers') {
      $('#board button[data-index="40"]').click(); $('#board button[data-index="33"]').click();
      assert.ok($('#board button[data-index="33"] .piece.p1'));
    }
    $('#back').click();
  }
  $('#join-link').value = 'https://other.test/?room=' + 'a'.repeat(32);
  $('#join-form').dispatchEvent(new window.Event('submit', {cancelable: true}));
  assert.equal($('#lobby-error').hidden, false);
});
