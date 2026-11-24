'use strict';
/**
 * 用无头 Edge + CDP 真跑一局，截牌桌图，顺便抓前端异常。
 * 用法： node test/cdp.js
 */
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 8080;
const DBG = 9222;
const PROFILE = path.join(__dirname, 'edge_profile');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class WS {
  constructor() { this.buf = Buffer.alloc(0); this.handlers = []; this.id = 0; }
  connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const u = new URL(wsUrl);
      const sock = net.connect(Number(u.port), u.hostname, () => {
        const key = crypto.randomBytes(16).toString('base64');
        sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      this.sock = sock;
      let ok = false;
      sock.on('data', (chunk) => {
        if (!ok) {
          const s = chunk.toString('utf8');
          if (s.indexOf('101') < 0) { reject(new Error('CDP 握手失败')); return; }
          ok = true;
          this.buf = Buffer.concat([this.buf, chunk.slice(s.indexOf('\r\n\r\n') + 4)]);
          resolve();
          this.pump();
          return;
        }
        this.buf = Buffer.concat([this.buf, chunk]);
        this.pump();
      });
      sock.on('error', reject);
    });
  }
  pump() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = this.buf.readUInt32BE(6); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.slice(off, off + len));
      this.buf = this.buf.slice(off + len);
      let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      this.handlers.forEach((h) => h(msg));
    }
  }
  send(obj) {
    const p = Buffer.from(JSON.stringify(obj), 'utf8');
    let head;
    if (p.length < 126) head = Buffer.from([0x81, 0x80 | p.length]);
    else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
    const mask = crypto.randomBytes(4);
    const m = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) m[i] = p[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, m]));
  }
  on(fn) { this.handlers.push(fn); }
  call(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 超时: ' + method)), 8000);
      const h = (msg) => {
        if (msg.id === id) {
          clearTimeout(timer);
          this.handlers = this.handlers.filter((x) => x !== h);
          if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      };
      this.on(h);
      this.send({ id, method, params: params || {} });
    });
  }
}

// 参与对局的普通玩家（Node 端）
class Player {
  constructor() { this.buf = Buffer.alloc(0); this.msgs = []; this.waiters = []; }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(PORT, '127.0.0.1', () => {
        const key = crypto.randomBytes(16).toString('base64');
        sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      this.sock = sock;
      let ok = false;
      sock.on('data', (chunk) => {
        if (!ok) {
          const s = chunk.toString('utf8');
          if (s.indexOf('101') < 0) { reject(new Error('握手失败')); return; }
          ok = true;
          this.buf = Buffer.concat([this.buf, chunk.slice(s.indexOf('\r\n\r\n') + 4)]);
          resolve(); this.pump(); return;
        }
        this.buf = Buffer.concat([this.buf, chunk]); this.pump();
      });
      sock.on('error', reject);
    });
  }
  pump() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = this.buf.readUInt32BE(6); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      const i = this.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) { const w = this.waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.resolve(msg); }
      else this.msgs.push(msg);
    }
  }
  send(o) {
    const p = Buffer.from(JSON.stringify(o), 'utf8');
    let head;
    if (p.length < 126) head = Buffer.from([0x81, 0x80 | p.length]);
    else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(p.length, 2); }
    const mask = crypto.randomBytes(4); const m = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) m[i] = p[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, m]));
  }
  wait(pred, label, timeout = 4000) {
    const hit = this.msgs.findIndex(pred);
    if (hit >= 0) return Promise.resolve(this.msgs.splice(hit, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error('等待超时：' + label)); }, timeout);
      this.waiters.push(w);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + DBG,
    '--user-data-dir=' + PROFILE,
    '--window-size=1280,900',
    'http://localhost:' + PORT + '/'
  ], { stdio: 'ignore' });

  try {
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      await sleep(250);
      try {
        const list = await getJson('http://127.0.0.1:' + DBG + '/json/list');
        page = list.find((p) => p.type === 'page' && p.url.indexOf('localhost:' + PORT) >= 0);
      } catch (e) { /* 还没起来 */ }
    }
    if (!page) throw new Error('拿不到调试页面');

    const ws = new WS();
    await ws.connect(page.webSocketDebuggerUrl);
    await ws.call('Runtime.enable');
    await ws.call('Page.enable');

    const errors = [];
    ws.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    });

    const evalJs = async (expr) => {
      const r = await ws.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面脚本出错：' + JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };

    const shot = async (name) => {
      const r = await ws.call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(__dirname, name), Buffer.from(r.data, 'base64'));
      return name;
    };

    await sleep(600);
    // 等页面真正就绪（headless 有时候列表里的页面还没加载完）
    try { await ws.call('Page.navigate', { url: 'http://localhost:' + PORT + '/' }); } catch (e) { /* ignore */ }
    await sleep(900);
    let ready = false;
    for (let i = 0; i < 24 && !ready; i++) {
      try { ready = await evalJs(`!!document.getElementById('nameInput')`); } catch (e) { /* ignore */ }
      if (!ready) await sleep(300);
    }
    if (!ready) throw new Error('页面没有就绪');

    // 1. 浏览器创建房间
    await evalJs(`document.getElementById('nameInput').value='浏览器玩家';document.getElementById('createBtn').click();`);
    await sleep(800);
    const code = await evalJs(`document.getElementById('roomCode').textContent`);
    if (!code || code.length !== 4) throw new Error('房间码没出来：' + code);
    console.log('房间码', code);

    // 2. Node 玩家加入
    const p = new Player();
    await p.connect();
    p.send({ t: 'hello', token: '' });
    const hello = await p.wait((m) => m.t === 'hello', 'hello');
    p.send({ t: 'join', code, name: 'Node玩家' });
    await p.wait((m) => m.t === 'joined', 'joined');
    p.send({ t: 'setDeck', deckId: 'madoka' });
    await sleep(400);

    // 3. 浏览器选卡组并准备
    await evalJs(`document.querySelector('.deck[data-deck="gakkou"]').click();`);
    await sleep(500);
    await evalJs(`document.getElementById('readyBtn').click();`);
    await sleep(300);
    p.send({ t: 'ready', ready: true });

    const sv = await p.wait((m) => m.t === 'state', '开局');
    console.log('开局阶段', sv.view.phase, '先手', sv.view.first);

    const waitFor = async (expr, label, ms = 6000) => {
      for (let i = 0; i < ms / 200; i++) {
        try { if (await evalJs(expr)) return true; } catch (e) { /* 页面重载中 */ }
        await sleep(200);
      }
      throw new Error('等待页面元素超时：' + label);
    };

    // 4. 双方换牌
    await waitFor(`!!document.querySelector('#midActions .btn.primary')`, '换牌确认按钮');
    await evalJs(`document.querySelector('#midActions .btn.primary').click();`);
    p.send({ t: 'action', action: { type: 'mulligan', cards: [] } });
    const play = await p.wait((m) => m.t === 'state' && m.view.phase === 'play', '进入对局');
    await sleep(500);
    await shot('shot_table_play.png');

    // 5. 如果先手是 Node，先出一张牌；再让浏览器部署
    if (play.view.active === 'P2') {
      const idx = play.view.me.hand.findIndex((c) => hello.cards[c.cid].type === 'unit' && hello.cards[c.cid].level === 1);
      if (idx >= 0) p.send({ t: 'action', action: { type: 'deploy', hand: idx, slot: 0 } });
      await sleep(400);
      p.send({ t: 'action', action: { type: 'endTurn' } });
      await sleep(600);
    }

    await waitFor(`document.querySelectorAll('#myHand .card').length>0`, '手牌出现');
    await evalJs(`
      const c=[...document.querySelectorAll('#myHand .card')].find(el=>{
        const lv=el.querySelector('.c-lv'); return lv && lv.textContent.trim()==='Ⅰ';
      });
      if(c) c.click();
    `);
    await sleep(250);
    await evalJs(`const s=document.querySelector('#myField .slot.drop'); if(s) s.click();`);
    await sleep(700);
    await shot('shot_table_deploy.png');

    // 5.5 选中一张手牌 → 卡牌详情条必须展示完整说明（不能被 line-clamp 截断）
    const selName = await evalJs(`
      (function(){
        const c=[...document.querySelectorAll('#myHand .card')].find(el=>{
          const lv=el.querySelector('.c-lv');
          return lv && lv.textContent.trim() && !el.classList.contains('cmd');
        });
        if(!c) return '';
        c.click();
        return c.querySelector('.c-name').textContent;
      })()
    `);
    if (!selName) throw new Error('手牌里没有可选单位');
    await sleep(300);
    const det = JSON.parse(await evalJs(`(function(){
      const box=document.getElementById('cardDetail');
      const tx=box.querySelector('.cd-text');
      return JSON.stringify({
        hidden: box.classList.contains('hidden'),
        name: (box.querySelector('.cd-name')||{textContent:''}).textContent,
        act: (box.querySelector('.cd-act')||{textContent:''}).textContent,
        kwRows: box.querySelectorAll('.cd-kw-row').length,
        clamp: tx ? getComputedStyle(tx).webkitLineClamp : 'missing',
        clipped: tx ? (tx.scrollHeight > tx.clientHeight + 2) : true,
        textLen: tx ? tx.textContent.length : 0
      });
    })()`));
    console.log('卡牌详情', det);
    if (det.hidden) throw new Error('选中手牌后没有出现卡牌详情条');
    if (det.name !== selName) throw new Error('详情条名称不对：' + det.name + ' / 期望 ' + selName);
    if (det.textLen < 8) throw new Error('详情条没显示说明文字');
    if (det.clamp !== 'none') throw new Error('详情文字仍被截断（line-clamp=' + det.clamp + '）');
    if (!det.act) throw new Error('详情条没有“当前能否打出”的提示');
    await shot('shot_card_detail.png');

    // 5.6 卡组说明弹层：能列出本卡组全部卡牌 + 关键词释义
    await evalJs(`document.getElementById('deckInfoBtn').click();`);
    await sleep(400);
    const deckInfo = JSON.parse(await evalJs(`(function(){
      const ov=document.getElementById('overlay'), box=document.getElementById('overlayCard');
      return JSON.stringify({
        hidden: ov.classList.contains('hidden'),
        wide: ov.classList.contains('wide'),
        title: (box.querySelector('h2')||{textContent:''}).textContent,
        heads: [...box.querySelectorAll('.deck-h')].map(h=>h.textContent),
        rows: box.querySelectorAll('.deck-row').length,
        kwRows: box.querySelectorAll('.cd-kw-row').length
      });
    })()`));
    console.log('卡组说明', deckInfo);
    if (deckInfo.hidden) throw new Error('点“卡组说明”没有打开弹层');
    if (!deckInfo.title) throw new Error('卡组说明没有标题');
    if (deckInfo.rows < 5) throw new Error('卡组说明的卡牌条目太少：' + deckInfo.rows);
    if (deckInfo.kwRows < 1) throw new Error('卡组说明缺少关键词释义');
    await shot('shot_deck_info.png');
    await evalJs(`document.querySelector('#overlayCard .btn.small').click();`);
    await sleep(300);

    const rects = await evalJs(`
      (function(){
        const r=(s)=>{const e=document.querySelector(s); if(!e) return null; const b=e.getBoundingClientRect(); return [Math.round(b.top),Math.round(b.bottom),Math.round(b.height)];};
        return JSON.stringify({table:r('#table'), panel:r('.my-panel'), hand:r('#myHand'), field:r('#myField'), log:r('.log-panel'), viewport:[innerWidth,innerHeight]});
      })()
    `);
    console.log('元素位置', rects);

    // 手机尺寸再看一眼
    await ws.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(600);
    await evalJs(`
      (function(){
        const c=[...document.querySelectorAll('#myHand .card')].find(el=>{
          const lv=el.querySelector('.c-lv');
          return lv && lv.textContent.trim() && !el.classList.contains('cmd');
        });
        if(c) c.click();
      })()
    `);
    await sleep(400);
    await shot('shot_table_mobile.png');
    await ws.call('Emulation.clearDeviceMetricsOverride');

    // 6. 看战报与手牌数
    const handCount = await evalJs(`document.querySelectorAll('#myHand .card').length`);
    const logCount = await evalJs(`document.querySelectorAll('#logList .lg').length`);
    console.log('手牌元素', handCount, '战报条数', logCount);

    // 7. 观战：另开一个标签页，只看不打
    const tgt = await ws.call('Target.createTarget', { url: 'about:blank' });
    let specPage = null;
    for (let i = 0; i < 20 && !specPage; i++) {
      await sleep(250);
      const list = await getJson('http://127.0.0.1:' + DBG + '/json/list');
      specPage = list.find((x) => x.id === tgt.targetId);
    }
    if (!specPage) throw new Error('观战标签页没起来');
    const ws2 = new WS();
    await ws2.connect(specPage.webSocketDebuggerUrl);
    await ws2.call('Runtime.enable');
    await ws2.call('Page.enable');
    const eval2 = async (expr) => {
      const r = await ws2.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('观战页脚本出错：' + JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    await ws2.call('Page.navigate', { url: 'http://localhost:' + PORT + '/' });
    await sleep(1200);
    let ready2 = false;
    for (let i = 0; i < 24 && !ready2; i++) {
      try { ready2 = await eval2(`!!document.getElementById('watchBtn')`); } catch (e) { /* ignore */ }
      if (!ready2) await sleep(300);
    }
    if (!ready2) throw new Error('观战页没有就绪');
    // 同一个浏览器配置里 localStorage 存着房主自己的 token，不清掉会被“重连回原座位”
    await eval2(`localStorage.removeItem('sb_token'); localStorage.removeItem('sb_room'); location.reload();`);
    await sleep(1200);
    ready2 = false;
    for (let i = 0; i < 24 && !ready2; i++) {
      try { ready2 = await eval2(`!!document.getElementById('watchBtn')`); } catch (e) { /* ignore */ }
      if (!ready2) await sleep(300);
    }
    if (!ready2) throw new Error('观战页刷新后没就绪');
    await eval2(`document.getElementById('codeInput').value='${code}';document.getElementById('watchBtn').click();`);
    await sleep(1100);
    const spec = await eval2(`(function(){
      const chip=document.getElementById('turnChip').textContent;
      const note=document.getElementById('myHand').textContent.trim().slice(0,30);
      const btns=document.querySelectorAll('#midActions .btn').length;
      const cards=document.querySelectorAll('#myHand .card').length;
      return JSON.stringify({chip:chip,note:note,btns:btns,handCards:cards});
    })()`);
    console.log('观战页状态', spec);
    const specObj = JSON.parse(spec);
    if (specObj.chip.indexOf('观战') < 0) throw new Error('观战页标题不对：' + specObj.chip);
    if (specObj.btns !== 0) throw new Error('观战页不该有操作按钮，实际 ' + specObj.btns);
    if (specObj.handCards !== 0) throw new Error('观战页不该看到手牌');
    const shot2 = await ws2.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, 'shot_spec_table.png'), Buffer.from(shot2.data, 'base64'));

    if (errors.length) {
      console.log('前端异常：\n' + errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log('✅ 牌桌渲染与部署交互正常，无前端异常');
    }
  } finally {
    edge.kill();
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((e) => { console.error('❌ ' + e.message); process.exit(1); });


