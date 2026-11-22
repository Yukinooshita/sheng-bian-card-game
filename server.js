'use strict';
/**
 * ============================================================
 *  联机服务器（零依赖：只用 Node 自带的模块，不需要 npm install）
 * ============================================================
 *  启动：  node server.js          默认端口 8080
 *          node server.js 3000     指定端口
 *
 *  职责：
 *   1. 把 public/ 里的网页发给浏览器
 *   2. 用 WebSocket 在两位玩家之间同步对局
 *   3. 所有操作交给 engine 校验（防作弊）
 *   4. 断线后用本地 token 重连回原座位
 * ============================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { Game, DECKS } = require('./engine/engine');
const CARD_DATA = require('./engine/cards');
const CONFIG = require('./engine/config');

const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/' || url === '') url = '/index.html';
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  const target = path.normalize(path.join(PUBLIC_DIR, url));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('403');
    return;
  }
  sendFile(res, target);
});

/* ---------------- WebSocket 底层 ---------------- */

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.onMessage = null;
    this.onClose = null;
    socket.on('data', (d) => this.feed(d));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = this.buf.readUInt32BE(6);
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) return;
      const mask = masked ? this.buf.slice(offset, offset + 4) : null;
      const payload = this.buf.slice(offset + maskLen, offset + maskLen + len);
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buf = this.buf.slice(offset + maskLen + len);

      if (opcode === 0x1) {
        try {
          this.onMessage && this.onMessage(payload.toString('utf8'));
        } catch (e) {
          console.error('处理消息出错', e);
        }
      } else if (opcode === 0x8) {
        this.close();
        return;
      } else if (opcode === 0x9) {
        this.raw(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
      }
      if (!fin) continue;
    }
  }

  raw(buf) {
    if (this.closed) return;
    try { this.socket.write(buf); } catch (e) { this.destroy(); }
  }

  send(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    let head;
    if (payload.length < 126) {
      head = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x81; head[1] = 126; head.writeUInt16BE(payload.length, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x81; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(payload.length, 6);
    }
    this.raw(Buffer.concat([head, payload]));
  }

  close() {
    if (this.closed) return;
    try {
      this.raw(Buffer.from([0x88, 0x00]));
      this.socket.end();
    } catch (e) { /* ignore */ }
    this.destroy();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (e) { /* ignore */ }
    if (this.onClose) this.onClose();
  }
}

/* ---------------- 房间 ---------------- */

const rooms = new Map();
const tokens = new Map(); // token -> { code, slot }
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function newToken() { return crypto.randomBytes(9).toString('hex'); }

function makeRoom() {
  const code = newCode();
  const room = { code, seats: { P1: null, P2: null }, spectators: [], game: null, status: 'lobby', createdAt: Date.now() };
  rooms.set(code, room);
  return room;
}

function lobbyInfo(room, you) {
  return {
    t: 'lobby',
    code: room.code,
    you,
    watch: you === 'SPEC',
    spectCount: room.spectators.length,
    spectNames: room.spectators.map((w) => w.watchName || '').filter(Boolean),
    status: room.status,
    players: ['P1', 'P2'].map((slot) => {
      const s = room.seats[slot];
      return s ? { slot, name: s.name, deckId: s.deckId, ready: s.ready, online: !!(s.ws && !s.ws.closed) } : { slot, name: null, deckId: null, ready: false, online: false };
    })
  };
}

function sendTo(room, slot, msg) {
  const s = room.seats[slot];
  if (s && s.ws && !s.ws.closed) s.ws.send(msg);
}

function sendToSpecs(room, msg) {
  room.spectators.forEach((w) => { if (w && !w.closed) w.send(msg); });
}

function broadcastState(room) {
  if (!room.game) return;
  ['P1', 'P2'].forEach((slot) => {
    if (!room.seats[slot]) return;
    sendTo(room, slot, { t: 'state', view: room.game.view(slot), you: slot });
  });
  if (room.spectators.length) {
    sendToSpecs(room, { t: 'state', view: room.game.specView(), you: 'SPEC' });
  }
}

function broadcastLobby(room) {
  ['P1', 'P2'].forEach((slot) => {
    if (room.seats[slot]) sendTo(room, slot, lobbyInfo(room, slot));
  });
  if (room.spectators.length) sendToSpecs(room, lobbyInfo(room, 'SPEC'));
}

function startGame(room) {
  const a = room.seats.P1;
  const b = room.seats.P2;
  if (!a || !b) return;
  const deckA = DECKS.find((d) => d.id === a.deckId);
  const deckB = DECKS.find((d) => d.id === b.deckId);
  if (!deckA || !deckB) {
    [a, b].forEach((s) => sendTo(room, s.slot, { t: 'err', msg: '双方都需要先选好卡组' }));
    return;
  }
  room.game = new Game({ p1: a.name, p2: b.name, deckP1: deckA, deckP2: deckB });
  room.status = 'playing';
  room.seats.P1.ready = false;
  room.seats.P2.ready = false;
  broadcastLobby(room);
  broadcastState(room);
}

/* ---------------- 消息处理 ---------------- */

function handle(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || typeof msg !== 'object') return;
  const t = msg.t;

  if (t === 'hello') {
    ws.token = typeof msg.token === 'string' && msg.token.length >= 8 ? msg.token : newToken();
    ws.send({
      t: 'hello',
      token: ws.token,
      cards: CARD_DATA.cards,
      kwText: CARD_DATA.KW_TEXT,
      decks: DECKS,
      config: CONFIG
    });
    // 断线重连
    const back = tokens.get(ws.token);
    if (back) {
      const room = rooms.get(back.code);
      if (room && room.seats[back.slot]) {
        const seat = room.seats[back.slot];
        if (seat.ws && !seat.ws.closed) seat.ws.close();
        seat.ws = ws;
        ws.room = room;
        ws.slot = back.slot;
        ws.send({ t: 'joined', code: room.code, you: back.slot, resumed: true });
        broadcastLobby(room);
        if (room.game) sendTo(room, back.slot, { t: 'state', view: room.game.view(back.slot), you: back.slot });
        return;
      }
    }
    ws.send({ t: 'ready', solo: true });
    return;
  }

  if (t === 'create') {
    if (ws.room) return;
    const room = makeRoom();
    const slot = 'P1';
    room.seats[slot] = { token: ws.token, name: sanitizeName(msg.name), deckId: null, ready: false, ws, slot };
    tokens.set(ws.token, { code: room.code, slot });
    ws.room = room; ws.slot = slot;
    ws.send({ t: 'joined', code: room.code, you: slot });
    broadcastLobby(room);
    return;
  }

  if (t === 'join') {
    const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = rooms.get(code);
    if (!room) { ws.send({ t: 'err', msg: '房间不存在，检查一下房间码' }); return; }
    if (ws.room) { ws.send({ t: 'err', msg: '你已经在房间里了' }); return; }
    if (msg.watch) {
      // 观战：不占座位，只收状态
      ws.room = room; ws.slot = 'SPEC';
      ws.watchName = sanitizeName(msg.name);
      room.spectators.push(ws);
      ws.send({ t: 'joined', code: room.code, you: 'SPEC', watch: true });
      broadcastLobby(room);
      if (room.game) ws.send({ t: 'state', view: room.game.specView(), you: 'SPEC' });
      return;
    }
    let slot = null;
    if (!room.seats.P1) slot = 'P1';
    else if (!room.seats.P2) slot = 'P2';
    if (!slot) { ws.send({ t: 'err', msg: '房间已满（想旁观可以在大厅点“观战”）' }); return; }
    room.seats[slot] = { token: ws.token, name: sanitizeName(msg.name), deckId: null, ready: false, ws, slot };
    tokens.set(ws.token, { code: room.code, slot });
    ws.room = room; ws.slot = slot;
    ws.send({ t: 'joined', code: room.code, you: slot });
    broadcastLobby(room);
    return;
  }

  if (t === 'ping') { ws.send({ t: 'pong' }); return; }

  const room = ws.room;
  if (!room) { ws.send({ t: 'err', msg: '请先创建或加入房间' }); return; }
  if (ws.slot === 'SPEC') { ws.send({ t: 'err', msg: '观战中，不能操作' }); return; }
  const seat = room.seats[ws.slot];
  if (!seat) return;

  if (t === 'setDeck') {
    if (room.status !== 'lobby') return;
    if (!DECKS.some((d) => d.id === msg.deckId)) { ws.send({ t: 'err', msg: '没有这个卡组' }); return; }
    seat.deckId = msg.deckId;
    seat.ready = false;
    broadcastLobby(room);
    return;
  }

  if (t === 'ready') {
    if (room.status !== 'lobby') return;
    if (!seat.deckId) { ws.send({ t: 'err', msg: '先选一个卡组' }); return; }
    seat.ready = !!msg.ready;
    broadcastLobby(room);
    if (room.seats.P1 && room.seats.P2 && room.seats.P1.ready && room.seats.P2.ready) startGame(room);
    return;
  }

  if (t === 'action') {
    if (!room.game) return;
    if (room.game.phase === 'over' && msg.action && msg.action.type !== 'rematch') {
      ws.send({ t: 'err', msg: '对局已结束' });
      return;
    }
    const r = room.game.action(ws.slot, msg.action || {});
    if (!r.ok) ws.send({ t: 'err', msg: r.error || '操作无效' });
    broadcastState(room);
    if (room.game.phase === 'over') {
      room.status = 'over';
      ['P1', 'P2'].forEach((s) => sendTo(room, s, lobbyInfo(room, s)));
    }
    return;
  }

  if (t === 'rematch') {
    if (room.status !== 'over' && room.status !== 'playing') return;
    seat.ready = true;
    const a = room.seats.P1;
    const b = room.seats.P2;
    if (a && b && a.ready && b.ready) {
      room.game = null;
      room.status = 'lobby';
      a.ready = false; b.ready = false;
      startGame(room);
    } else {
      broadcastLobby(room);
      ws.send({ t: 'toast', msg: '已准备，等待对手' });
    }
    return;
  }

  if (t === 'leave') {
    if (ws.room) {
      const r = ws.room;
      if (ws.slot === 'SPEC') {
        r.spectators = r.spectators.filter((w) => w !== ws);
      } else if (r.seats[ws.slot] && r.seats[ws.slot].ws === ws) {
        r.seats[ws.slot].ws = null;
        tokens.delete(ws.token);
      }
      ws.room = null; ws.slot = null;
      broadcastLobby(r);
    }
    return;
  }
}

function sanitizeName(name) {
  let s = String(name || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 12);
  return s || '无名玩家';
}

/* ---------------- 升级握手 ---------------- */

server.on('upgrade', (req, socket) => {
  if (req.headers.upgrade !== 'websocket') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  const ws = new Conn(socket);
  ws.onMessage = (text) => handle(ws, text);
  ws.onClose = () => {
    if (!ws.room) return;
    const room = ws.room;
    if (ws.slot === 'SPEC') {
      room.spectators = room.spectators.filter((w) => w !== ws);
      broadcastLobby(room);
      return;
    }
    if (room.seats[ws.slot] && room.seats[ws.slot].ws === ws) {
      room.seats[ws.slot].ws = null;
      broadcastLobby(room);
    }
  };
});

/* ---------------- 保活 / 清理 ---------------- */

setInterval(() => {
  rooms.forEach((room) => {
    ['P1', 'P2'].forEach((slot) => {
      const s = room.seats[slot];
      if (s && s.ws && !s.ws.closed) s.ws.send({ t: 'pong' });
    });
    if (Date.now() - room.createdAt > 6 * 3600 * 1000) rooms.delete(room.code);
  });
  // 只清理“两个人都不在线、且很久没动”的房间
  rooms.forEach((room) => {
    const online = ['P1', 'P2'].some((slot) => room.seats[slot] && room.seats[slot].ws);
    if (!online && Date.now() - room.createdAt > 30 * 60 * 1000) {
      rooms.delete(room.code);
      ['P1', 'P2'].forEach((slot) => {
        if (room.seats[slot]) tokens.delete(room.seats[slot].token);
      });
    }
  });
}, 25000);

/* ---------------- 启动 ---------------- */

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    ifaces[name].forEach((it) => {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    });
  });
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const lines = [];
  lines.push('');
  lines.push('  ╔═══════════════════════════════════════════╗');
  lines.push('  ║            升变卡牌 · 联机服务器            ║');
  lines.push('  ╚═══════════════════════════════════════════╝');
  lines.push('');
  lines.push(`  本机打开：   http://localhost:${PORT}`);
  const ips = lanAddresses();
  if (ips.length === 0) {
    lines.push('  同一WiFi：   没检测到局域网地址（可能没连网络）');
  } else {
    ips.forEach((ip, i) => {
      lines.push(`  ${i === 0 ? '同一WiFi：  ' : '             '} http://${ip}:${PORT}`);
    });
    if (ips.length > 1) {
      lines.push('  （有多张网卡时，选你连 WiFi / 插网线的那张，一般是 192.168 开头）');
    }
  }
  lines.push('');
  lines.push('  把“同一WiFi”那条网址发给朋友，就能对局。');
  lines.push('  想让异地的朋友也能玩，看 使用说明.md 的“异地联机”。');
  lines.push('');
  lines.push('  关闭这个窗口 = 关闭服务器。');
  lines.push('');
  console.log(lines.join('\n'));
});
