import {newGame, applyMove, legalMoves, owner} from '/rules.js';

const $ = id => document.getElementById(id);
const titles = {tic: 'Крестики-нолики', connect: 'Четыре в ряд', checkers: 'Шашки'};
const instructions = {
  tic: 'Три своих знака по горизонтали, вертикали или диагонали — победа.',
  connect: 'Нажми на столбец: фишка упадёт вниз. Собери четыре своих фишки в ряд.',
  checkers: 'Английские шашки: ход и взятие по диагонали вперёд. Взятие обязательно, серия прыжков — одной шашкой. Дамки ходят на одну клетку в обе стороны. Превращение завершает ход.',
};
let game = null, mode = 'choose', room = null, id = '', seat = 0, selected = -1;
let socket = null, connection = '', pending = false, generation = 0, connectionAttempt = 0, retry = 0, retryTimer, moveTimer;
const player = n => n === 1 ? '♡ Роза' : game?.kind === 'tic' ? '× Полночь' : '✦ Полночь';

function themeLabel() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('theme').textContent = dark ? '☀' : '☾';
  $('theme').setAttribute('aria-label', dark ? 'Светлая тема' : 'Тёмная тема');
  document.querySelector('meta[name=theme-color]').content = dark ? '#160e17' : '#f9e6e5';
}
themeLabel();
$('theme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('gn-theme', next); } catch {}
  themeLabel();
};

function error(text = '', lobby = false) {
  const element = $(lobby ? 'lobby-error' : 'game-error');
  element.textContent = text;
  element.hidden = !text;
}

function disconnect() {
  generation++;
  connectionAttempt++;
  clearTimeout(retryTimer);
  clearTimeout(moveTimer);
  const previous = socket;
  socket = null;
  if (previous) previous.close();
  pending = false;
  connection = '';
  retry = 0;
}

function updateUrl(roomId = '') {
  const url = new URL(location.href);
  url.searchParams.delete('room');
  if (roomId) url.searchParams.set('room', roomId);
  url.hash = '';
  history.replaceState(null, '', url);
}

function showGame() {
  $('lobby').hidden = true;
  $('game').hidden = false;
  $('game-title').textContent = titles[game.kind];
  $('rules').textContent = instructions[game.kind];
  $('sign-in').hidden = true;
  $('reconnect').hidden = true;
  error();
  window.scrollTo(0, 0);
  render();
}

function choose(kind) {
  disconnect();
  mode = 'choose'; room = null; id = ''; seat = 0; selected = -1;
  game = newGame(kind);
  updateUrl();
  showGame();
}

function home() {
  disconnect();
  game = null; room = null; id = ''; seat = 0; selected = -1;
  updateUrl();
  $('game').hidden = true;
  $('lobby').hidden = false;
  window.scrollTo(0, 0);
}

async function api(path, body = {}) {
  const response = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Сервер не ответил. Проверь подключение и попробуй снова.'); }
  if (!response.ok) {
    const failure = new Error(data.error || 'Не удалось подключиться.');
    failure.status = response.status;
    throw failure;
  }
  return data;
}

function receive(data) {
  if (data?.type !== 'state' || !data.room || !titles[data.room.game?.kind]) return;
  room = data.room; game = room.game; seat = data.seat;
  selected = game.forced ?? -1;
  pending = false;
  clearTimeout(moveTimer);
  $('game-title').textContent = titles[game.kind];
  $('rules').textContent = instructions[game.kind];
  render();
}

function failedConnection(failure) {
  connection = 'closed';
  error(failure.message);
  if (failure.status === 401) {
    $('sign-in').href = location.href;
    $('sign-in').hidden = false;
  } else if (![403, 404, 409].includes(failure.status)) $('reconnect').hidden = false;
  render();
}

async function createRoom() {
  if (pending) return;
  pending = true;
  render();
  const current = generation;
  error();
  try {
    const result = await api('/api/rooms', {game: game.kind});
    if (current !== generation) return;
    id = result.id; mode = 'online';
    updateUrl(id);
    receive(result);
    await connect(current);
  } catch (e) {
    if (current === generation) { error(e.message); pending = false; }
  } finally { if (current === generation) { pending = false; render(); } }
}

async function join(roomId) {
  disconnect();
  id = roomId; mode = 'online'; game = newGame('tic'); room = null; selected = -1;
  updateUrl(id);
  connection = 'connecting';
  showGame();
  await connect(generation);
}

async function connect(current) {
  if (current !== generation) return;
  const attempt = ++connectionAttempt;
  const previous = socket;
  socket = null;
  previous?.close();
  connection = 'connecting';
  $('reconnect').hidden = true;
  render();
  try {
    const result = await api('/api/rooms/' + id + '/join');
    if (current !== generation || attempt !== connectionAttempt) return;
    receive(result);
    const url = new URL('/api/rooms/' + id + '/socket', location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      if (current !== generation || socket !== ws) return;
      connection = 'ready'; retry = 0; error(); render();
    };
    ws.onmessage = event => {
      if (current !== generation || socket !== ws) return;
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'error') {
        pending = false; clearTimeout(moveTimer); error(data.error); render();
      } else receive(data);
    };
    ws.onclose = event => {
      if (current !== generation || socket !== ws) return;
      socket = null; pending = false; clearTimeout(moveTimer);
      if ([4401, 4403, 4404, 4409].includes(event.code)) {
        failedConnection({message: event.reason || 'Соединение закрыто.', status: event.code === 4401 ? 401 : event.code === 4404 ? 404 : 0});
        return;
      }
      connection = 'connecting'; render();
      const delay = Math.min(15000, 1000 * 2 ** retry++);
      retryTimer = setTimeout(() => connect(current), delay);
    };
    ws.onerror = () => {}; // onclose handles retries, preserving the room link.
  } catch (e) {
    if (current !== generation || attempt !== connectionAttempt) return;
    if ([401, 403, 404, 409].includes(e.status)) failedConnection(e);
    else {
      connection = 'connecting'; error(e.message); render();
      retryTimer = setTimeout(() => connect(current), Math.min(15000, 1000 * 2 ** retry++));
    }
  }
}

function send(type, move) {
  if (pending || connection !== 'ready' || socket?.readyState !== WebSocket.OPEN) return;
  pending = true;
  error();
  try { socket.send(JSON.stringify({type, revision: room.revision, ...(move ? {move} : {})})); }
  catch { pending = false; socket.close(); return; }
  render();
  moveTimer = setTimeout(() => { if (pending) socket?.close(); }, 8000);
}

function canPlay() {
  return game && !game.done && (mode === 'local' || (mode === 'online' && connection === 'ready' && !pending && room?.players.length === 2 && game.turn === seat));
}

function cellClick(index) {
  if (!canPlay()) return;
  error();
  let move;
  if (game.kind === 'checkers') {
    if (owner(game.board[index]) === game.turn && game.forced === null) {
      if (!legalMoves(game, index).length) error('Выбери шашку с доступным ходом. Взятие обязательно.');
      else selected = index;
      render(); return;
    }
    if (game.forced !== null) selected = game.forced;
    if (selected < 0 || !legalMoves(game, selected).some(item => item.to === index)) return;
    move = {from: selected, to: index};
  } else move = {index};
  if (mode === 'online') send('move', move);
  else {
    try { game = applyMove(game, game.turn, move); selected = game.forced ?? -1; }
    catch (e) { error(e.message); }
    render();
  }
}

function status() {
  if (mode === 'online') {
    if (connection === 'connecting') return 'Подключаемся к комнате…';
    if (connection !== 'ready') return 'Соединение закрыто. Партия сохранена.';
    if (room?.players.length < 2) return 'Ждём подругу ♡ Отправь ей ссылку выше.';
    if (pending) return 'Сохраняем…';
  }
  if (game.done) return game.winner ? 'Победа: ' + player(game.winner) + '! ✧' : 'Ничья! ♡';
  if (game.forced !== null) return mode === 'online' && game.turn !== seat ? 'Соперница продолжает взятие.' : 'Продолжи взятие той же шашкой ✦';
  return mode === 'online' ? (game.turn === seat ? 'Твой ход: ' : 'Ход соперницы: ') + player(game.turn) : 'Ход: ' + player(game.turn);
}

function render() {
  if (!game) return;
  const chooseMode = mode === 'choose';
  $('mode-panel').hidden = !chooseMode;
  $('create-room').disabled = pending;
  $('local-play').disabled = pending;
  $('room-panel').hidden = mode !== 'online' || !room;
  $('status').hidden = chooseMode;
  $('board').hidden = chooseMode || (mode === 'online' && !room);
  $('restart').hidden = chooseMode || (mode === 'online' && !room);
  $('restart').disabled = mode === 'online' && (connection !== 'ready' || pending || room?.players.length !== 2 || room?.rematch.includes(seat));
  $('restart').textContent = mode === 'local' ? '↻ Сначала' : room?.rematch.includes(seat) ? 'Ждём согласия подруги…' : room?.rematch.length ? '↻ Принять новую партию' : '↻ Новая партия';
  if (!chooseMode) $('status').textContent = status();
  if (mode === 'online' && room) {
    $('room-seat').textContent = 'Ты играешь за ' + player(seat);
    $('invite-link').value = new URL('/?room=' + id, location.origin).href;
    $('room-presence').textContent = room.players.length < 2 ? 'Второе место свободно.' : room.connected[2 - seat] ? 'Подруга в комнате ♡' : 'Подруга не в сети. Её место и партия сохранены.';
  }
  const board = $('board'), cols = game.kind === 'tic' ? 3 : game.kind === 'connect' ? 7 : 8;
  board.className = 'board ' + game.kind;
  board.style.gridTemplateColumns = 'repeat(' + cols + ',minmax(0,1fr))';
  board.setAttribute('aria-label', titles[game.kind]);
  board.setAttribute('aria-busy', String(pending));
  board.replaceChildren();
  const targets = selected >= 0 ? legalMoves(game, selected).map(move => move.to) : [];
  game.board.forEach((value, index) => {
    const b = document.createElement('button');
    const row = Math.floor(index / cols), col = index % cols;
    b.type = 'button'; b.className = 'cell'; b.dataset.index = index;
    b.setAttribute('aria-label', 'Ряд ' + (row + 1) + ', столбец ' + (col + 1) + (value ? ', ' + player(owner(value)) : ''));
    b.disabled = !canPlay();
    if (game.winning.includes(index)) b.classList.add('win');
    if (game.kind === 'checkers') {
      if ((row + col) % 2) b.classList.add('dark'); else b.disabled = true;
      if (selected === index) b.classList.add('selected');
      if (targets.includes(index)) b.classList.add('target');
      if (value) {
        const piece = document.createElement('span');
        piece.className = 'piece p' + owner(value);
        piece.textContent = value > 2 ? '♛' : value === 1 ? '♡' : '✦';
        b.append(piece);
      }
    } else if (game.kind === 'tic' && value) {
      b.textContent = value === 1 ? '♡' : '×';
      b.classList.add(value === 1 ? 'x' : 'o'); b.disabled = true;
    } else if (game.kind === 'connect' && value) b.classList.add('p' + value);
    b.onclick = () => cellClick(index);
    board.append(b);
  });
}

document.querySelectorAll('[data-game]').forEach(b => { b.onclick = () => choose(b.dataset.game); });
$('back').onclick = home;
$('home-link').onclick = e => { e.preventDefault(); home(); };
$('games-link').onclick = () => { if (game) home(); };
$('create-room').onclick = createRoom;
$('local-play').onclick = () => { mode = 'local'; error(); render(); };
$('restart').onclick = () => {
  if (mode === 'online') send('rematch');
  else { game = newGame(game.kind); selected = -1; error(); render(); }
};
$('reconnect').onclick = () => { const roomId = id; join(roomId); };
$('copy-link').onclick = async () => {
  try { await navigator.clipboard.writeText($('invite-link').value); $('copy-link').textContent = 'Скопировано ♡'; }
  catch { $('invite-link').focus(); $('invite-link').select(); $('copy-link').textContent = 'Скопируй выделенную ссылку'; }
  setTimeout(() => { $('copy-link').textContent = 'Скопировать'; }, 2500);
};
$('join-form').onsubmit = event => {
  event.preventDefault();
  const value = $('join-link').value.trim();
  let roomId = /^[a-f0-9]{32}$/.test(value) ? value : '';
  if (!roomId) {
    try { const url = new URL(value); if (url.origin === location.origin) roomId = url.searchParams.get('room') || ''; } catch {}
  }
  if (!/^[a-f0-9]{32}$/.test(roomId)) { error('Вставь ссылку-приглашение с этого сайта.', true); return; }
  error('', true);
  join(roomId);
};
window.addEventListener('online', () => {
  if (mode === 'online' && id && connection !== 'ready') { clearTimeout(retryTimer); connect(generation); }
});
const invitedRoom = new URL(location.href).searchParams.get('room');
if (/^[a-f0-9]{32}$/.test(invitedRoom || '')) join(invitedRoom);
