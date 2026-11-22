'use strict';
/**
 * 升变卡牌 · 客户端
 * 只负责画界面和收集点击；合法性和结果以服务器返回为准。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const ROMAN = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ'];

  const S = {
    ws: null,
    token: localStorage.getItem('sb_token') || '',
    cards: {},
    kwText: {},
    decks: [],
    cfg: {},
    view: null,
    you: null,
    watch: false,
    code: '',
    lobby: null,
    sel: null,        // {type:'hand', i} | {type:'attack', uid}
    mats: [],         // 升变材料 uid
    cmd: null,        // {i, kind:'enemyUnit'|'allyUnit'}
    mulliganSel: new Set(),
    overlayMode: '',
    retry: 0,
    name: localStorage.getItem('sb_name') || ''
  };

  /* ---------------- 基础工具 ---------------- */

  function E(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, isErr ? 2600 : 1800);
  }

  function def(cid) { return S.cards[cid] || { id: cid, name: cid, type: 'unit', level: 1, atk: 0, hp: 0, text: '' }; }
  function factionOf(cid) {
    if (String(cid).indexOf('_yan') >= 0) return 'yan';
    if (String(cid).indexOf('_sen') >= 0) return 'sen';
    if (String(cid).indexOf('_ying') >= 0) return 'ying';
    return 'none';
  }

  function kwChips(kw) {
    const wrap = E('div', 'c-kw');
    if (!kw) return wrap;
    Object.keys(kw).forEach((k) => {
      const label = S.kwText[k] || k;
      const val = kw[k];
      const text = typeof val === 'number' ? label + val : label;
      wrap.appendChild(E('span', null, text));
    });
    return wrap;
  }

  /* ---------------- 卡牌渲染 ---------------- */

  function buildCard(cardDef, unit, extra) {
    const c = E('div', 'card f-' + factionOf(cardDef.id));
    if (cardDef.type === 'command') c.classList.add('cmd');
    if (extra && extra.selected) c.classList.add('selected');
    if (extra && extra.dim) c.classList.add('dim');
    if (extra && extra.targetable) c.classList.add('targetable');

    if (cardDef.type === 'command') {
      c.appendChild(E('div', 'c-cost', String(cardDef.cost == null ? 0 : cardDef.cost)));
    }

    const top = E('div', 'c-top');
    if (cardDef.type === 'command') {
      top.appendChild(E('span', 'c-lv', ''));
      top.appendChild(E('span', 'c-dur', '指令'));
    } else {
      const lv = unit ? unit.level : cardDef.level;
      top.appendChild(E('span', 'c-lv', ROMAN[lv] || ''));
      const dur = unit ? ('耐 ' + unit.dur) : (cardDef.dur == null ? '' : '耐 ' + cardDef.dur);
      top.appendChild(E('span', 'c-dur', dur));
    }
    c.appendChild(top);

    c.appendChild(E('div', 'c-name', cardDef.name));

    const kwWrap = kwChips(unit ? unit.kw : cardDef.kw);
    if (unit) {
      const done = (unit.attacksLeft || 0) <= 0;
      if (done) c.classList.add('tapped');
      if (unit.sick) c.classList.add('sick');
      const tag = unit.stunned ? '眩晕' : (done ? '已行动' : (unit.sick ? '部署当回合' : ''));
      if (tag) {
        const chip = E('span', 'tag', tag);
        kwWrap.insertBefore(chip, kwWrap.firstChild);
      }
      if (unit.suppress) {
        kwWrap.appendChild(E('span', 'tag tag-bad', '压制' + unit.suppress));
      }
      if (unit.equipCount) {
        kwWrap.appendChild(E('span', 'tag', '装备' + unit.equipCount));
      }
      if (unit.maxAttacks > 1) {
        kwWrap.appendChild(E('span', 'tag', '可攻击' + unit.maxAttacks + '次'));
      }
    }
    c.appendChild(kwWrap);

    const text = cardDef.text || '';
    if (text) c.appendChild(E('div', 'c-text', text));

    const stats = E('div', 'c-stats');
    if (cardDef.type === 'unit') {
      stats.appendChild(E('div', 'c-atk', String(unit ? unit.atk : cardDef.atk || 0)));
      const hp = unit ? unit.hp : (cardDef.hp || 0);
      const hpEl = E('div', 'c-hp', String(hp));
      if (unit && hp < unit.hpMax) hpEl.style.color = '#ff8b7a';
      stats.appendChild(hpEl);
    }
    c.appendChild(stats);
    return c;
  }

  /* 点击单位卡时展示它的完整说明（手机上卡片太小，文字看不全） */
  function unitInfo(u) {
    const d = def(u.cardId);
    const parts = [d.name, '攻 ' + u.atk + '/耐 ' + u.hp + '/耐久 ' + u.dur];
    if (u.kw && u.kw.stealth) parts.push('隐匿');
    if (u.stunned) parts.push('眩晕中');
    toast(parts.join('｜') + (d.text ? '　' + d.text : ''));
  }

  /* ---------------- 连接 ---------------- */

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host;
  }

  function connect() {
    if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
    let ws;
    try { ws = new WebSocket(wsUrl()); } catch (e) { scheduleRetry(); return; }
    S.ws = ws;

    ws.onopen = () => {
      setConn(true);
      S.retry = 0;
      ws.send(JSON.stringify({ t: 'hello', token: S.token }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handle(msg);
    };
    ws.onclose = () => { setConn(false); scheduleRetry(); };
    ws.onerror = () => { setConn(false); };
  }

  function scheduleRetry() {
    S.retry = Math.min(S.retry + 1, 6);
    setTimeout(connect, 1000 * S.retry);
  }

  function setConn(on) {
    const d = $('connDot');
    d.className = 'dot ' + (on ? 'online' : 'offline');
    d.title = on ? '已连接' : '连接断开，正在重连…';
  }

  function send(obj) {
    if (!S.ws || S.ws.readyState !== 1) { toast('连接断开，正在重连…', true); return; }
    S.ws.send(JSON.stringify(obj));
  }

  function handle(msg) {
    switch (msg.t) {
      case 'hello':
        S.cards = msg.cards || {};
        S.kwText = msg.kwText || {};
        S.decks = msg.decks || [];
        S.cfg = msg.config || {};
        if (msg.token) { S.token = msg.token; localStorage.setItem('sb_token', msg.token); }
        renderLobby();
        renderDecks();
        break;

      case 'joined':
        S.code = msg.code;
        S.you = msg.you;
        S.watch = !!msg.watch || msg.you === 'SPEC';
        $('roomLabel').textContent = '房间 ' + msg.code + (S.watch ? '（观战）' : '');
        localStorage.setItem('sb_room', msg.code);
        $('roomPanel').classList.remove('hidden');
        if (msg.resumed) toast('已回到房间 ' + msg.code);
        break;

      case 'lobby':
        S.lobby = msg;
        S.code = msg.code;
        S.you = msg.you;
        S.watch = !!msg.watch || msg.you === 'SPEC';
        $('roomLabel').textContent = '房间 ' + msg.code + (S.watch ? '（观战）' : '');
        renderLobby();
        break;

      case 'state':
        S.view = msg.view;
        S.you = msg.you;
        S.watch = msg.you === 'SPEC' || !!(msg.view && msg.view.spectator);
        showTable();
        renderTable();
        break;

      case 'err':
        toast(msg.msg || '操作失败', true);
        break;

      case 'toast':
        toast(msg.msg || '');
        break;
    }
  }

  /* ---------------- 大厅 ---------------- */

  function showTable() {
    $('lobby').classList.add('hidden');
    $('table').classList.remove('hidden');
  }

  function showLobby() {
    $('table').classList.add('hidden');
    $('lobby').classList.remove('hidden');
  }

  function renderLobby() {
    const np = $('nameInput');
    if (!np.value) np.value = S.name;

    const rp = $('roomPanel');
    if (!S.lobby) { rp.classList.add('hidden'); return; }
    rp.classList.remove('hidden');
    $('roomCode').textContent = S.lobby.code;

    const seats = S.lobby.players;
    ['P1', 'P2'].forEach((slot) => {
      const box = $('seat' + slot);
      const p = seats.find((x) => x.slot === slot);
      box.innerHTML = '';
      if (!p || !p.name) {
        box.className = 'seat empty';
        box.textContent = '等待玩家加入…';
        return;
      }
      box.className = 'seat';
      const deckInfo = S.decks.find((x) => x.id === p.deckId);
      box.appendChild(E('div', 's-name', p.name + (slot === S.lobby.you ? '（你）' : '')));
      box.appendChild(E('div', 's-deck', deckInfo ? deckInfo.name : '未选卡组'));
      const r = E('div', 's-ready ' + (p.ready ? 'on' : 'off'), p.ready ? '已准备' : '未准备');
      box.appendChild(r);
      if (!p.online) box.appendChild(E('div', 's-you', '离线，等待重连…'));
    });

    const me = seats.find((x) => x.slot === S.lobby.you);
    const rb = $('readyBtn');
    if (S.watch) {
      rb.textContent = '观战中';
      rb.disabled = true;
    } else {
      rb.textContent = me && me.ready ? '取消准备' : '准备';
      rb.disabled = !(me && me.deckId);
    }
    const watchers = (S.lobby.spectCount || 0) ? '（' + S.lobby.spectCount + ' 人观战）' : '';
    $('roomHint').textContent = S.watch
      ? (S.lobby.status === 'playing'
        ? '对局进行中，正在同步观战…' + watchers
        : '你已进入观战，等双方开始后自动显示牌桌。' + watchers)
      : (S.lobby.status === 'playing'
        ? '对局进行中…' + watchers
        : '双方都点了“准备”后自动开局。' + watchers);

    Array.from($('deckList').children).forEach((node) => {
      node.classList.toggle('sel', !!(me && node.dataset.deck === me.deckId));
    });
  }

  function renderDecks() {
    const list = $('deckList');
    list.innerHTML = '';
    S.decks.forEach((d) => {
      const box = E('div', 'deck');
      box.dataset.deck = d.id;
      const fac = E('div', 'd-faction', d.faction);
      box.appendChild(fac);
      box.appendChild(E('div', 'd-name', d.name));
      box.appendChild(E('div', 'd-desc', d.desc || ''));
      const units = (d.units || []).reduce((n, [, c]) => n + c, 0);
      const cmds = (d.commands || []).map((c) => def(c).name).join(' / ');
      box.appendChild(E('div', 'd-meta', units + ' 张单位 · ' + (d.commands || []).length + ' 张指令'));
      box.appendChild(E('div', 'd-cmds', '指令：' + cmds));
      box.onclick = () => {
        if (S.watch) { toast('观战中，不能选卡组'); return; }
        send({ t: 'setDeck', deckId: d.id });
      };
      list.appendChild(box);
    });
  }

  /* ---------------- 牌桌渲染 ---------------- */

  function apPips(el, ap, total) {
    el.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const p = E('span', 'ap-pip' + (i < ap ? '' : ' void'));
      el.appendChild(p);
    }
    el.appendChild(E('span', 'ap-num', ap + '/' + total));
  }

  function renderTable() {
    const v = S.view;
    if (!v) return;
    if (v.spectator) S.watch = true;
    if (!v.yourTurn && v.phase === 'play') clearSel();

    $('myName').textContent = v.me.name;
    $('foeName').textContent = v.foe.name;
    $('myLife').textContent = v.me.life;
    $('foeLife').textContent = v.foe.life;
    apPips($('myAp'), v.me.ap, S.cfg.actionPointsPerTurn || 3);
    apPips($('foeAp'), v.foe.ap, S.cfg.actionPointsPerTurn || 3);

    $('myDeck').textContent = v.me.deckCount;
    $('myDiscard').textContent = v.me.discard.length;
    $('myGrave').textContent = v.me.grave.length;
    $('myExile').textContent = v.me.exile.length;
    $('foeDeck').textContent = v.foe.deckCount;
    $('foeDiscard').textContent = v.foe.discard.length;
    $('foeGrave').textContent = v.foe.grave.length;
    $('foeHand').textContent = v.foe.handCount;

    renderField('foe');
    renderField('me');
    renderHand();
    renderMid();
    renderHintAndBar();
    renderLog();
    renderOverlay();
  }

  function unitDef(u) { return def(u.cardId); }

  function renderField(side) {
    const v = S.view;
    const isMe = side === 'me';
    const data = isMe ? v.me.field : v.foe.field;
    const wrap = isMe ? $('myField') : $('foeField');
    wrap.innerHTML = '';
    const foeField = v.foe.field.filter(Boolean);
    const attackMode = !!(S.sel && S.sel.type === 'attack' && v.yourTurn && v.phase === 'play');
    const cmdEnemy = !!(S.cmd && S.cmd.kind === 'enemyUnit');
    const cmdAlly = !!(S.cmd && S.cmd.kind === 'allyUnit');
    const matMode = !!(S.sel && S.sel.type === 'hand' && levelOfHand() >= 2);
    const equipMode = !!(S.sel && S.sel.type === 'equip' && v.yourTurn && v.phase === 'play');
    const equipMin = equipMode ? (def(v.me.hand[S.sel.i] ? v.me.hand[S.sel.i].cid : '').kw || {}).equipMinLevel : 2;

    for (let slot = 0; slot < v.slots; slot++) {
      const u = data[slot];
      const box = E('div', 'slot');
      if (!u) {
        box.classList.add('empty');
        box.textContent = '+';
        if (isMe && S.sel && S.sel.type === 'hand' && levelOfHand() === 1) {
          box.classList.add('drop');
          box.onclick = () => tryDeploy(slot);
        }
        wrap.appendChild(box);
        continue;
      }
      const card = buildCard(unitDef(u), u, {});
      const visible = !u.kw.stealth || !foeField.some((x) => x.uid !== u.uid && !x.kw.stealth);

      if (v.spectator) {
        card.onclick = (ev) => { ev.stopPropagation(); unitInfo(u); };
      } else if (!isMe) {
        if ((cmdEnemy || attackMode) && visible) {
          card.classList.add('targetable');
          card.onclick = (ev) => { ev.stopPropagation(); onFoeUnit(u.uid); };
        } else {
          card.onclick = (ev) => {
            ev.stopPropagation();
            if (cmdEnemy || attackMode) toast('该单位处于隐匿状态，无法被选中', true);
            else unitInfo(u);
          };
        }
      } else {
        if (cmdAlly) {
          card.classList.add('targetable');
          card.onclick = (ev) => { ev.stopPropagation(); onMyUnit(u.uid); };
        } else if (equipMode) {
          const canHost = u.level >= (equipMin || 2);
          if (canHost) card.classList.add('targetable');
          card.onclick = (ev) => { ev.stopPropagation(); doEquip(u.uid, canHost); };
        } else if (matMode) {
          if (S.mats.indexOf(u.uid) >= 0) card.classList.add('selected');
          else card.classList.add('targetable');
          card.onclick = (ev) => { ev.stopPropagation(); toggleMat(u.uid); };
        } else {
          if (attackMode && canAttackNow(u)) card.classList.add('targetable');
          card.onclick = (ev) => { ev.stopPropagation(); onMyUnit(u.uid); };
        }
      }
      box.appendChild(card);
      wrap.appendChild(box);
    }

    if (!isMe) {
      const fp = $('foePanel');
      const canHitFace = attackMode && canAttackPlayer();
      fp.classList.toggle('targetable', !!canHitFace);
      fp.onclick = canHitFace ? (ev) => {
        if (ev.target.closest('.zone-chip')) return;
        attackPlayer();
      } : null;
    }
  }

  function levelOfHand() {
    if (!S.sel || S.sel.type !== 'hand' || !S.view) return 0;
    const card = S.view.me.hand[S.sel.i];
    if (!card) return 0;
    return def(card.cid).level || 1;
  }

  function handCard() {
    if (!S.sel || S.sel.type !== 'hand') return null;
    return S.view.me.hand[S.sel.i] || null;
  }

  function renderHand() {
    const v = S.view;
    const wrap = $('myHand');
    wrap.innerHTML = '';
    if (v.spectator) {
      wrap.appendChild(E('div', 'hint spec-note', '观战中：两家手牌都不公开，只能看场上和战报。'));
      return;
    }
    if (!v.me.hand) return;

    v.me.hand.forEach((hc, i) => {
      const cd = def(hc.cid);
      const extra = {};
      if (S.view.phase === 'mulligan') {
        if (S.mulliganSel.has(i)) extra.dim = true;
      } else if (S.sel && S.sel.type === 'hand' && S.sel.i === i) {
        extra.selected = true;
      }
      const card = buildCard(cd, null, extra);
      card.dataset.hand = i;
      card.onclick = () => onHandClick(i);
      wrap.appendChild(card);
    });
  }

  function renderMid() {
    const v = S.view;
    const bar = $('midActions');
    bar.innerHTML = '';

    if (v.spectator) {
      bar.appendChild(E('span', 'turn-chip spec', '观战中'));
      return;
    }

    if (v.phase === 'mulligan') {
      const btn = E('button', 'btn primary small', '确认换牌');
      btn.disabled = !!v.me.mullDone;
      btn.onclick = () => {
        send({ t: 'action', action: { type: 'mulligan', cards: Array.from(S.mulliganSel) } });
        S.mulliganSel.clear();
      };
      bar.appendChild(btn);
      return;
    }

    if (v.phase === 'over') {
      const btn = E('button', 'btn primary small', '再来一局');
      btn.onclick = () => send({ t: 'rematch' });
      bar.appendChild(btn);
      return;
    }

    if (v.yourTurn) {
      if (S.sel && S.sel.type === 'hand' && levelOfHand() >= 2) {
        const rec = matchRecipe(levelOfHand(), selectedMats());
        if (rec) {
          const b = E('button', 'btn primary small', '确认升变');
          b.onclick = () => doUpgrade();
          bar.appendChild(b);
        }
      }
      const end = E('button', 'btn small', '结束回合');
      end.onclick = () => {
        clearSel();
        send({ t: 'action', action: { type: 'endTurn' } });
      };
      bar.appendChild(end);
    }
    if (S.sel || S.cmd) {
      const cancel = E('button', 'btn ghost small', '取消');
      cancel.onclick = () => { clearSel(); renderTable(); };
      bar.appendChild(cancel);
    }
  }

  function renderHintAndBar() {
    const v = S.view;
    const chip = $('turnChip');
    if (v.spectator) {
      const activeName = v.active === 'P1' ? v.me.name : v.foe.name;
      chip.textContent = v.phase === 'mulligan' ? '观战 · 换牌阶段' : ('观战 · 第 ' + v.turn + ' 回合 · ' + activeName + '的回合');
      chip.className = 'turn-chip spec';
      $('hintBar').textContent = v.phase === 'mulligan' ? '观战中，等双方换完牌开始。' : '观战中：只能看，不能操作。';
      return;
    }
    chip.textContent = v.phase === 'mulligan'
      ? '换牌阶段'
      : ('第 ' + v.turn + ' 回合 · ' + (v.yourTurn ? '你的回合' : v.foe.name + ' 的回合'));
    chip.className = 'turn-chip' + (v.yourTurn ? ' mine' : '');

    let hint = '';
    if (v.phase === 'mulligan') {
      hint = v.me.mullDone
        ? '已确认换牌，等待对手…'
        : '点击不想要的牌（可多选），再点“确认换牌”；不选就是全部保留。';
    } else if (v.phase === 'over') {
      hint = '对局结束。';
    } else if (!v.yourTurn) {
      hint = '等待对手操作…';
    } else if (S.cmd) {
      hint = S.cmd.kind === 'enemyUnit' ? '点击一个敌方单位作为指令目标。' : '点击一个己方单位作为指令目标。';
    } else if (S.sel && S.sel.type === 'attack') {
      hint = '点击敌方单位，或点击对手信息栏直接攻击玩家。';
    } else if (S.sel && S.sel.type === 'hand') {
      const card = handCard();
      if (!card) { hint = ''; }
      else if (levelOfHand() === 1) hint = '点击一个空部署槽，把【' + def(card.cid).name + '】放上去。';
      else {
        const recs = S.cfg.upgradeRecipes[levelOfHand()] || [];
        const recTxt = recs.map((r) => Object.keys(r).map((lv) => ROMAN[Number(lv)] + '×' + r[lv]).join('')).join(' 或 ');
        const ok = matchRecipe(levelOfHand(), selectedMats());
        hint = '升变【' + def(card.cid).name + '】需要 ' + (recTxt || '无配方') +
          '，已选：' + (selectedMats().map((u) => ROMAN[u.level]).join('+') || '无') +
          (ok ? '（可以升变，点“确认升变”）' : '');
      }
    } else {
      hint = '你的回合：点手牌部署/升变/用指令，点自己的单位攻击。';
    }
    $('hintBar').textContent = hint;
  }

  function renderLog() {
    const list = $('logList');
    list.innerHTML = '';
    (S.view.log || []).forEach((l) => {
      const isTurn = l.text.indexOf('———') === 0;
      const d = E('div', 'lg' + (isTurn ? ' turn' : ''), l.text);
      list.appendChild(d);
    });
    list.scrollTop = list.scrollHeight;
  }

  /* ---------------- 选择与行动 ---------------- */

  function clearSel() {
    S.sel = null;
    S.mats = [];
    S.cmd = null;
  }

  function selectedMats() {
    if (!S.view) return [];
    const byUid = {};
    S.view.me.field.filter(Boolean).forEach((u) => { byUid[u.uid] = u; });
    return S.mats.map((uid) => byUid[uid]).filter(Boolean);
  }

  function matchRecipe(level, mats) {
    const recipes = (S.cfg.upgradeRecipes || {})[level] || [];
    const got = mats.map((u) => u.level).sort();
    if (!got.length) return null;
    return recipes.find((rec) => {
      const need = [];
      Object.keys(rec).forEach((lv) => {
        for (let k = 0; k < rec[lv]; k++) need.push(Number(lv));
      });
      need.sort();
      return need.length === got.length && need.every((v, i) => v === got[i]);
    }) || null;
  }

  function deployCost(cd) {
    return (cd.kw && cd.kw.immediate) ? 0 : (S.cfg.deployCost == null ? 1 : S.cfg.deployCost);
  }

  function canAttackNow(u) {
    if (!S.view || !S.view.yourTurn || S.view.phase !== 'play') return false;
    if (u.attacksLeft <= 0 || u.stunned) return false;
    if (u.suppress >= 2) return false;
    if (u.sick && !u.kw.swift) return false;
    let cost = u.kw.immediate ? 0 : (S.cfg.attackCost + (u.suppress || 0));
    if (S.view.freeLevel2 && u.level === 2) cost = 0;
    return S.view.me.ap >= cost;
  }

  function canAttackPlayer() {
    if (!S.view) return false;
    if (S.view.foe.field.some(Boolean) && S.cfg.playerAttackRequiresEmptyField) return false;
    return true;
  }

  function onHandClick(i) {
    const v = S.view;
    if (!v) return;
    if (v.phase === 'mulligan') {
      if (v.me.mullDone) return;
      if (S.mulliganSel.has(i)) S.mulliganSel.delete(i); else S.mulliganSel.add(i);
      renderHand();
      return;
    }
    if (v.phase !== 'play') return;
    if (!v.yourTurn) { toast('还没轮到你'); return; }

    const hc = v.me.hand[i];
    if (!hc) return;
    const cd = def(hc.cid);

    if (cd.type === 'command') {
      const cost = cd.cost || 0;
      if (v.me.ap < cost) { toast('行动点不够（需要 ' + cost + '）', true); return; }
      if (cd.target) {
        S.sel = null; S.mats = [];
        S.cmd = { i, kind: cd.target };
        renderTable();
      } else {
        send({ t: 'action', action: { type: 'command', hand: i } });
        clearSel();
      }
      return;
    }

    // 装备型单位：选一个 Ⅱ 级及以上的己方单位挂上去
    if (cd.kw && cd.kw.equip) {
      if (v.me.ap < (S.cfg.equipCost == null ? 1 : S.cfg.equipCost)) { toast('行动点不够', true); return; }
      const host = v.me.field.find((u) => u && u.level >= (cd.kw.equipMinLevel || 2));
      if (!host) { toast('需要先有一个 ' + (cd.kw.equipMinLevel || 2) + ' 级及以上的己方单位才能装备', true); return; }
      S.cmd = null; S.mats = [];
      S.sel = { type: 'equip', i };
      renderTable();
      toast('点一个 ' + (cd.kw.equipMinLevel || 2) + ' 级及以上的己方单位，把【' + cd.name + '】装备上去');
      return;
    }

    if (cd.level === 1) {
      if (v.me.ap < deployCost(cd)) { toast('行动点不够', true); return; }
      S.cmd = null; S.mats = [];
      S.sel = { type: 'hand', i };
      renderTable();
    } else {
      S.cmd = null;
      S.sel = { type: 'hand', i };
      S.mats = [];
      renderTable();
      const recs = (S.cfg.upgradeRecipes || {})[cd.level] || [];
      const recTxt = recs.map((r) => Object.keys(r).map((lv) => ROMAN[Number(lv)] + '×' + r[lv]).join('')).join(' 或 ');
      toast('升变需要：' + (recTxt || '未配置配方'));
    }
  }

  function tryDeploy(slot) {
    if (!S.sel || S.sel.type !== 'hand') return;
    const i = S.sel.i;
    clearSel();
    send({ t: 'action', action: { type: 'deploy', hand: i, slot } });
  }

  function toggleMat(uid) {
    const idx = S.mats.indexOf(uid);
    if (idx >= 0) S.mats.splice(idx, 1); else S.mats.push(uid);
    renderTable();
  }

  function doUpgrade() {
    if (!S.sel || S.sel.type !== 'hand' || !S.mats.length) return;
    const i = S.sel.i;
    const mats = S.mats.slice();
    clearSel();
    send({ t: 'action', action: { type: 'upgrade', hand: i, materials: mats } });
  }

  function doEquip(uid, canHost) {
    if (!S.sel || S.sel.type !== 'equip') return;
    if (!canHost) { toast('这个单位等级不够，装备需要 ' + (S.view.me.hand[S.sel.i] ? (def(S.view.me.hand[S.sel.i].cid).kw || {}).equipMinLevel || 2 : 2) + ' 级及以上', true); return; }
    const i = S.sel.i;
    clearSel();
    send({ t: 'action', action: { type: 'equip', hand: i, uid } });
  }

  function onMyUnit(uid) {
    if (S.cmd && S.cmd.kind === 'allyUnit') {
      const i = S.cmd.i;
      clearSel();
      send({ t: 'action', action: { type: 'command', hand: i, target: { kind: 'unit', uid } } });
      return;
    }
    if (!S.view || !S.view.yourTurn) { toast('还没轮到你'); return; }
    const u = S.view.me.field.find((x) => x && x.uid === uid);
    if (!u) return;
    if (!canAttackNow(u)) {
      let why = '这个单位本回合不能攻击';
      if ((u.attacksLeft || 0) <= 0) why = '这个单位本回合已经行动完了';
      else if (u.stunned) why = '眩晕单位无法攻击';
      else if (u.suppress >= 2) why = '压制 2 层，无法攻击';
      else if (u.sick && !u.kw.swift) why = '部署当回合不能攻击（需要“迅捷”）';
      else if (S.view.me.ap < (S.cfg.attackCost + (u.suppress || 0))) why = '行动点不够';
      toast(why, true);
      return;
    }
    S.cmd = null; S.mats = [];
    S.sel = { type: 'attack', uid };
    renderTable();
  }

  function onFoeUnit(uid) {
    if (S.cmd) {
      const i = S.cmd.i;
      const kind = S.cmd.kind;
      if (kind !== 'enemyUnit') { toast('这个指令需要选择己方单位', true); return; }
      clearSel();
      send({ t: 'action', action: { type: 'command', hand: i, target: { kind: 'unit', uid } } });
      return;
    }
    if (!S.sel || S.sel.type !== 'attack') { toast('先选择一个自己的单位', true); return; }
    const atkUid = S.sel.uid;
    clearSel();
    send({ t: 'action', action: { type: 'attack', uid: atkUid, target: { kind: 'unit', uid } } });
  }

  function attackPlayer() {
    if (!S.sel || S.sel.type !== 'attack') return;
    const uid = S.sel.uid;
    clearSel();
    send({ t: 'action', action: { type: 'attack', uid, target: { kind: 'player' } } });
  }

  /* ---------------- 区域查看 / 弹层 ---------------- */

  function zoneData(key) {
    const v = S.view;
    if (!v) return null;
    switch (key) {
      case 'myDeck': return { title: '你的牌库', cids: null, count: v.me.deckCount };
      case 'myDiscard': return { title: '你的弃牌区', cids: v.me.discard };
      case 'myGrave': return { title: '你的阵亡区', cids: v.me.grave, grave: true };
      case 'myExile': return { title: '你的除外区', cids: v.me.exile };
      case 'foeDiscard': return { title: v.foe.name + ' 的弃牌区', cids: v.foe.discard };
      case 'foeGrave': return { title: v.foe.name + ' 的阵亡区', cids: v.foe.grave };
      case 'foeDeck': return { title: v.foe.name + ' 的牌库', cids: null, count: v.foe.deckCount };
      default: return null;
    }
  }

  function openZone(key) {
    const z = zoneData(key);
    if (!z) return;
    const box = $('overlayCard');
    box.innerHTML = '';
    box.appendChild(E('h2', null, z.title));
    if (!z.cids) {
      box.appendChild(E('p', null, '还有 ' + (z.count || 0) + ' 张牌（不可查看具体内容）。'));
    } else if (!z.cids.length) {
      box.appendChild(E('p', null, '这里是空的。'));
    } else {
      const list = E('div', 'zone-list');
      z.cids.forEach((cid, idx) => {
        const name = def(cid).name + ' ' + (ROMAN[def(cid).level] || '');
        const item = E('span', 'zone-item', name);
        if (z.grave && def(cid).effects && def(cid).effects.onDeath) {
          item.style.cursor = 'pointer';
          item.style.borderColor = 'rgba(232,180,90,.5)';
          item.title = '点击发动亡计';
          item.onclick = () => {
            closeOverlay();
            send({ t: 'action', action: { type: 'deathrattle', grave: idx } });
          };
        }
        list.appendChild(item);
      });
      box.appendChild(list);
      if (z.grave) box.appendChild(E('p', null, '带金色边框的牌可以用“亡计”：点击发动，效果结算后除外。'));
    }
    const row = E('div', 'row');
    const close = E('button', 'btn small', '关闭');
    close.onclick = closeOverlay;
    row.appendChild(close);
    box.appendChild(row);
    S.overlayMode = 'zone';
    $('overlay').classList.remove('hidden');
  }

  function closeOverlay() {
    $('overlay').classList.add('hidden');
    S.overlayMode = '';
  }

  function renderOverlay() {
    const v = S.view;
    if (!v) return;
    if (v.spectator) return;
    if (v.phase !== 'over') {
      if (S.overlayMode === 'over' || S.overlayMode === 'overDismissed') closeOverlay();
      return;
    }
    if (S.overlayMode) return;
    const box = $('overlayCard');
    box.innerHTML = '';
    const title = v.winner === 'draw' ? '平局' : (v.winner === S.you ? '你赢了' : '你输了');
    box.appendChild(E('h2', null, title));
    box.appendChild(E('p', null, v.winner === 'draw' ? '双方生命同时归零。' : (v.winner === S.you ? '对手生命归零。' : '你的生命归零了。')));
    const row = E('div', 'row');
    const btn = E('button', 'btn primary', '再来一局');
    btn.onclick = () => { send({ t: 'rematch' }); toast('已准备，等待对手'); };
    row.appendChild(btn);
    const close = E('button', 'btn ghost', '查看牌桌');
    close.onclick = () => {
      S.overlayMode = 'overDismissed';
      $('overlay').classList.add('hidden');
    };
    row.appendChild(close);
    box.appendChild(row);
    S.overlayMode = 'over';
    $('overlay').classList.remove('hidden');
  }

  /* ---------------- 事件绑定 ---------------- */

  $('createBtn').onclick = () => {
    const name = $('nameInput').value.trim() || '无名玩家';
    S.name = name;
    localStorage.setItem('sb_name', name);
    send({ t: 'create', name });
  };

  $('joinBtn').onclick = () => {
    const code = $('codeInput').value.trim().toUpperCase();
    if (!code) { toast('先填房间码', true); return; }
    const name = $('nameInput').value.trim() || '无名玩家';
    S.name = name;
    localStorage.setItem('sb_name', name);
    send({ t: 'join', code, name });
  };

  $('watchBtn').onclick = () => {
    const code = $('codeInput').value.trim().toUpperCase();
    if (!code) { toast('先填房间码', true); return; }
    const name = $('nameInput').value.trim() || '路过的人';
    S.name = name;
    localStorage.setItem('sb_name', name);
    send({ t: 'join', code, name, watch: true });
    toast('以观战身份进入…');
  };

  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('createBtn').click(); });

  $('readyBtn').onclick = () => {
    const me = S.lobby && S.lobby.players.find((x) => x.slot === S.lobby.you);
    send({ t: 'ready', ready: !(me && me.ready) });
  };

  $('roomCode').onclick = () => {
    const code = $('roomCode').textContent;
    if (!code) return;
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast('房间码已复制：' + code));
    else toast('房间码：' + code);
  };

  document.querySelectorAll('.zone-chip[data-zone]').forEach((chip) => {
    chip.onclick = () => openZone(chip.dataset.zone);
  });

  $('overlay').addEventListener('click', (e) => {
    if (e.target === $('overlay') && S.overlayMode !== 'over') closeOverlay();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('overlay').classList.contains('hidden') && S.overlayMode !== 'over') closeOverlay();
      else if (S.sel || S.cmd) { clearSel(); if (S.view) renderTable(); }
    }
  });

  // 点空白处取消选择
  $('table').addEventListener('click', (e) => {
    if (!S.view) return;
    if (e.target.closest('.card') || e.target.closest('.slot') || e.target.closest('.mid-actions') ||
        e.target.closest('.foe-panel') || e.target.closest('.my-panel') || e.target.closest('.log-panel')) return;
    if (S.sel || S.cmd) { clearSel(); renderTable(); }
  });

  /* ---------------- 规则速查 ---------------- */

  function openRules() {
    const box = $('overlayCard');
    box.innerHTML = '';
    box.appendChild(E('h2', null, '规则速查'));
    const lines = [
      '每回合 3 行动点：部署 1、攻击 1、升变 1、指令按卡面消耗。',
      '玩家 10 点生命，单位攻击玩家时造成“单位等级”点伤害；敌方场上还有单位时不能打玩家。',
      '只有 Ⅰ 级能直接部署；Ⅱ 级以上用升变：把场上单位当材料，新单位落在材料的位置。',
      '升变配方：Ⅱ=Ⅰ×1；Ⅲ=Ⅰ×2 或 Ⅱ×1；Ⅳ=Ⅰ×3 或 Ⅲ×1；Ⅴ=Ⅱ×2 或 Ⅳ×1。',
      '单位每回合开始时耐久 -1，耐久归零进弃牌区；血量归零进阵亡区。',
      '部署当回合不能攻击（带“迅捷”的除外）；单位攻击一次后转为“已行动”。',
      '玩家被攻击时抽 1 张；回合结束时每剩 1 点行动点抽 1 张；第 2 回合起每回合开始抽 2 张。',
      '指令用后进弃牌区；同一张指令第 3 次使用后改为除外。',
      '攻击/伤害/血量不是 5 的倍数时向上取 5。'
    ];
    const ul = E('div', 'zone-list');
    ul.style.display = 'block';
    lines.forEach((l) => {
      const p = E('p', null, '· ' + l);
      p.style.margin = '6px 0';
      p.style.color = '#c3cdd9';
      ul.appendChild(p);
    });
    box.appendChild(ul);
    const row = E('div', 'row');
    const close = E('button', 'btn small', '关闭');
    close.onclick = closeOverlay;
    row.appendChild(close);
    box.appendChild(row);
    S.overlayMode = 'rules';
    $('overlay').classList.remove('hidden');
  }

  const topRight = document.querySelector('.top-right');
  const ruleBtn = E('button', 'btn ghost small', '规则');
  ruleBtn.onclick = openRules;
  topRight.insertBefore(ruleBtn, $('connDot'));

  /* ---------------- 启动 ---------------- */

  if (S.name) $('nameInput').value = S.name;
  connect();
})();
