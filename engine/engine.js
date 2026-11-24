'use strict';
/**
 * ============================================================
 *  规则引擎（服务端权威）
 * ============================================================
 *  这里是“裁判”：所有操作都先在这里校验，再改状态，最后把
 *  各自可见的信息发给两边。客户端只负责画出来和收集点击。
 *
 *  想改“某个效果怎么算”，改下面的 applyEffect / attackUnit；
 *  想改“数值和配方”，改 config.js；
 *  想加卡，改 cards.js 就够了（不需要动这里）。
 * ============================================================
 */

const DB = require('./cards');
const DEFAULTS = require('./config');
const CARDS = DB.cards;

const otherOf = (pid) => (pid === 'P1' ? 'P2' : 'P1');
const fail = (msg) => { throw new Error(msg); };

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class Game {
  constructor(opts) {
    this.cfg = Object.assign({}, DEFAULTS, opts.config || {});
    this.nextUid = 1;
    this.logs = [];
    this.phase = 'mulligan';
    this.winner = null;
    this.turn = 0;
    this.returns = [];      // 被“除外”等待返回的单位
    this.soleAll = false;   // 所有单位视为“唯一单位”（下北泽的暑假）
    this.soleAllUntil = 0;
    this.first = Math.random() < 0.5 ? 'P1' : 'P2';
    this.active = this.first;
    this.players = {
      P1: this.makePlayer('P1', opts.p1, opts.deckP1),
      P2: this.makePlayer('P2', opts.p2, opts.deckP2)
    };
    this.log(`对局开始：${this.players[this.first].name} 先手（先手 ${this.cfg.firstDraw} 张，后手 ${this.cfg.secondDraw} 张）`);
    this.draw(this.first, this.cfg.firstDraw, '开局');
    this.draw(otherOf(this.first), this.cfg.secondDraw, '开局');
  }

  /* ---------------- 基础工具 ---------------- */

  r5(n) {
    n = Number(n) || 0;
    if (n <= 0) return 0;
    const step = this.cfg.roundStep;
    return Math.min(this.cfg.maxNumber, Math.ceil(n / step) * step);
  }

  log(text) {
    this.logs.push({ i: this.logs.length + 1, text });
    if (this.logs.length > 200) this.logs.shift();
  }

  makePlayer(id, name, deck) {
    const list = this.expandDeck(deck);
    shuffle(list);
    return {
      id,
      name: String(name || (id === 'P1' ? '玩家1' : '玩家2')),
      deckId: deck.id,
      life: this.cfg.startLife,
      ap: 0,
      deck: list,          // 数组末尾 = 牌库顶（pop 抽牌）
      hand: [],            // { cid, uses }
      discard: [],
      grave: [],
      exile: [],
      field: new Array(this.cfg.fieldSlots).fill(null),
      mullDone: false,
      totalDraw: 0,
      commandUses: {},      // 每张指令用过几次（跨“洗回牌库”累计，第 N 次后除外）
      commandsUsedThisTurn: 0, // 本回合已使用的指令张数（“第 2 张指令”类效果要用）
      apDebt: 0,            // 下回合要少拿的行动点
      nextAp: 0,            // 下回合额外拿的行动点
      extraSlots: 0         // 本回合临时增加的部署槽
    };
  }

  expandDeck(deck) {
    if (!deck || !Array.isArray(deck.units)) fail('卡组数据不正确');
    const out = [];
    deck.units.forEach(([cid, n]) => {
      const def = CARDS[cid];
      if (!def) fail('卡组里有不存在的卡：' + cid);
      if (def.type !== 'unit') fail('units 里只能放单位卡：' + cid);
      for (let i = 0; i < n; i++) out.push(cid);
    });
    (deck.commands || []).forEach((cid) => {
      const def = CARDS[cid];
      if (!def) fail('卡组里有不存在的卡：' + cid);
      if (def.type !== 'command') fail('commands 里只能放指令卡：' + cid);
      out.push(cid);
    });
    return out;
  }

  me(pid) { return this.players[pid]; }
  foe(pid) { return this.players[otherOf(pid)]; }

  owUnit(pid, uid) {
    const p = this.me(pid);
    return p.field.find((u) => u && u.uid === uid && !u.dead) || null;
  }
  foeUnit(pid, uid) {
    const p = this.foe(pid);
    return p.field.find((u) => u && u.uid === uid && !u.dead) || null;
  }
  slotOf(p, unit) { return p.field.findIndex((u) => u === unit); }

  // 是不是“自己这边唯一的一个单位”（下北泽的暑假会让全场都算唯一）
  isSoleOnField(u) {
    if (this.soleAll) return true;
    return this.me(u.owner).field.filter(Boolean).length === 1;
  }

  makeUnit(cid, owner) {
    const def = CARDS[cid];
    if (!def) fail('未知卡：' + cid);
    const dur = def.dur == null ? this.cfg.defaultDurability : def.dur;
    return {
      uid: 'u' + this.nextUid++,
      cardId: cid,
      name: def.name,
      owner,
      level: def.level,
      baseAtk: def.atk || 0,
      baseHp: def.hp || 0,
      atk: def.atk || 0,
      hp: def.hp || 0,
      hpMax: def.hp || 0,
      atkMod: 0,      // 永久加成（buff 效果累加）
      hpMod: 0,
      dmg: 0,          // 累计受到的伤害；血量 = hpMax - dmg
      defBonus: 0,     // 光环给的额外防御
      equip: [],       // 装备在它身上的卡（{cid, atk, hp}）
      dieToDiscard: false, // 光环：阵亡时进弃牌区而不是阵亡区
      cmdDiscount: false,  // 光环：己方每回合第 2 张指令少 1 消耗
      dur,
      kw: Object.assign({}, def.kw || {}),
      tapped: false,
      sick: !!this.cfg.summoningSickness,
      stunned: false,
      stunTurns: 0,
      suppress: 0,
      suppressTurns: 0,
      pressure: 0,
      impactUsed: false,
      maxAttacks: def.kw && def.kw.double ? 2 : 1,
      attacksLeft: def.kw && def.kw.double ? 2 : 1,
      attacksUsedThisTurn: 0,
      dead: false
    };
  }

  /* ---------------- 光环 / 重新计算数值 ---------------- */

  // 按“基础值 + 永久加成 + 装备”重新算一遍，再叠加所有光环。
  // 每次场上发生变化（部署、升变、阵亡、装备、返回）都要调一次。
  recalcAll() {
    ['P1', 'P2'].forEach((pid) => {
      this.me(pid).field.forEach((u) => {
        if (!u) return;
        u.atk = u.baseAtk + u.atkMod;
        u.hpMax = u.baseHp + u.hpMod;
        u.defBonus = 0;
        u.dieToDiscard = false;
        u.cmdDiscount = false;
        (u.equip || []).forEach((e) => {
          u.atk += e.atk || 0;
          u.hpMax += e.hp || 0;
        });
      });
    });
    // 光环：逐张扫场上的单位，把增益发给它影响的对象
    ['P1', 'P2'].forEach((pid) => {
      this.me(pid).field.forEach((src) => {
        if (!src || src.dead) return;
        const def = CARDS[src.cardId];
        if (!def || !def.aura) return;
        def.aura.forEach((a) => {
          this.auraTargets(pid, src, a).forEach((t) => {
            t.atk += a.atk || 0;
            t.hpMax += a.hp || 0;
            if (a.defense) t.defBonus += a.defense;
            if (a.dieToDiscard) t.dieToDiscard = true;
            if (a.cmdDiscount) t.cmdDiscount = true;
            if (a.info) t.info = a.info;
          });
        });
      });
    });
    ['P1', 'P2'].forEach((pid) => {
      this.me(pid).field.forEach((u) => {
        if (!u) return;
        u.hp = u.hpMax - u.dmg;
      });
    });
    // 光环消失可能让某些单位血量掉到 0 以下，这里补一次收尸
    if (!this._inRecalc) {
      const dying = [];
      ['P1', 'P2'].forEach((pid) => {
        this.me(pid).field.forEach((u) => {
          if (u && !u.dead && u.hp <= 0) dying.push(u);
        });
      });
      if (dying.length) {
        this._inRecalc = true;
        try {
          dying.forEach((u) => this.killUnit(u, true));
        } finally {
          this._inRecalc = false;
        }
      }
    }
  }

  // 某张卡的光环作用对象
  auraTargets(pid, src, a) {
    const p = this.me(pid);
    const all = p.field.filter(Boolean);
    switch (a.scope) {
      case 'self':
        return [src];
      // 唯一单位：己方场上只剩它自己
      case 'selfIfSole':
        return all.length === 1 ? [src] : [];
      // 相邻：同一条线上的左右槽位
      case 'adjacent': {
        const idx = p.field.findIndex((u) => u === src);
        return [p.field[idx - 1], p.field[idx + 1]].filter((u) => u && u !== src);
      }
      // 己方其它等级 ≥ N 的单位
      case 'allyAtLeast':
        return all.filter((u) => u !== src && u.level >= (a.level || 1));
      // 己方其它等级不同的单位：有几张就给几次
      case 'allyLevelDiff': {
        const n = all.filter((u) => u !== src && u.level !== src.level).length;
        const out = [];
        for (let i = 0; i < n; i++) out.push(src);
        return out;
      }
      // 自己：有几个相邻的己方单位，就叠加几次
      case 'selfPerAdjacent': {
        const idx = p.field.findIndex((u) => u === src);
        const n = [p.field[idx - 1], p.field[idx + 1]].filter((u) => u && u !== src).length;
        const out = [];
        for (let i = 0; i < n; i++) out.push(src);
        return out;
      }
      // 己方全体（含自己）
      case 'allAlly':
        return all;
      default:
        return [];
    }
  }


  /* ---------------- 抽牌 / 弃牌 / 死亡 ---------------- */

  draw(pid, n, reason) {
    const p = this.me(pid);
    for (let k = 0; k < n; k++) {
      if (p.deck.length === 0) {
        if (p.discard.length === 0) {
          this.log(`${p.name} 牌库与弃牌区均为空，无牌可抽。`);
          break;
        }
        p.deck = shuffle(p.discard.slice());
        p.discard = [];
        this.log(`${p.name} 的弃牌区洗回牌库。`);
      }
      const cid = p.deck.pop();
      p.hand.push({ cid, uses: 0 });
      p.totalDraw++;
    }
    if (reason && n > 0) this.log(`${p.name} 抽 ${n} 张（${reason}），手牌 ${p.hand.length} 张。`);
  }

  discardRandom(pid, n) {
    const p = this.me(pid);
    for (let k = 0; k < n; k++) {
      if (p.hand.length === 0) return;
      const i = Math.floor(Math.random() * p.hand.length);
      const card = p.hand.splice(i, 1)[0];
      p.discard.push(card.cid);
      this.log(`${p.name} 弃掉 ${CARDS[card.cid].name}。`);
    }
  }

  // 把一张牌放进弃牌区，并触发它的“进入弃牌区”效果
  toDiscard(pid, cid, reason) {
    const p = this.me(pid);
    p.discard.push(cid);
    this.fireCard(pid, cid, 'onDiscard');
    if (reason) this.log(`${p.name} 的 ${CARDS[cid] ? CARDS[cid].name : cid} 进入弃牌区（${reason}）。`);
  }

  // 触发“某张卡”的效果（没有实体单位时用，例如它已经在阵亡区/弃牌区了）
  fireCard(pid, cid, hook, ctx) {
    const def = CARDS[cid];
    if (!def || !def.effects || !def.effects[hook]) return;
    if (this._firing) return; // 防止连锁递归
    this._firing = true;
    try {
      def.effects[hook].forEach((e) => {
        this.applyEffect(pid, { owner: pid, name: def.name, cardId: cid, level: def.level }, e, ctx || {});
      });
    } finally {
      this._firing = false;
    }
  }

  killUnit(unit, toGrave) {
    if (!unit || unit.dead) return;
    const p = this.me(unit.owner);
    const idx = p.field.findIndex((u) => u && u.uid === unit.uid);
    if (idx < 0) return;
    p.field[idx] = null;
    unit.dead = true;
    // 装备跟着主人一起走
    (unit.equip || []).forEach((e) => this.toDiscard(unit.owner, e.cid, '装备随主人阵亡'));
    unit.equip = [];
    const goGrave = toGrave && !unit.dieToDiscard;
    if (goGrave) {
      p.grave.push(unit.cardId);
      this.log(`${p.name} 的 ${unit.name} 阵亡，进入阵亡区。`);
      this.fireCard(unit.owner, unit.cardId, 'onGrave');
    } else {
      p.discard.push(unit.cardId);
      this.log(`${p.name} 的 ${unit.name} 耐久耗尽，进入弃牌区。`);
      this.fireCard(unit.owner, unit.cardId, 'onDiscard');
    }
    this.recalcAll();
  }

  sweepDead() {
    ['P1', 'P2'].forEach((pid) => {
      this.me(pid).field.forEach((u) => {
        if (u && !u.dead && u.hp <= 0) this.killUnit(u, true);
      });
    });
  }

  damageUnit(unit, amount, opts = {}) {
    if (!unit || unit.dead) return 0;
    let dmg = this.r5(amount);
    const def = (unit.kw.defense || 0) + (unit.defBonus || 0);
    if (!opts.ignoreDefense && def) dmg = Math.max(0, dmg - def);
    unit.dmg += dmg;
    unit.hp = unit.hpMax - unit.dmg;
    if (!opts.defer && unit.hp <= 0) this.killUnit(unit, true);
    return dmg;
  }

  damagePlayer(pid, amount, source) {
    const p = this.me(pid);
    p.life -= (Number(amount) || 0);
    this.log(`${p.name} 失去 ${amount} 点生命，剩余 ${p.life}。`);
    this.checkWin();
  }

  checkWin() {
    if (this.phase === 'over') return;
    const dead = ['P1', 'P2'].filter((pid) => this.players[pid].life <= 0);
    if (dead.length) {
      if (dead.length === 2) {
        this.winner = 'draw';
        this.log('双方生命同时归零，平局。');
      } else {
        this.winner = otherOf(dead[0]);
        this.log(`${this.players[this.winner].name} 获胜！`);
      }
      this.phase = 'over';
    }
  }

  /* ---------------- 回合 ---------------- */

  startPlay() {
    this.phase = 'play';
    this.turn = 0;
    this.active = this.first;
    this.beginTurn();
  }

  beginTurn() {
    const pid = this.active;
    const p = this.me(pid);
    this.turn += 1;
    if (this.soleAll && this.turn > this.soleAllUntil) this.soleAll = false;
    this.freeLevel2 = false;
    p.commandsUsedThisTurn = 0;
    p.ap = Math.max(0, this.cfg.actionPointsPerTurn + (p.nextAp || 0) - (p.apDebt || 0));
    if (p.nextAp) {
      this.log(`${p.name} 获得额外 ${p.nextAp} 点行动点。`);
      p.nextAp = 0;
    }
    if (p.apDebt) {
      this.log(`${p.name} 上回合预支了行动点，本回合少拿 ${p.apDebt} 点。`);
      p.apDebt = 0;
    }
    this.log(`——— 第 ${this.turn} 回合：${p.name} ———`);

    // 被“除外”的单位到点返回
    const due = (this.returns || []).filter((r) => r.owner === pid && this.turn >= r.turn);
    this.returns = (this.returns || []).filter((r) => !(r.owner === pid && this.turn >= r.turn));
    due.forEach((r) => {
      const slot = p.field.findIndex((u) => !u);
      if (slot < 0) {
        this.toDiscard(pid, r.cid, '除外后没有空槽可回');
        return;
      }
      const unit = this.makeUnit(r.cid, pid);
      if (r.stun) { unit.stunned = true; unit.stunTurns = 1; }
      p.field[slot] = unit;
      this.log(`${unit.name} 结束除外，回到第 ${slot + 1} 槽${r.stun ? '（等级 ≥ Ⅳ，返回时眩晕）' : ''}。`);
    });

    // 耐久结算 + 状态恢复（眩晕单位当回合不掉耐久）
    p.field.forEach((u) => {
      if (!u) return;
      if (u.suppressTurns > 0) {
        u.suppressTurns -= 1;
        if (!u.suppressTurns) u.suppress = 0;
      }
      const wasStunned = u.stunned;
      if (wasStunned) {
        u.stunTurns = Math.max(0, (u.stunTurns || 1) - 1);
        if (!u.stunTurns) u.stunned = false;
      } else {
        u.dur -= this.cfg.durabilityDecayPerTurn;
        if (u.dur <= 0) {
          this.killUnit(u, !!u.kw.wither);
          return;
        }
      }
      u.tapped = false;
      u.sick = false;
      u.attacksLeft = u.maxAttacks;
      u.attacksUsedThisTurn = 0;
    });

    this.recalcAll();

    // 回合开始效果
    p.field.forEach((u) => {
      if (u) this.fire(u, 'onTurnStart', {});
    });

    if (this.turn >= this.cfg.drawStartFromTurn) {
      this.draw(pid, this.cfg.drawPerTurn, '回合开始');
    }
  }

  endTurn(pid) {
    const p = this.me(pid);
    // 碎裂：本回合结束阵亡
    p.field.forEach((u) => {
      if (u && u.doomed) {
        this.log(`${u.name} 因“碎裂”阵亡。`);
        this.killUnit(u, true);
      }
    });
    if (this.cfg.drawPerUnusedAp && p.ap > 0) {
      const n = p.ap;
      p.ap = 0;
      this.draw(pid, n, '未使用行动点');
    }
    p.ap = 0;
    this.active = otherOf(pid);
    this.beginTurn();
  }

  /* ---------------- 效果执行 ---------------- */

  fire(unit, hook, ctx) {
    if (!unit || unit.dead) return;
    const def = CARDS[unit.cardId];
    const list = def && def.effects && def.effects[hook];
    if (!list) return;
    list.forEach((e) => this.applyEffect(unit.owner, unit, e, ctx || {}));
  }

  resolveTargets(pid, source, target, ctx, e) {
    const me = this.me(pid);
    const foe = this.foe(pid);
    switch (target) {
      case 'self': return { units: source && !source.dead && source.uid ? [source] : [] };
      case 'chosen': return { units: ctx.chosenUnit && !ctx.chosenUnit.dead ? [ctx.chosenUnit] : [] };
      case 'attackTarget': return { units: ctx.attackTarget && !ctx.attackTarget.dead ? [ctx.attackTarget] : [] };
      case 'allEnemyUnits': return { units: foe.field.filter(Boolean) };
      case 'allAllies': return { units: me.field.filter(Boolean) };
      // 己方等级 ≥ N 的单位（N 写在 e.level）
      case 'allyLevelAtLeast': return { units: me.field.filter((u) => u && u.level >= ((e && e.level) || 4)) };
      case 'enemyUnitRandom': {
        const list = foe.field.filter(Boolean);
        return { units: list.length ? [list[Math.floor(Math.random() * list.length)]] : [] };
      }
      // 己方受伤最重的单位（回血类效果用）
      case 'allyMostWounded': {
        const list = me.field.filter(Boolean);
        if (!list.length) return { units: [] };
        const worst = list.slice().sort((a, b) => (a.hpMax - a.hp) - (b.hpMax - b.hp))[list.length - 1];
        return { units: [worst] };
      }
      // 敌方等级 ≤ N 的单位
      case 'enemyPlayer': return { player: foe.id };
      case 'selfPlayer': return { player: me.id };
      default: return { units: [] };
    }
  }

  /* 条件判断：写 { cond:{...} } 的效果只在条件满足时执行 */
  checkCond(pid, source, e, ctx) {
    const c = e.cond;
    if (!c) return true;
    const p = this.me(pid);
    const all = p.field.filter(Boolean);
    if (c.sole) return this.soleAll || all.length === 1;
    if (c.minTotalUnits) {
      const total = ['P1', 'P2'].reduce((n, q) => n + this.me(q).field.filter(Boolean).length, 0);
      return total >= c.minTotalUnits;
    }
    if (c.ownAtLeast) return all.length >= c.ownAtLeast;
    if (c.hasLevelAtLeast) return all.some((u) => u.level >= c.hasLevelAtLeast);
    // “己方唯一最高等级”：自己等级严格高于其它己方单位
    if (c.soleHighest) {
      if (!source || !source.uid) return false;
      return all.length === 1 || all.every((u) => u === source || u.level < source.level);
    }
    if (c.cmdIndexAtLeast) return (ctx.cmdIndex || 1) >= c.cmdIndexAtLeast;
    if (c.apAtLeast) return this.me(pid).ap >= c.apAtLeast;
    if (c.enemyHasLevelAtLeast) {
      return this.foe(pid).field.some((u) => u && u.level >= c.enemyHasLevelAtLeast);
    }
    return true;
  }

  applyEffect(pid, source, e, ctx) {
    ctx = ctx || {};
    if (!this.checkCond(pid, source, e, ctx)) return;
    // 只在第 N 次攻击时触发的效果（例如巴麻美）
    if (e.whenAttackIndex && ctx.attackIndex !== e.whenAttackIndex) return;
    const t = this.resolveTargets(pid, source, e.target, ctx, e);
    switch (e.op) {
      case 'damage': {
        t.units.forEach((u) => {
          let v = e.value;
          if (e.woundedValue && u.hp < u.hpMax) v = e.woundedValue;
          if (e.soleValue && this.isSoleOnField(u)) v = e.soleValue;
          this.damageUnit(u, v, { ignoreDefense: true, defer: true });
        });
        this.sweepDead();
        break;
      }
      case 'damagePlayer': {
        if (e.target === 'enemyPlayer') this.damagePlayer(otherOf(pid), e.value, source);
        else this.damagePlayer(pid, e.value, source);
        break;
      }
      case 'healFull': {
        t.units.forEach((u) => { u.dmg = 0; u.hp = u.hpMax; this.log(`${u.name} 被修复。`); });
        break;
      }
      case 'healPlayer': {
        const p = this.me(pid);
        p.life += Number(e.value) || 0;
        this.log(`${p.name} 回复 ${e.value} 点生命，现有 ${p.life}。`);
        break;
      }
      // 永久加攻/加血（走 atkMod / hpMod，光环重算时不会被冲掉）
      case 'buff': {
        t.units.forEach((u) => {
          if (e.atk) { u.atkMod += this.r5(e.atk); this.log(`${u.name} 永久攻击 +${e.atk}`); }
          if (e.hp) { u.hpMod += e.hp; this.log(`${u.name} 永久血量 +${e.hp}`); }
          if (e.level) { u.level = e.level > 0 ? e.level : u.level + e.level; }
        });
        this.recalcAll();
        break;
      }
      // 按百分比加（武装色：+50%/+50%）
      case 'buffPct': {
        t.units.forEach((u) => {
          const a = this.r5(u.atk * (e.atkPct || 0) / 100);
          const h = this.r5(u.hpMax * (e.hpPct || 0) / 100);
          u.atkMod += a;
          u.hpMod += h;
          this.log(`${u.name} 攻击 +${a}、血量 +${h}（${e.atkPct}%）`);
        });
        this.recalcAll();
        break;
      }
      case 'draw': this.draw(pid, e.value, '效果'); break;
      case 'kw': {
        t.units.forEach((u) => { u.kw[e.key] = e.value; });
        break;
      }
      case 'ready': {
        t.units.forEach((u) => { u.tapped = false; u.sick = false; u.attacksLeft = 1; });
        break;
      }
      case 'discardRandom': this.discardRandom(pid, e.value); break;
      // 随机弃牌，但弃掉的牌进阵亡区（“加入墓地”）
      case 'discardToGrave': {
        const p = this.me(pid);
        for (let k = 0; k < (e.value || 1); k++) {
          if (!p.hand.length) break;
          const i = Math.floor(Math.random() * p.hand.length);
          const card = p.hand.splice(i, 1)[0];
          p.grave.push(card.cid);
          this.log(`${p.name} 将 ${CARDS[card.cid].name} 放入阵亡区。`);
        }
        break;
      }
      case 'gainAp': {
        this.me(pid).ap += Number(e.value) || 0;
        if (e.debt) this.me(pid).apDebt += Number(e.debt);
        break;
      }
      case 'stun': {
        const n = e.value || 1;
        t.units.forEach((u) => {
          u.stunned = true;
          u.stunTurns = Math.max(u.stunTurns || 0, n);
          this.log(`${u.name} 被眩晕 ${n} 回合。`);
        });
        break;
      }
      // 眩晕敌方等级 ≤ N 的单位
      case 'stunEnemyAtMost': {
        this.foe(pid).field.forEach((u) => {
          if (u && u.level <= (e.maxLevel || 2) && !(u.kw && u.kw.immuneStun)) {
            u.stunned = true;
            u.stunTurns = Math.max(u.stunTurns || 0, e.value || 1);
            this.log(`${u.name} 被眩晕。`);
          }
        });
        break;
      }
      // 压制：加攻击消耗，2 层不能攻击
      case 'suppress': {
        t.units.forEach((u) => {
          if (u.kw && u.kw.unsuppressible) { this.log(`${u.name} 无法被压制。`); return; }
          u.suppress = Math.min(2, (u.suppress || 0) + (e.value || 1));
          u.suppressTurns = 1;
          this.log(`${u.name} 被压制 ${u.suppress} 层。`);
        });
        break;
      }
      case 'bounce': {
        t.units.forEach((u) => {
          const p = this.me(u.owner);
          const idx = p.field.findIndex((x) => x && x.uid === u.uid);
          if (idx >= 0) {
            p.field[idx] = null;
            p.hand.push({ cid: u.cardId, uses: 0 });
            u.dead = true;
            this.log(`${u.name} 被返回手牌。`);
            this.recalcAll();
          }
        });
        break;
      }
      // 返回手牌 + 对手弃掉等于它等级的牌
      case 'bounceAndDiscard': {
        t.units.forEach((u) => {
          const owner = u.owner;
          const lv = u.level;
          const p = this.me(owner);
          const idx = p.field.findIndex((x) => x && x.uid === u.uid);
          if (idx < 0) return;
          p.field[idx] = null;
          p.hand.push({ cid: u.cardId, uses: 0 });
          u.dead = true;
          this.log(`${u.name} 被返回手牌。`);
          this.discardRandom(owner, lv, '被返回手牌');
          this.recalcAll();
        });
        break;
      }
      case 'discardOpponent': this.discardRandom(otherOf(pid), e.value, '指令'); break;
      case 'destroy': {
        t.units.forEach((u) => this.killUnit(u, true));
        break;
      }
      // 除外：下个回合开始时回到原槽位（结城友奈）
      case 'exileReturn': {
        let target = t.units[0];
        if (!target) {
          const list = this.foe(pid).field.filter(Boolean);
          target = list.length ? list[Math.floor(Math.random() * list.length)] : null;
        }
        if (!target) break;
        const fp = this.me(target.owner);
        const slot = fp.field.findIndex((x) => x === target);
        if (slot < 0) break;
        fp.field[slot] = null;
        target.dead = true;
        this.returns = this.returns || [];
        this.returns.push({ owner: target.owner, cid: target.cardId, slot, turn: this.turn + 1, stun: target.level >= 4 });
        this.log(`${target.name} 被除外，将在其主人下个回合开始时返回。`);
        this.recalcAll();
        break;
      }
      // 生成一张衍生物到手牌（慈）
      case 'addToken': {
        for (let k = 0; k < (e.value || 1); k++) {
          this.me(pid).hand.push({ cid: e.cid, uses: 0 });
        }
        this.log(`${this.me(pid).name} 获得 ${CARDS[e.cid] ? CARDS[e.cid].name : e.cid}。`);
        break;
      }
      // 本回合与下回合所有单位都视为“唯一单位”
      case 'soleAll': {
        this.soleAll = true;
        this.soleAllUntil = this.turn + 1;
        break;
      }
      // 双方场上所有单位进弃牌区，各自抽等于“自己失去数量”的牌（魔女之夜）
      case 'clearFieldDraw': {
        ['P1', 'P2'].forEach((q) => {
          const qp = this.me(q);
          const n = qp.field.filter(Boolean).length;
          qp.field.forEach((u) => {
            if (u) {
              qp.discard.push(u.cardId);
              u.dead = true;
              this.fireCard(q, u.cardId, 'onDiscard');
            }
          });
          qp.field = new Array(this.cfg.fieldSlots).fill(null);
          this.log(`${qp.name} 场上 ${n} 个单位进入弃牌区。`);
          if (n) this.draw(q, n, '魔女之夜');
        });
        this.recalcAll();
        break;
      }
      // 立即攻击一次，回合结束阵亡（碎裂）
      case 'doomedAttack': {
        t.units.forEach((u) => {
          u.tapped = false;
          u.sick = false;
          u.attacksLeft = 1;
          u.doomed = true;
          this.log(`${u.name} 获得一次额外攻击，本回合结束时阵亡。`);
        });
        break;
      }
      // 把对手 1 张手牌放回其牌库底（见闻色）
      case 'handToDeckBottom': {
        const fp = this.foe(pid);
        if (!fp.hand.length) break;
        const i = Math.floor(Math.random() * fp.hand.length);
        const card = fp.hand.splice(i, 1)[0];
        fp.deck.unshift(card.cid);
        this.log(`${fp.name} 的 1 张手牌被放回牌库底（${CARDS[card.cid].name}）。`);
        break;
      }
      // 下回合额外获得行动点（下北泽的暑假）
      case 'nextTurnAp': {
        const p = this.me(pid);
        p.nextAp = (p.nextAp || 0) + (Number(e.value) || 0);
        break;
      }
      // 压制双方场上等级最高的单位（完全压制）
      case 'suppressAllHighest': {
        ['P1', 'P2'].forEach((q) => {
          const list = this.me(q).field.filter(Boolean);
          if (!list.length) return;
          const maxLv = Math.max(...list.map((u) => u.level));
          list.filter((u) => u.level === maxLv).forEach((u) => {
            if (u.kw && u.kw.unsuppressible) return;
            u.suppress = 2;
            u.suppressTurns = 2;
            this.log(`${u.name} 被完全压制。`);
          });
        });
        break;
      }
      // 本回合 Ⅱ 级单位部署/攻击不消耗行动点（贝斯笑话）
      case 'freeLevel2': {
        this.freeLevel2 = true;
        this.log('本回合 Ⅱ 级单位的部署与攻击不消耗行动点。');
        break;
      }
      // 压制对方血最少的单位，若它比源头血少则再压制一个（虹夏）
      case 'suppressWeak': {
        const list = this.foe(pid).field.filter(Boolean).sort((a, b) => a.hp - b.hp);
        if (!list.length) break;
        const one = list[0];
        if (!(one.kw && one.kw.unsuppressible)) {
          one.suppress = Math.min(2, (one.suppress || 0) + 1);
          one.suppressTurns = 1;
          this.log(`${one.name} 被压制。`);
        }
        const selfHp = source && source.uid ? source.hp : 999;
        const inspector = source && source.uid ? source : null;
        if (one.hp < selfHp && list[1] && !(list[1].kw && list[1].kw.unsuppressible)) {
          list[1].suppress = Math.min(2, (list[1].suppress || 0) + 1);
          list[1].suppressTurns = 1;
          this.log(`${list[1].name} 血量更低，再被压制。`);
        }
        if (inspector) { /* 仅为可读性 */ }
        break;
      }
      // 消灭对方 1 个等级 ≤ N 的单位（东乡美森）
      case 'destroyLowEnemy': {
        const list = this.foe(pid).field.filter((u) => u && u.level <= (e.maxLevel || 2));
        if (!list.length) { this.log('敌方没有符合条件的单位。'); break; }
        const one = list[Math.floor(Math.random() * list.length)];
        this.log(`${one.name} 被消灭。`);
        this.killUnit(one, true);
        break;
      }
      // 眩晕敌方全体
      case 'stunEnemyAll': {
        this.foe(pid).field.forEach((u) => {
          if (!u || (u.kw && u.kw.immuneStun)) return;
          u.stunned = true;
          u.stunTurns = Math.max(u.stunTurns || 0, e.value || 1);
          this.log(`${u.name} 被眩晕 ${e.value || 1} 回合。`);
        });
        break;
      }
      // 加耐久
      case 'durPlus': {
        t.units.forEach((u) => { u.dur += Number(e.value) || 0; this.log(`${u.name} 耐久 +${e.value}`); });
        break;
      }
      // 自己眩晕（广井菊里：攻击后眩晕自身）
      case 'stunSelf': {
        t.units.forEach((u) => {
          u.stunned = true;
          u.stunTurns = Math.max(u.stunTurns || 0, e.value || 1);
          this.log(`${u.name} 攻击后眩晕自身。`);
        });
        break;
      }
      // 按目标等级给玩家回血（碎裂）
      case 'healPlayerByLevel': {
        const p = this.me(pid);
        const total = t.units.reduce((n, u) => n + (u.level || 0), 0) * (e.value || 1);
        if (total > 0) {
          p.life += total;
          this.log(`${p.name} 回复 ${total} 点生命，现有 ${p.life}。`);
        }
        break;
      }
      default:
        this.log(`（未实现的效果类型：${e.op}）`);
    }
  }

  /* ---------------- 行动 ---------------- */

  action(pid, a) {
    if (!a || typeof a !== 'object') return { ok: false, error: '无效操作' };
    try {
      if (this.phase === 'over') return { ok: false, error: '对局已结束' };

      if (a.type === 'mulligan') return this.doMulligan(pid, a);

      if (this.phase !== 'play') return { ok: false, error: '对局尚未开始' };
      if (pid !== this.active) return { ok: false, error: '还没轮到你' };

      switch (a.type) {
        case 'deploy': return this.doDeploy(pid, a);
        case 'upgrade': return this.doUpgrade(pid, a);
        case 'equip': return this.doEquip(pid, a);
        case 'attack': return this.doAttack(pid, a);
        case 'command': return this.doCommand(pid, a);
        case 'deathrattle': return this.doDeathrattle(pid, a);
        case 'endTurn': this.endTurn(pid); return { ok: true };
        default: return { ok: false, error: '未知操作' };
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  doMulligan(pid, a) {
    if (this.phase !== 'mulligan') return { ok: false, error: '现在不能换牌' };
    const p = this.me(pid);
    if (p.mullDone) return { ok: false, error: '已经换过牌了' };
    const cfg = this.cfg;
    if (!cfg.mulliganEnabled) {
      p.mullDone = true;
      this.tryStart();
      return { ok: true };
    }
    const back = Array.isArray(a.cards) ? a.cards.slice() : [];
    const uniq = [...new Set(back.map(Number))];
    uniq.forEach((i) => {
      if (!(i >= 0 && i < p.hand.length)) fail('换牌选择不合法');
    });
    uniq.forEach((i) => {
      const card = p.hand[i];
      if (card) p.discard.push(card.cid);
    });
    p.hand = p.hand.filter((c, i) => !uniq.includes(i));
    this.draw(pid, uniq.length, '换牌');
    p.mullDone = true;
    this.log(`${p.name} 换掉 ${uniq.length} 张牌。`);
    this.tryStart();
    return { ok: true };
  }

  tryStart() {
    if (this.players.P1.mullDone && this.players.P2.mullDone) this.startPlay();
  }

  payAp(p, cost) {
    if (p.ap < cost) fail(`行动点不足（需要 ${cost}，现有 ${p.ap}）`);
    p.ap -= cost;
  }

  doDeploy(pid, a) {
    const p = this.me(pid);
    const i = Number(a.hand);
    const slot = Number(a.slot);
    const card = p.hand[i];
    if (!card) fail('手牌不存在');
    const def = CARDS[card.cid];
    if (def.type !== 'unit') fail('指令牌不能部署');
    if (def.level !== 1) fail('只有 Ⅰ 级单位可以直接部署，Ⅱ 级及以上要升变');
    if (!(slot >= 0 && slot < p.field.length)) fail('部署位置不合法');
    if (p.field[slot]) fail('这个部署槽已有单位');
    let cost = def.kw && def.kw.immediate ? 0 : this.cfg.deployCost;
    if (this.freeLevel2 && def.level === 2) cost = 0;
    this.payAp(p, cost);
    p.hand.splice(i, 1);
    const unit = this.makeUnit(card.cid, pid);
    p.field[slot] = unit;
    this.log(`${p.name} 部署 ${def.name} 到第 ${slot + 1} 槽。`);
    this.recalcAll();
    this.fire(unit, 'onDeploy', {});
    this.sweepDead();
    return { ok: true };
  }

  matchRecipe(level, materials) {
    const recipes = this.cfg.upgradeRecipes[level] || [];
    const got = materials.map((u) => u.level).sort();
    return recipes.find((rec) => {
      const need = [];
      Object.keys(rec).forEach((lv) => {
        for (let k = 0; k < rec[lv]; k++) need.push(Number(lv));
      });
      need.sort();
      return need.length === got.length && need.every((v, idx) => v === got[idx]);
    }) || null;
  }

  doUpgrade(pid, a) {
    const p = this.me(pid);
    const i = Number(a.hand);
    const card = p.hand[i];
    if (!card) fail('手牌不存在');
    const def = CARDS[card.cid];
    if (def.type !== 'unit') fail('指令牌不能升变');
    if (def.level <= 1) fail('只有 Ⅱ 级及以上单位需要升变');

    const uids = (a.materials || []).map(String);
    if (!uids.length) fail('没有选择升变材料');
    const mats = uids.map((uid) => {
      const u = this.owUnit(pid, uid);
      if (!u) fail('升变材料不在己方场上');
      return u;
    });
    if (new Set(mats.map((u) => u.uid)).size !== mats.length) fail('材料重复');
    if (mats.some((u) => u.stunned)) fail('眩晕单位无法升变');
    if (mats.some((u) => u.pressure >= 2)) fail('逼制 2 层，无法升变');

    const rec = this.matchRecipe(def.level, mats);
    if (!rec) fail('材料等级不满足升变配方');

    const extra = Math.max(0, ...mats.map((u) => u.pressure || 0));
    this.payAp(p, this.cfg.upgradeCost + extra);

    const slot = p.field.findIndex((u) => u && u.uid === mats[0].uid);
    if (slot < 0) fail('材料位置异常');
    const matNames = mats.map((u) => u.name).join(' + ');
    const inherited = [];
    mats.forEach((u) => {
      const idx = p.field.findIndex((x) => x && x.uid === u.uid);
      if (idx >= 0) {
        p.field[idx] = null;
        u.dead = true;
        u.equip.forEach((e) => inherited.push(e)); // 装备跟着新单位走
        this.toDiscard(pid, u.cardId, '升变材料');
      }
    });
    p.hand.splice(i, 1);
    const unit = this.makeUnit(card.cid, pid);
    unit.equip = inherited;
    p.field[slot] = unit;
    this.recalcAll();
    this.log(`${p.name} 以 ${matNames} 升变出 ${def.name}（第 ${slot + 1} 槽）${inherited.length ? '，继承装备 ' + inherited.length + ' 件' : ''}。`);
    this.fire(unit, 'onDeploy', {});
    this.sweepDead();
    return { ok: true };
  }

  /* 装备：把手牌里的“装备型”单位挂到己方 Ⅱ 级及以上单位身上 */
  doEquip(pid, a) {
    const p = this.me(pid);
    const i = Number(a.hand);
    const card = p.hand[i];
    if (!card) fail('手牌不存在');
    const def = CARDS[card.cid];
    if (def.type !== 'unit') fail('指令牌不能装备');
    if (!(def.kw && def.kw.equip)) fail('这张牌不能装备');
    const host = this.owUnit(pid, String(a.uid));
    if (!host) fail('装备目标不在己方场上');
    if (host.level < (def.kw.equipMinLevel || 2)) fail('装备目标等级不够（需要 ' + (def.kw.equipMinLevel || 2) + ' 级及以上）');
    this.payAp(p, this.cfg.equipCost == null ? 1 : this.cfg.equipCost);
    p.hand.splice(i, 1);
    host.equip.push({ cid: card.cid, atk: def.atk || 0, hp: def.hp || 0 });
    this.recalcAll();
    this.log(`${p.name} 把 ${def.name} 装备到 ${host.name}（+${def.atk || 0}/+${def.hp || 0}）。`);
    return { ok: true };
  }

  targetable(pid, unit) {
    if (!unit || unit.dead) return false;
    if (!unit.kw.stealth) return true;
    const own = this.me(unit.owner).field.filter(Boolean);
    return !own.some((u) => u !== unit && !u.kw.stealth);
  }

  doAttack(pid, a) {
    const p = this.me(pid);
    const foe = this.foe(pid);
    const atk = this.owUnit(pid, String(a.uid));
    if (!atk) fail('攻击单位不存在');
    if (atk.attacksLeft <= 0) fail('该单位本回合已经行动完了');
    if (atk.stunned) fail('眩晕单位无法攻击');
    if (atk.sick && !(atk.kw && atk.kw.swift)) fail('部署当回合不能攻击（需要“迅捷”）');
    if (atk.suppress >= 2) fail('压制 2 层，无法攻击');

    let cost = atk.kw && atk.kw.immediate ? 0 : this.cfg.attackCost + (atk.suppress || 0);
    if (this.freeLevel2 && atk.level === 2) cost = 0;

    // 先校验目标，再扣行动点，避免非法操作消耗资源
    const tgt = a.target || {};
    let def = null;
    if (tgt.kind === 'player') {
      if (foe.field.some(Boolean) && this.cfg.playerAttackRequiresEmptyField) {
        fail('敌方场上还有单位，不能攻击玩家');
      }
    } else {
      def = this.foeUnit(pid, String(tgt.uid));
      if (!def) fail('目标单位不存在');
      if (!this.targetable(pid, def)) fail('该单位处于隐匿状态，无法被攻击');
    }

    this.payAp(p, cost);
    atk.attacksLeft -= 1;
    atk.attacksUsedThisTurn += 1;
    atk.tapped = atk.attacksLeft <= 0;
    const attackIndex = atk.attacksUsedThisTurn;
    const actx = { attackIndex };

    if (tgt.kind === 'player') {
      this.log(`${atk.name} 攻击 ${foe.name}，造成 ${atk.level} 点生命伤害。`);
      this.damagePlayer(foe.id, atk.level, atk);
      this.draw(foe.id, this.cfg.drawWhenAttacked, '被攻击');
      this.fire(atk, 'onAttack', actx);
      this.sweepDead();
      return { ok: true };
    }
    const woundedBefore = def.hp < def.hpMax;
    this.log(`${atk.name}（攻 ${atk.atk}）攻击 ${def.name}（血 ${def.hp}）。`);

    // 基础伤害
    this.damageUnit(def, atk.atk, { defer: true });

    // 冲击 / 追击：决定是否触发 onAttack 效果
    const def_card = CARDS[atk.cardId];
    const hasOnAttack = !!(def_card.effects && def_card.effects.onAttack);
    let fireOnAttack = hasOnAttack;
    if (hasOnAttack && atk.kw.impact) {
      if (atk.impactUsed) fireOnAttack = false;
      else atk.impactUsed = true;
    }
    if (hasOnAttack && atk.kw.pursuit && !woundedBefore) fireOnAttack = false;
    if (fireOnAttack) this.fire(atk, 'onAttack', { attackTarget: def, attackIndex });

    // 群攻 / 弹射：对其它敌方单位溅射
    if (atk.kw.cleave) {
      foe.field.forEach((u) => {
        if (u && u !== def) this.damageUnit(u, atk.atk, { defer: true });
      });
      this.log(`${atk.name} 触发群攻。`);
    }
    if (atk.kw.ricochet) {
      const count = Math.max(1, foe.field.filter(Boolean).length);
      const per = Math.ceil(atk.atk / count / this.cfg.roundStep) * this.cfg.roundStep;
      foe.field.forEach((u) => {
        if (u && u !== def) this.damageUnit(u, per, { defer: true });
      });
      this.log(`${atk.name} 触发弹射，每个其它敌方单位受到 ${per}。`);
    }

    // 反击
    if (def.kw.counter && !def.dead) {
      this.damageUnit(atk, def.kw.counter, { ignoreDefense: true, defer: true });
      this.log(`${def.name} 反击 ${atk.name} ${def.kw.counter}。`);
    }

    this.sweepDead();
    return { ok: true };
  }

  doCommand(pid, a) {
    const p = this.me(pid);
    const i = Number(a.hand);
    const card = p.hand[i];
    if (!card) fail('手牌不存在');
    const def = CARDS[card.cid];
    if (def.type !== 'command') fail('这不是指令牌');

    // 指令自己写的使用条件（例如“仅当 Ⅳ 级及以上单位在场时可用”）
    if (def.require && def.require.ownHasLevelAtLeast) {
      if (!p.field.some((u) => u && u.level >= def.require.ownHasLevelAtLeast)) {
        fail(`需要己方有 ${def.require.ownHasLevelAtLeast} 级及以上单位在场才能使用`);
      }
    }

    let chosenUnit = null;
    const tgt = a.target || {};
    if (def.target === 'enemyUnit' || def.target === 'unit') {
      if (tgt.side === 'ally' && def.target === 'unit') {
        chosenUnit = this.owUnit(pid, String(tgt.uid));
      } else {
        chosenUnit = this.foeUnit(pid, String(tgt.uid));
      }
      if (!chosenUnit) fail('需要选择一个单位');
      if (chosenUnit.owner !== pid) {
        if (!this.targetable(pid, chosenUnit)) fail('该单位处于隐匿状态');
        if (chosenUnit.kw && chosenUnit.kw.immuneCmd) fail(`${chosenUnit.name} 不受敌方指令影响`);
      }
    } else if (def.target === 'allyUnit') {
      chosenUnit = this.owUnit(pid, String(tgt.uid));
      if (!chosenUnit) fail('需要选择一个己方单位');
    }

    let cost = def.cost || 0;
    // 动态费用：例如霸王色，场上有 Ⅴ 级时只花 1 点
    if (def.costIf && def.costIf.level && p.field.some((u) => u && u.level >= def.costIf.level)) {
      cost = def.costIf.cost;
    }
    if (def.kw && def.kw.immediate) cost = 0;
    // “每回合第 2 张指令 -1 消耗”（若狭悠里），不叠加
    const hasDiscount = p.field.some((u) => u && u.cmdDiscount);
    if (hasDiscount && p.commandsUsedThisTurn >= 1) cost = Math.max(0, cost - 1);
    this.payAp(p, cost);

    const cmdIndex = p.commandsUsedThisTurn + 1;
    const inst = p.hand.splice(i, 1)[0];
    p.commandsUsedThisTurn += 1;
    this.log(`${p.name} 使用指令 ${def.name}（第 ${cmdIndex} 张）。`);
    def.effects.forEach((e) => this.applyEffect(pid, chosenUnit, e, { chosenUnit, cmdIndex }));
    this.sweepDead();

    inst.uses += 1;
    const used = (p.commandUses[inst.cid] = (p.commandUses[inst.cid] || 0) + 1);
    if (used >= this.cfg.commandUsesBeforeExile) {
      p.exile.push(inst.cid);
      this.log(`${def.name} 第 ${used} 次使用，除外。`);
    } else {
      p.discard.push(inst.cid);
    }
    return { ok: true };
  }

  doDeathrattle(pid, a) {
    const p = this.me(pid);
    const i = Number(a.grave);
    const cid = p.grave[i];
    if (!cid) fail('阵亡区没有这张牌');
    const def = CARDS[cid];
    if (!def.effects || !def.effects.onDeath) fail('这张牌没有亡计');
    p.grave.splice(i, 1);
    this.log(`${p.name} 发动亡计：${def.name}。`);
    def.effects.onDeath.forEach((e) => {
      this.applyEffect(pid, { owner: pid, name: def.name }, e, {});
    });
    this.sweepDead();
    p.exile.push(cid);
    this.log(`${def.name} 发动后除外。`);
    return { ok: true };
  }

  /* ---------------- 视角 ---------------- */

  unitView(u) {
    if (!u) return null;
    return {
      uid: u.uid, cardId: u.cardId, name: u.name, owner: u.owner,
      level: u.level, atk: u.atk, hp: u.hp, hpMax: u.hpMax,
      dur: u.dur, kw: u.kw, tapped: u.tapped, sick: u.sick,
      stunned: u.stunned, suppress: u.suppress, pressure: u.pressure,
      attacksLeft: u.attacksLeft, maxAttacks: u.maxAttacks,
      equipCount: (u.equip || []).length, info: u.info || null
    };
  }

  playerView(p, own) {
    return {
      id: p.id,
      name: p.name,
      deckId: p.deckId,
      life: p.life,
      ap: p.ap,
      deckCount: p.deck.length,
      handCount: p.hand.length,
      hand: own ? p.hand.map((c) => ({ cid: c.cid, uses: c.uses })) : null,
      field: p.field.map((u) => this.unitView(u)),
      discard: p.discard.slice(),
      grave: p.grave.slice(),
      exile: p.exile.slice(),
      mullDone: p.mullDone
    };
  }

  view(pid) {
    return {
      phase: this.phase,
      turn: this.turn,
      active: this.active,
      yourTurn: this.active === pid,
      first: this.first,
      winner: this.winner,
      slots: this.cfg.fieldSlots,
      freeLevel2: !!this.freeLevel2,
      soleAll: !!this.soleAll,
      me: this.playerView(this.me(pid), true),
      foe: this.playerView(this.foe(pid), false),
      log: this.logs.slice(-14)
    };
  }

  /* 观战视角：两家手牌都不公开，其余信息与牌桌上的公开信息一致 */
  specView() {
    const v = this.view('P1');
    v.me.hand = null;
    v.yourTurn = false;
    v.spectator = true;
    return v;
  }
}

module.exports = { Game, CARDS, DECKS: DB.decks, KW_TEXT: DB.KW_TEXT };
