import test from 'node:test';
import assert from 'node:assert/strict';
import {newGame, applyMove, legalMoves} from '../worker/game.js';

test('tic-tac-toe detects a win and rejects moves after it', () => {
  let game = newGame('tic');
  for (const index of [0, 3, 1, 4, 2]) game = applyMove(game, game.turn, {index});
  assert.equal(game.winner, 1);
  assert.equal(game.done, true);
  assert.deepEqual(game.winning.sort(), [0, 1, 2]);
  assert.throws(() => applyMove(game, 2, {index: 8}));
});

test('tic-tac-toe handles a draw and does not mutate the previous board', () => {
  const original = newGame('tic');
  let game = original;
  for (const index of [0, 1, 2, 4, 3, 5, 7, 6, 8]) game = applyMove(game, game.turn, {index});
  assert.equal(game.winner, 0);
  assert.equal(game.done, true);
  assert.ok(original.board.every(v => v === 0));
});

test('invalid input, the wrong player, occupied cells and unknown games are rejected', () => {
  const game = newGame('tic');
  assert.throws(() => newGame('__proto__'));
  for (const index of [-1, 9, 1.2, '0', null]) assert.throws(() => applyMove(game, 1, {index}));
  assert.throws(() => applyMove(game, 2, {index: 0}));
  assert.throws(() => applyMove(game, 1, null));
  assert.throws(() => applyMove(applyMove(game, 1, {index: 0}), 2, {index: 0}));
});

test('connect four applies gravity, detects vertical wins and rejects full columns', () => {
  let game = newGame('connect');
  game = applyMove(game, 1, {index: 0});
  assert.equal(game.board[35], 1);
  for (const index of [1, 0, 1, 0, 1, 0]) game = applyMove(game, game.turn, {index});
  assert.equal(game.winner, 1);
  game = newGame('connect');
  for (let i = 0; i < 6; i++) game = applyMove(game, game.turn, {index: 0});
  assert.throws(() => applyMove(game, game.turn, {index: 0}));
});

test('checkers enforces mandatory capture and continuation with the same piece', () => {
  let game = newGame('checkers'); game.board.fill(0);
  game.board[49] = 1; game.board[40] = 1; game.board[42] = 2; game.board[28] = 2; game.board[7] = 2;
  assert.deepEqual(legalMoves(game, 40), []);
  assert.throws(() => applyMove(game, 1, {from: 49, to: 40}));
  game = applyMove(game, 1, {from: 49, to: 35});
  assert.equal(game.turn, 1); assert.equal(game.forced, 35); assert.equal(game.board[42], 0);
  assert.throws(() => applyMove(game, 1, {from: 40, to: 33}));
  game = applyMove(game, 1, {from: 35, to: 21});
  assert.equal(game.turn, 2); assert.equal(game.forced, null); assert.equal(game.board[28], 0);
});

test('crowning ends a capture turn; kings can move backwards', () => {
  let game = newGame('checkers'); game.board.fill(0);
  game.board[17] = 1; game.board[10] = 2; game.board[12] = 2;
  game = applyMove(game, 1, {from: 17, to: 3});
  assert.equal(game.board[3], 3); assert.equal(game.turn, 2); assert.equal(game.forced, null);
  game.turn = 1; game.board[12] = 0; game.board[63] = 2;
  assert.ok(legalMoves(game, 3).some(move => move.to === 10));
});

test('a player wins checkers when the opponent has no legal moves', () => {
  let game = newGame('checkers'); game.board.fill(0);
  game.board[17] = 1; game.board[10] = 2;
  game = applyMove(game, 1, {from: 17, to: 3});
  assert.equal(game.done, true); assert.equal(game.winner, 1);
});
