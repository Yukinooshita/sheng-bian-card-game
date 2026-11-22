'use strict';
/**
 * 引擎自测：让两个“机器人”自动打完一局，检查会不会崩、会不会出非法状态。
 * 用法： node test/sim.js [局数]
 */
const { Game, DECKS } = require('../engine/engine');
const CARDS = require('../engine/cards').cards;

function pickDeck(id) { return DECKS.find((d) => d.id === id) || DECKS[0]; }

function chosenCard(game, pid, def) {
  if (def.target === 'enemyUnit' || def.target === 'unit') {
    const list = game.foe(pid).field.filter(Boolean).filter((u) => game.targetable(pid, u));
    return list[0] ? { kind: 'unit', uid: list[0].uid } : null;
  }
  if (def.target === 'allyUnit') {
    const list = game.me(pid).field.filter(Boolean);
    return list[0] ? { kind: 'unit', uid: list[0].uid } : null;
  }
  return null;
}

function playTurn(game, pid) {
  const cfg = game.cfg;
  let guard = 0;
  while (guard++ < 40 && game.phase === 'play' && game.active === pid) {
    const me = game.me(pid);
    const foe = game.foe(pid);
    let acted = false;

    // 1. 有行动点就先用指令
    if (me.ap >= 1) {
      for (let i = 0; i < me.hand.length; i++) {
        const def = CARDS[me.hand[i].cid];
        if (def.type !== 'command' || (def.cost || 0) > me.ap) continue;
        const t = def.target ? chosenCard(game, pid, def) : { ok: true };
        if (def.target && !t) continue;
        const r = game.action(pid, { type: 'command', hand: i, target: t || {} });
        if (r.ok) { acted = true; break; }
      }
    }
    if (acted) continue;

    // 2. 直接部署 Ⅰ 级（装备型单位优先进攻装备）
    if (me.ap >= cfg.deployCost) {
      // 先试装备
      const eq = me.hand.findIndex((c) => CARDS[c.cid].kw && CARDS[c.cid].kw.equip);
      if (eq >= 0) {
        const host = me.field.filter(Boolean).find((u) => u.level >= 2);
        if (host) {
          const r = game.action(pid, { type: 'equip', hand: eq, uid: host.uid });
          if (r.ok) continue;
        }
      }
      const slot = me.field.findIndex((u) => !u);
      if (slot >= 0) {
        const i = me.hand.findIndex((c) => CARDS[c.cid].type === 'unit' && CARDS[c.cid].level === 1);
        if (i >= 0) {
          const r = game.action(pid, { type: 'deploy', hand: i, slot });
          if (r.ok) continue;
        }
      }
    }

    // 3. 升变
    if (me.ap >= cfg.upgradeCost) {
      for (let i = 0; i < me.hand.length; i++) {
        const def = CARDS[me.hand[i].cid];
        if (def.type !== 'unit' || def.level < 2) continue;
        const uids = me.field.filter(Boolean).map((u) => u.uid);
        const combos = [];
        const pick = (start, cur) => {
          if (cur.length) combos.push(cur.slice());
          if (cur.length >= 3) return;
          for (let k = start; k < uids.length; k++) {
            cur.push(uids[k]);
            pick(k + 1, cur);
            cur.pop();
          }
        };
        pick(0, []);
        for (const combo of combos) {
          const r = game.action(pid, { type: 'upgrade', hand: i, materials: combo });
          if (r.ok) { acted = true; break; }
        }
        if (acted) break;
      }
      if (acted) continue;
    }

    // 4. 攻击
    const attacker = me.field.filter(Boolean).find((u) => (u.attacksLeft || 0) > 0 && !u.sick && !u.stunned && u.suppress < 2);
    if (attacker && me.ap >= cfg.attackCost) {
      const targets = foe.field.filter(Boolean).filter((u) => game.targetable(pid, u));
      if (targets.length) {
        const r = game.action(pid, { type: 'attack', uid: attacker.uid, target: { kind: 'unit', uid: targets[0].uid } });
        if (r.ok) continue;
      } else if (me.ap >= cfg.attackCost) {
        const r = game.action(pid, { type: 'attack', uid: attacker.uid, target: { kind: 'player' } });
        if (r.ok) continue;
      }
    }

    // 5. 亡计
    const graveIdx = me.grave.findIndex((cid) => CARDS[cid].effects && CARDS[cid].effects.onDeath);
    if (graveIdx >= 0) {
      const r = game.action(pid, { type: 'deathrattle', grave: graveIdx });
      if (r.ok) continue;
    }

    if (!acted) break;
  }
  if (game.phase === 'play' && game.active === pid) game.action(pid, { type: 'endTurn' });
}

function checkState(game) {
  ['P1', 'P2'].forEach((pid) => {
    const p = game.players[pid];
    if (p.field.length !== game.cfg.fieldSlots) throw new Error('部署槽数量异常');
    const uids = p.field.filter(Boolean).map((u) => u.uid);
    if (new Set(uids).size !== uids.length) throw new Error('场上单位 uid 重复');
    p.field.filter(Boolean).forEach((u) => {
      if (u.dead) throw new Error('阵亡单位仍在场');
      if (u.hp <= 0) throw new Error('血量<=0 的单位仍在场：' + u.name);
    });
  });
}

function runGame(seed) {
  const pool = DECKS.map((d) => d.id);
  const g = new Game({
    p1: 'BOT-A',
    p2: 'BOT-B',
    deckP1: pickDeck(pool[seed % pool.length]),
    deckP2: pickDeck(pool[(seed + 3) % pool.length])
  });
  // 换掉手里所有的牌，测试换牌流程
  g.action('P1', { type: 'mulligan', cards: [] });
  g.action('P2', { type: 'mulligan', cards: [0] });
  let turns = 0;
  const MAX_TURNS = 200;
  while (g.phase === 'play' && turns < MAX_TURNS) {
    playTurn(g, g.active);
    checkState(g);
    turns++;
  }
  if (g.phase === 'play') g.action(g.active, { type: 'endTurn' });
  return { over: g.phase === 'over', turns, winner: g.winner };
}

const N = Number(process.argv[2] || 300);
let done = 0;
let over = 0;
let turnSum = 0;
let turnMax = 0;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  try {
    const r = runGame(i);
    done++;
    if (r.over) { over++; turnSum += r.turns; turnMax = Math.max(turnMax, r.turns); }
  } catch (e) {
    console.error('第 ' + i + ' 局出错：', e.message);
    console.error(e.stack.split('\n').slice(0, 6).join('\n'));
    process.exit(1);
  }
}
console.log(`✅ ${done}/${N} 局跑完，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`分出胜负 ${over} 局（${((over / done) * 100).toFixed(0)}%），平均 ${over ? (turnSum / over).toFixed(1) : '-'} 回合，最长 ${turnMax} 回合`);

// 打印一局样本日志，便于人工核对规则
const sample = new Game({ p1: '示例A', p2: '示例B', deckP1: DECKS[0], deckP2: DECKS[1] });
sample.action('P1', { type: 'mulligan', cards: [] });
sample.action('P2', { type: 'mulligan', cards: [] });
for (let i = 0; i < 24 && sample.phase === 'play'; i++) playTurn(sample, sample.active);
console.log('\n===== 样本对局日志（前 30 条） =====');
sample.logs.slice(0, 30).forEach((l) => console.log(l.text));
console.log(`\n结局：${sample.phase}${sample.winner ? ' / 胜者 ' + sample.winner : ''}`);
['P1', 'P2'].forEach((pid) => {
  const p = sample.players[pid];
  console.log(`${p.name}: 生命 ${p.life}，牌库 ${p.deck.length}，弃牌 ${p.discard.length}，阵亡 ${p.grave.length}，除外 ${p.exile.length}，场上 ${p.field.filter(Boolean).length}`);
});
