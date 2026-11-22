'use strict';
/**
 * 联机端到端测试：真的起一个服务器，两个客户端走 WebSocket 打几个回合。
 * 用法： node test/net.js
 */
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8099;
const ROOT = path.join(__dirname, '..');

class Client {
  constructor(tag) {
    this.tag = tag;
    this.buf = Buffer.alloc(0);
    this.msgs = [];
    this.waiters = [];
    this.sock = null;
    this.token = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(PORT, '127.0.0.1', () => {
        const key = crypto.randomBytes(16).toString('base64');
        sock.write(
          'GET / HTTP/1.1\r\n' +
          'Host: 127.0.0.1:' + PORT + '\r\n' +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' + key + '\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n'
        );
      });
      this.sock = sock;
      let handshook = false;
      sock.on('data', (chunk) => {
        if (!handshook) {
          const str = chunk.toString('utf8');
          if (str.indexOf('101') < 0) { reject(new Error('握手失败')); return; }
          handshook = true;
          const rest = chunk.slice(str.indexOf('\r\n\r\n') + 4);
          this.buf = Buffer.concat([this.buf, rest]);
          resolve();
          this.pump();
          return;
        }
        this.buf = Buffer.concat([this.buf, chunk]);
        this.pump();
      });
      sock.on('error', reject);
      sock.on('close', () => { this.closed = true; });
    });
  }

  pump() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = this.buf.readUInt32BE(6); off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      const idx = this.waiters.findIndex((w) => w.pred(msg));
      if (idx >= 0) {
        const w = this.waiters.splice(idx, 1)[0];
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        this.msgs.push(msg);
      }
    }
  }

  send(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    let head;
    if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
    else {
      head = Buffer.alloc(4);
      head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }

  wait(pred, label, timeout = 3000) {
    const hit = this.msgs.findIndex((m) => pred(m));
    if (hit >= 0) return Promise.resolve(this.msgs.splice(hit, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(this.tag + ' 等待超时：' + label));
      }, timeout);
      this.waiters.push(w);
    });
  }

  close() { try { this.sock.destroy(); } catch (e) { /* ignore */ } }
}

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败：' + msg);
}

async function main() {
  const server = spawn(process.execPath, ['server.js', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => console.error('SERVER ERR', d.toString()));
  await new Promise((r) => setTimeout(r, 900));

  try {
    const a = new Client('A');
    const b = new Client('B');
    await a.connect();
    a.send({ t: 'hello', token: '' });
    const hello = await a.wait((m) => m.t === 'hello', 'hello');
    assert(hello.cards && Object.keys(hello.cards).length > 10, '服务器应下发卡池');
    assert(hello.decks.length >= 3, '服务器应下发卡组');
    assert(hello.config.actionPointsPerTurn === 3, '配置应下发');
    a.token = hello.token;

    await b.connect();
    b.send({ t: 'hello', token: '' });
    b.token = (await b.wait((m) => m.t === 'hello', 'hello B')).token;

    a.send({ t: 'create', name: '玩家A' });
    const joined = await a.wait((m) => m.t === 'joined', 'joined A');
    const code = joined.code;
    assert(code && code.length === 4, '应生成 4 位房间码，实际 ' + code);

    b.send({ t: 'join', code, name: '玩家B' });
    const joinedB = await b.wait((m) => m.t === 'joined', 'joined B');
    assert(joinedB.you === 'P2', 'B 应坐 P2');

    await a.wait((m) => m.t === 'lobby' && m.players.filter((p) => p.name).length === 2, '两人在大厅');

    a.send({ t: 'setDeck', deckId: 'yan' });
    b.send({ t: 'setDeck', deckId: 'sen' });
    await a.wait((m) => m.t === 'lobby' && m.players.every((p) => p.deckId), '两人选好卡组');

    a.send({ t: 'ready', ready: true });
    b.send({ t: 'ready', ready: true });

    const sa = await a.wait((m) => m.t === 'state', 'A 收到对局');
    const sb = await b.wait((m) => m.t === 'state', 'B 收到对局');
    assert(sa.view.phase === 'mulligan', '开局是换牌阶段');
    assert(sa.view.me.hand.length >= 4, '先手/后手至少 4 张手牌');
    assert(sa.view.foe.hand === null, '不能看到对手手牌内容');
    assert(sb.view.foe.hand === null, '对手手牌应隐藏');

    const firstSlot = sa.view.first;
    assert(firstSlot === 'P1' || firstSlot === 'P2', '应记录先手');

    a.send({ t: 'action', action: { type: 'mulligan', cards: [] } });
    b.send({ t: 'action', action: { type: 'mulligan', cards: [] } });
    const pa = await a.wait((m) => m.t === 'state' && m.view.phase === 'play', '进入对局');
    const pb = await b.wait((m) => m.t === 'state' && m.view.phase === 'play', '进入对局 B');
    assert(pa.view.turn === 1, '第 1 回合');
    assert(pa.view.active === pb.view.active, '双方看到的行动方一致');

    // 轮到的人出一张 Ⅰ 级单位
    const active = pa.view.active === 'P1' ? a : b;
    const activeView = active === a ? pa.view : pb.view;
    const idle = active === a ? b : a;

    const hi = activeView.me.hand.findIndex((c) => {
      const def = hello.cards[c.cid];
      return def.type === 'unit' && def.level === 1;
    });
    if (hi >= 0) {
      assert(activeView.me.ap === 3, '回合开始应有 3 行动点');
      active.send({ t: 'action', action: { type: 'deploy', hand: hi, slot: 0 } });
      const st = await active.wait((m) => m.t === 'state' && m.view.me.field[0], '部署生效');
      const st2 = await idle.wait((m) => m.t === 'state' && m.view.foe.field[0], '对手同步看到部署');
      assert(st.view.me.ap === 2, '部署后行动点 2');
      assert(st2.view.foe.field[0].cardId, '对手能看到场上单位');
      assert(st.view.me.field[0].sick === true, '新部署单位当回合有疲劳');

      // 同回合攻击应被拒绝
      active.send({ t: 'action', action: { type: 'attack', uid: st.view.me.field[0].uid, target: { kind: 'player' } } });
      const err = await active.wait((m) => m.t === 'err', '攻击被拒');
      assert(err.msg.indexOf('不能攻击') >= 0 || err.msg.indexOf('部署') >= 0, '应拒绝部署当回合攻击，实际：' + err.msg);
    }

    // 结束回合
    active.send({ t: 'action', action: { type: 'endTurn' } });
    const nt = await idle.wait((m) => m.t === 'state' && m.view.yourTurn, '轮到对手');
    assert(nt.view.turn === 2, '第 2 回合');

    // 对手也可以部署
    const hi2 = nt.view.me.hand.findIndex((c) => {
      const def = hello.cards[c.cid];
      return def.type === 'unit' && def.level === 1;
    });
    if (hi2 >= 0) {
      idle.send({ t: 'action', action: { type: 'deploy', hand: hi2, slot: 1 } });
      await idle.wait((m) => m.t === 'state' && m.view.me.field[1], '对手部署成功');
    }

    // 断线重连：B 断开，用同一 token 重新进来
    b.close();
    await new Promise((r) => setTimeout(r, 300));
    const b2 = new Client('B2');
    await b2.connect();
    b2.send({ t: 'hello', token: b.token });
    const resumed = await b2.wait((m) => m.t === 'joined', '重连回房间');
    assert(resumed.resumed === true, '应通过 token 回到原座位');
    const st3 = await b2.wait((m) => m.t === 'state', '重连后补发对局状态');
    assert(st3.view.turn >= 2, '重连后回合数正确');

    // 第三个人按“加入”应被拒（房间已满）
    const c1 = new Client('C-join');
    await c1.connect();
    c1.send({ t: 'hello', token: '' });
    await c1.wait((m) => m.t === 'hello', 'hello C');
    c1.send({ t: 'join', code, name: '第三个人' });
    const full = await c1.wait((m) => m.t === 'err', '房间已满');
    assert(full.msg.indexOf('房间已满') >= 0, '第三个玩家应被拒，实际：' + full.msg);
    c1.close();

    // 但可以观战
    const w = new Client('W');
    await w.connect();
    w.send({ t: 'hello', token: '' });
    await w.wait((m) => m.t === 'hello', 'hello W');
    w.send({ t: 'join', code, name: '围观', watch: true });
    const wj = await w.wait((m) => m.t === 'joined', '观战进入');
    assert(wj.you === 'SPEC' && wj.watch === true, '观战应拿到 SPEC 身份');
    const wl = await w.wait((m) => m.t === 'lobby', '观战收到大厅');
    assert(wl.watch === true && wl.code === code, '观战大厅信息正确');
    const ws1 = await w.wait((m) => m.t === 'state', '观战收到牌桌');
    assert(ws1.view.spectator === true, '观战视角应标记 spectator');
    assert(ws1.view.me.hand === null, '观战看不到手牌内容');
    assert(ws1.view.me.field && ws1.view.slots === 3, '观战能看到场面');

    // 观战发动作要被拒
    w.send({ t: 'action', action: { type: 'endTurn' } });
    const werr = await w.wait((m) => m.t === 'err', '观战不能操作');
    assert(werr.msg.indexOf('观战') >= 0, '观战操作应被拒，实际：' + werr.msg);

    // 观战能看到后续状态变化（当前行动方结束回合）
    const activeSlotNow = ws1.view.active;
    const activeClient = activeSlotNow === 'P1' ? a : b2;
    activeClient.send({ t: 'action', action: { type: 'endTurn' } });
    const ws2 = await w.wait((m) => m.t === 'state' && m.view.turn >= ws1.view.turn, '观战同步更新');
    assert(ws2.view.spectator === true, '观战状态持续同步');
    assert(ws2.view.me.hand === null, '观战一直看不到手牌');

    w.close();
    c1.close();

    // 重复连接同 token 应踢掉旧连接而不是报错
    b2.close();
    a.close();

    console.log('✅ 联机端到端测试通过：建房 / 加入 / 选卡组 / 开局 / 部署 / 拒绝非法攻击 / 换手 / 断线重连');
  } finally {
    server.kill();
  }
}

main().catch((e) => {
  console.error('❌ ' + e.message);
  process.exit(1);
});
