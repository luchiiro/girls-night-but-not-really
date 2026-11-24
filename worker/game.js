export const gameKinds = ['tic', 'connect', 'checkers'];
export const owner = value => value > 2 ? value - 2 : value;

export function newGame(kind) {
  if (!gameKinds.includes(kind)) throw new Error('Неизвестная игра.');
  const board = Array(kind === 'tic' ? 9 : kind === 'connect' ? 42 : 64).fill(0);
  if (kind === 'checkers') board.forEach((_, i) => {
    const row = Math.floor(i / 8);
    if ((row + i % 8) % 2) board[i] = row < 3 ? 2 : row > 4 ? 1 : 0;
  });
  return {kind, board, turn: 1, done: false, winner: null, winning: [], forced: null};
}

function jumps(game, from, capturesOnly = false) {
  const value = game.board[from];
  if (!value) return [];
  const row = Math.floor(from / 8), col = from % 8;
  const directions = value > 2 ? [-1, 1] : value === 1 ? [-1] : [1];
  const moves = [];
  for (const dr of directions) for (const dc of [-1, 1]) {
    const r = row + dr, c = col + dc;
    if (r < 0 || r > 7 || c < 0 || c > 7) continue;
    const near = r * 8 + c;
    if (!game.board[near] && !capturesOnly) moves.push({from, to: near, take: -1});
    if (game.board[near] && owner(game.board[near]) !== owner(value)) {
      const r2 = r + dr, c2 = c + dc;
      if (r2 >= 0 && r2 < 8 && c2 >= 0 && c2 < 8 && !game.board[r2 * 8 + c2]) {
        moves.push({from, to: r2 * 8 + c2, take: near});
      }
    }
  }
  return moves;
}

export function legalMoves(game, from) {
  if (game.kind !== 'checkers' || game.done || !Number.isInteger(from) || from < 0 || from >= 64) return [];
  if (owner(game.board[from]) !== game.turn || (game.forced !== null && game.forced !== from)) return [];
  const capture = game.forced !== null || game.board.some((v, i) => owner(v) === game.turn && jumps(game, i, true).length);
  return jumps(game, from, capture);
}

function winningLine(board, index, width, height, count) {
  const row = Math.floor(index / width), col = index % width, value = board[index];
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const cells = [index];
    for (const direction of [-1, 1]) for (let step = 1; step < count; step++) {
      const r = row + dr * step * direction, c = col + dc * step * direction;
      if (r < 0 || r >= height || c < 0 || c >= width || board[r * width + c] !== value) break;
      cells.push(r * width + c);
    }
    if (cells.length >= count) return cells;
  }
  return [];
}

// Both local play and the authoritative server use these rules. Input never supplies a board.
export function applyMove(current, actor, move) {
  if (current.done) throw new Error('Партия закончена. Можно сыграть ещё.');
  if (actor !== current.turn) throw new Error('Сейчас ход соперницы.');
  if (!move || typeof move !== 'object') throw new Error('Некорректный ход.');
  const game = structuredClone(current);
  if (game.kind === 'checkers') {
    const choice = legalMoves(game, move.from).find(item => item.to === move.to);
    if (!choice) throw new Error('Такой ход недоступен. Проверь обязательное взятие.');
    const value = game.board[choice.from];
    game.board[choice.from] = 0;
    game.board[choice.to] = value;
    if (choice.take >= 0) game.board[choice.take] = 0;
    const crown = (value === 1 && choice.to < 8) || (value === 2 && choice.to >= 56);
    if (crown) game.board[choice.to] = value + 2;
    if (choice.take >= 0 && !crown && jumps(game, choice.to, true).length) {
      game.forced = choice.to;
      return game;
    }
    game.forced = null;
    game.turn = 3 - game.turn;
    if (!game.board.some((v, i) => owner(v) === game.turn && jumps(game, i).length)) {
      game.done = true;
      game.winner = actor;
    }
  } else {
    let index = move.index;
    if (!Number.isInteger(index) || index < 0 || index >= game.board.length) throw new Error('Некорректная клетка.');
    if (game.kind === 'connect') {
      const col = index % 7;
      let row = 5;
      while (row >= 0 && game.board[row * 7 + col]) row--;
      if (row < 0) throw new Error('Столбец уже заполнен.');
      index = row * 7 + col;
    } else if (game.board[index]) throw new Error('Клетка уже занята.');
    game.board[index] = actor;
    game.winning = winningLine(game.board, index, game.kind === 'tic' ? 3 : 7, game.kind === 'tic' ? 3 : 6, game.kind === 'tic' ? 3 : 4);
    if (game.winning.length || game.board.every(Boolean)) {
      game.done = true;
      game.winner = game.winning.length ? actor : 0;
    } else game.turn = 3 - game.turn;
  }
  return game;
}
