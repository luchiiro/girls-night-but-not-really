import {applyMove, gameKinds, newGame} from './game.js';
import {sign, same} from './credentials.js';

const roomLifetime = 24 * 60 * 60 * 1000;
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}});
}

// SQLite-backed Durable Object; one instance and one persisted state per invitation.
export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
    ctx.blockConcurrencyWhile(async () => { this.room = await ctx.storage.get('room') || null; });
  }

  run(job) {
    const result = this.queue.then(job);
    this.queue = result.catch(() => {});
    return result;
  }

  async save(room) {
    await this.ctx.storage.put('room', room);
    this.room = room;
  }

  sockets() { return this.ctx.getWebSockets().filter(ws => ws.readyState === 1); }

  snapshot(player) {
    return {
      type: 'state', seat: this.room.players.indexOf(player) + 1,
      room: {
        game: this.room.game, revision: this.room.revision, expiresAt: this.room.expiresAt,
        players: this.room.players.map(Boolean), rematch: this.room.rematch,
        connected: this.room.players.map(id => this.sockets().some(ws => ws.deserializeAttachment()?.player === id)),
      },
    };
  }

  async broadcast() {
    if (!this.room) return;
    const stamp = await sign('room-access', this.env);
    for (const ws of this.sockets()) {
      const attachment = ws.deserializeAttachment();
      if (!attachment || attachment.expires <= Date.now() / 1000 || !await same(attachment.stamp || '', stamp)) {
        ws.close(4401, 'Войди на сайт ещё раз.'); continue;
      }
      try { ws.send(JSON.stringify(this.snapshot(attachment.player))); }
      catch { try { ws.close(1011, 'Переподключись к комнате.'); } catch {} }
    }
  }

  async expire() {
    for (const ws of this.sockets()) ws.close(4404, 'Время комнаты истекло.');
    await this.ctx.storage.deleteAll();
    this.room = null;
  }

  fetch(request) {
    return this.run(async () => {
      const url = new URL(request.url), player = request.headers.get('X-Player-Id');
      if (!/^[a-f0-9]{32}$/.test(player || '')) return json({error: 'Войди на сайт.'}, 401);
      if (this.room && this.room.expiresAt <= Date.now()) await this.expire();
      if (url.pathname === '/create' && request.method === 'POST') {
        if (this.room) return json({error: 'Комната уже существует.'}, 409);
        let body;
        try { body = await request.json(); } catch { return json({error: 'Некорректный запрос.'}, 400); }
        if (!gameKinds.includes(body?.game)) return json({error: 'Неизвестная игра.'}, 400);
        const expiresAt = Date.now() + roomLifetime;
        await this.ctx.storage.setAlarm(expiresAt);
        await this.save({game: newGame(body.game), players: [player], revision: 0, rematch: [], expiresAt});
        return json(this.snapshot(player), 201);
      }
      if (!this.room) return json({error: 'Комната не найдена или уже закрыта. Создай новую.'}, 404);
      if (url.pathname === '/join' && request.method === 'POST') {
        if (!this.room.players.includes(player)) {
          if (this.room.players.length >= 2) return json({error: 'В этой комнате уже две игрокини.'}, 409);
          await this.save({...this.room, players: [...this.room.players, player], revision: this.room.revision + 1});
          await this.broadcast();
        }
        return json(this.snapshot(player));
      }
      if (!this.room.players.includes(player)) return json({error: 'Сначала присоединись к комнате.'}, 403);
      if (url.pathname !== '/socket' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({error: 'Not found'}, 404);
      // Bound connections per browser, while allowing a second tab and reconnects.
      const previous = this.sockets().filter(ws => ws.deserializeAttachment()?.player === player);
      if (previous.length >= 2) previous[0].close(4409, 'Комната открыта в другой вкладке.');
      const pair = new WebSocketPair(), [client, server] = Object.values(pair);
      server.serializeAttachment({player, expires: Number(request.headers.get('X-Auth-Expires')), stamp: request.headers.get('X-Auth-Stamp'), windowStart: 0, count: 0});
      this.ctx.acceptWebSocket(server);
      await this.broadcast();
      return new Response(null, {status: 101, webSocket: client});
    });
  }

  webSocketMessage(ws, message) {
    return this.run(async () => {
      if (!this.room || this.room.expiresAt <= Date.now()) { await this.expire(); return; }
      const attachment = ws.deserializeAttachment();
      if (!attachment || attachment.expires <= Date.now() / 1000 || !await same(attachment.stamp || '', await sign('room-access', this.env))) {
        ws.close(4401, 'Войди на сайт ещё раз.'); return;
      }
      if (typeof message !== 'string' || message.length > 2048) { ws.close(1009, 'Слишком большой запрос.'); return; }
      const error = text => ws.send(JSON.stringify({type: 'error', error: text}));
      if (Date.now() - attachment.windowStart >= 1000) { attachment.windowStart = Date.now(); attachment.count = 0; }
      attachment.count++;
      ws.serializeAttachment(attachment);
      if (attachment.count > 20) { error('Слишком быстро. Повтори ход через секунду.'); return; }
      let data;
      try { data = JSON.parse(message); } catch { error('Некорректный запрос.'); return; }
      if (!data || typeof data !== 'object') { error('Некорректный запрос.'); return; }
      const seat = this.room.players.indexOf(attachment.player) + 1;
      if (!seat) { ws.close(4403, 'Нет доступа к комнате.'); return; }
      if (data.revision !== this.room.revision) {
        ws.send(JSON.stringify(this.snapshot(attachment.player)));
        error('Поле обновилось. Повтори ход.'); return;
      }
      if (this.room.players.length !== 2) { error('Подожди, пока подруга присоединится.'); return; }
      let next;
      if (data.type === 'move') {
        try { next = {...this.room, game: applyMove(this.room.game, seat, data.move), rematch: [], revision: this.room.revision + 1}; }
        catch (e) { error(e.message); return; }
      } else if (data.type === 'rematch') {
        if (this.room.rematch.includes(seat)) return;
        const votes = [...this.room.rematch, seat];
        next = {...this.room, revision: this.room.revision + 1, rematch: votes};
        if (votes.length === 2) { next.game = newGame(this.room.game.kind); next.rematch = []; }
      } else { error('Неизвестная команда.'); return; }
      try { await this.save(next); }
      catch { error('Не удалось сохранить ход. Попробуй ещё раз.'); return; }
      await this.broadcast();
    });
  }

  webSocketClose(ws, code) {
    try { ws.close(code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1000); } catch {}
    return this.run(async () => this.broadcast());
  }

  webSocketError(ws) {
    try { ws.close(1011, 'Переподключись к комнате.'); } catch {}
    return this.run(async () => this.broadcast());
  }

  alarm() {
    return this.run(async () => {
      if (this.room && this.room.expiresAt > Date.now()) await this.ctx.storage.setAlarm(this.room.expiresAt);
      else await this.expire();
    });
  }
}
