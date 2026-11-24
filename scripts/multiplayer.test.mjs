import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime, login, post, connect, command, eventually, origin} from './runtime.mjs';

test('online API requires password, same-origin requests and valid game input', async t => {
  const mf = createRuntime(); t.after(() => mf.dispose());
  assert.equal((await post(mf, '/api/rooms', '', {game: 'tic'})).status, 401);
  const {cookie} = await login(mf);
  const foreign = await mf.dispatchFetch(origin + '/api/rooms', {method: 'POST', headers: {Origin: 'https://foreign.test', Cookie: cookie, 'Content-Type': 'application/json'}, body: '{"game":"tic"}'});
  assert.equal(foreign.status, 403);
  for (const body of [null, {}, {game: '__proto__'}]) assert.equal((await post(mf, '/api/rooms', cookie, body)).status, 400);
  const valid = await post(mf, '/api/rooms', cookie, {game: 'tic'});
  assert.equal(valid.status, 201);
  const data = await valid.json();
  assert.match(data.id, /^[a-f0-9]{32}$/);
  assert.equal(data.seat, 1);
  assert.equal(data.room.players.length, 1);
  assert.doesNotMatch(JSON.stringify(data), /__Host-gn-session|test-secret/);
});

test('an invitation survives password login; client code is also protected', async t => {
  const mf = createRuntime(); t.after(() => mf.dispose());
  const id = 'a'.repeat(32);
  const anonymous = await mf.dispatchFetch(origin + '/?room=' + id);
  assert.match(await anonymous.text(), new RegExp('name="room" value="' + id + '"'));
  const {cookie, response} = await login(mf, id);
  assert.equal(response.headers.get('Location'), '/?room=' + id);
  const script = await mf.dispatchFetch(origin + '/client.js', {headers: {Cookie: cookie}});
  assert.match(script.headers.get('Content-Type'), /javascript/);
  assert.match(await script.text(), /createRoom/);
  const unavailable = await post(mf, '/api/rooms/' + id + '/join', cookie);
  assert.equal(unavailable.status, 404);
});

test('two players synchronize moves, reject a third player, wrong turns and stale writes', async t => {
  const mf = createRuntime(); t.after(() => mf.dispose());
  const a = (await login(mf)).cookie, b = (await login(mf)).cookie, c = (await login(mf)).cookie;
  const {id} = await (await post(mf, '/api/rooms', a, {game: 'tic'})).json();
  const first = await connect(mf, id, a);
  assert.match((await command(first, 'move', {index: 0})).error, /Подожди/);
  assert.equal((await post(mf, '/api/rooms/' + id + '/join', b)).status, 200);
  assert.equal((await post(mf, '/api/rooms/' + id + '/join', c)).status, 409);
  const outsider = await mf.dispatchFetch(origin + '/api/rooms/' + id + '/socket', {headers: {Origin: origin, Cookie: c, Upgrade: 'websocket'}});
  assert.equal(outsider.status, 403);
  const second = await connect(mf, id, b);
  await eventually(() => first.latest().room.players.length === 2);
  assert.equal(first.latest().seat, 1); assert.equal(second.latest().seat, 2);
  assert.match((await command(second, 'move', {index: 0})).error, /ход соперницы/);
  await command(first, 'move', {index: 0});
  await eventually(() => second.latest().room.game.board[0] === 1);
  assert.equal(first.latest().room.game.turn, 2);
  assert.match((await command(second, 'move', {index: 1}, 0)).error, /обновилось/);
  await command(second, 'move', {index: 3});
  await eventually(() => first.latest().room.game.board[3] === 2);
  await command(first, 'move', {index: 1});
  await eventually(() => second.latest().room.game.turn === 2);
  await command(second, 'move', {index: 4});
  await eventually(() => first.latest().room.game.turn === 1);
  await command(first, 'move', {index: 2});
  await eventually(() => second.latest().room.game.done);
  assert.equal(second.latest().room.game.winner, 1);
});

test('room state and player identity survive disconnection and Durable Object hibernation', async t => {
  const mf = createRuntime(); t.after(() => mf.dispose());
  const a = (await login(mf)).cookie, b = (await login(mf)).cookie;
  const {id} = await (await post(mf, '/api/rooms', a, {game: 'connect'})).json();
  await post(mf, '/api/rooms/' + id + '/join', b);
  const first = await connect(mf, id, a), second = await connect(mf, id, b);
  await command(first, 'move', {index: 0});
  await eventually(() => second.latest().room.game.board[35] === 1);
  await mf.unsafeEvictDurableObject('test', 'GameRoom', {name: id, webSockets: 'hibernate'});
  await command(second, 'move', {index: 1});
  await eventually(() => first.latest().room.game.board[36] === 2);
  first.ws.close();
  const restored = await (await post(mf, '/api/rooms/' + id + '/join', a)).json();
  assert.equal(restored.seat, 1); assert.equal(restored.room.players.length, 2);
  assert.equal(restored.room.game.board[35], 1); assert.equal(restored.room.game.board[36], 2);
  const reconnected = await connect(mf, id, a);
  assert.equal(reconnected.latest().room.game.turn, 1);
});

test('restarting needs both players and rejects duplicate or malformed commands', async t => {
  const mf = createRuntime(); t.after(() => mf.dispose());
  const a = (await login(mf)).cookie, b = (await login(mf)).cookie;
  const {id} = await (await post(mf, '/api/rooms', a, {game: 'checkers'})).json();
  await post(mf, '/api/rooms/' + id + '/join', b);
  const first = await connect(mf, id, a), second = await connect(mf, id, b);
  assert.equal((await command(first, 'move', {from: 40, to: 33})).type, 'state');
  await eventually(() => second.latest().room.game.turn === 2);
  const before = first.latest().room.game.board;
  await command(first, 'rematch');
  assert.deepEqual(first.latest().room.game.board, before);
  await eventually(() => second.latest().room.rematch.includes(1));
  await command(second, 'rematch');
  await eventually(() => first.latest().room.game.board[40] === 1);
  assert.deepEqual(first.latest().room.rematch, []);
  const count = first.messages.length;
  first.ws.send('null');
  await eventually(() => first.messages.length > count);
  assert.equal(first.messages.at(-1).type, 'error');
});
