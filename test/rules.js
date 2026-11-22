'use strict';
/**
 * 规则单元测试：把关键判定固定下来，改规则后跑一遍就知道有没有踩坏。
 * 用法： node test/rules.js
 */
const assert = require('assert');
const { Game, DECKS } = require('../engine/engine');
const CARDS = require('../engine/cards').cards;

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

function fresh(config) {
  const g = new Game({ p1: 'A', p2: 'B', deckP1: DECKS[0], deckP2: DECKS[1], config: config || {} });
  g.action('P1', { type: 'mulligan', cards: [] });
  g.action('P2', { type: 'mulligan', cards: [] });
  g.players.P1.hand = [];
  g.players.P2.hand = [];
  g.players.P1.field = new Array(g.cfg.fieldSlots).fill(null);
  g.players.P2.field = new Array(g.cfg.fieldSlots).fill(null);
  g.players.P1.ap = 3;
  g.active = 'P1'; // 测试里固定由 P1 行动
  return g;
}

function give(g, pid, cid, slot, extra) {
  const unit = g.makeUnit(cid, pid);
  Object.assign(unit, extra || {});
  g.players[pid].field[slot] = unit;
  return unit;
}

function putHand(g, pid, cid, uses) {
  g.players[pid].hand.push({ cid, uses: uses || 0 });
  return g.players[pid].hand.length - 1;
}

/* 1. 直接部署：只允许 Ⅰ 级、消耗 1 行动点、当回合不能攻击 */
{
  const g = fresh();
  const i = putHand(g, 'P1', 'u_yan_1');
  let r = g.action('P1', { type: 'deploy', hand: i, slot: 0 });
  ok(r.ok, 'Ⅰ 级可以直接部署：' + r.error);
  ok(g.players.P1.ap === 2, '部署消耗 1 行动点');
  ok(g.players.P1.field[0].sick === true, '部署当回合有部署疲劳');

  const g2 = fresh();
  const j = putHand(g2, 'P1', 'u_yan_4');
  r = g2.action('P1', { type: 'deploy', hand: j, slot: 0 });
  ok(!r.ok, 'Ⅱ 级不能直接部署');
}

/* 2. 升变：Ⅰ×2 => Ⅲ，材料进弃牌区，新单位同槽，消耗 1 点 */
{
  const g = fresh();
  give(g, 'P1', 'u_yan_1', 0, { sick: false });
  give(g, 'P1', 'u_yan_1', 1, { sick: false });
  const i = putHand(g, 'P1', 'u_yan_5');
  const mats = [g.players.P1.field[0].uid, g.players.P1.field[1].uid];
  const r = g.action('P1', { type: 'upgrade', hand: i, materials: mats });
  ok(r.ok, 'Ⅰ×2 升变 Ⅲ 应成功：' + r.error);
  ok(g.players.P1.field[0].cardId === 'u_yan_5', '升变结果在材料所在槽');
  ok(g.players.P1.field[1] === null, '材料被消耗');
  ok(g.players.P1.discard.length === 2, '两张材料进入弃牌区');
  ok(g.players.P1.ap === 2, '升变消耗 1 行动点');
}

/* 3. 攻击玩家：敌场有单位时禁止；清空后造成“等级”点生命伤害，且被攻击方抽牌 */
{
  const g = fresh();
  give(g, 'P1', 'u_yan_2', 0, { sick: false, atk: 10 });
  give(g, 'P2', 'u_yan_1', 0, { sick: false });
  let r = g.action('P1', { type: 'attack', uid: g.players.P1.field[0].uid, target: { kind: 'player' } });
  ok(!r.ok, '敌方有单位时不能攻击玩家');

  g.players.P2.field[0] = null;
  const lifeBefore = g.players.P2.life;
  const handBefore = g.players.P2.hand.length;
  r = g.action('P1', { type: 'attack', uid: g.players.P1.field[0].uid, target: { kind: 'player' } });
  ok(r.ok, '空场可以攻击玩家：' + r.error);
  ok(g.players.P2.life === lifeBefore - 1, 'Ⅰ 级单位攻击玩家造成 1 点生命伤害');
  ok(g.players.P2.hand.length === handBefore + 1, '玩家被攻击时抽 1 张');
  ok(g.players.P1.ap === 2, '攻击消耗 1 点');
  ok(g.players.P1.field[0].tapped === true, '攻击后单位转为已行动');
}

/* 4. 防御、反击、冲击 */
{
  const g = fresh();
  const atk = give(g, 'P1', 'u_yan_2', 0, { sick: false });
  const def = give(g, 'P2', 'u_sen_3', 0, { sick: false }); // 5/20 防御5
  const r = g.action('P1', { type: 'attack', uid: atk.uid, target: { kind: 'unit', uid: def.uid } });
  ok(r.ok, '攻击应成功：' + r.error);
  // 10 攻击 - 防御 5 = 5，再加“冲击”额外 5 = 共 10，血量 20→10
  ok(def.hp === 10, '防御 5 生效，且冲击额外 5 伤害，血量 20→10，实为 ' + def.hp);

  const g2 = fresh();
  const a2 = give(g2, 'P1', 'u_yan_2', 0, { sick: false });
  const d2 = give(g2, 'P2', 'u_sen_4', 0, { sick: false }); // 10/20 反击5
  g2.action('P1', { type: 'attack', uid: a2.uid, target: { kind: 'unit', uid: d2.uid } });
  ok(a2.hp === 0 || a2.dead, '反击 5 应让 5 血的火舌兵阵亡');
}

/* 5. 耐久：回合开始 -1，归零进弃牌区；凋亡进阵亡区 */
{
  const g = fresh({ defaultDurability: 3 });
  const u = give(g, 'P1', 'u_yan_1', 0, { dur: 1, sick: false });
  g.action('P1', { type: 'endTurn' }); // 交给 P2
  g.action('P2', { type: 'endTurn' }); // 回到 P1，回合开始结算耐久
  ok(g.players.P1.field[0] === null, '耐久归零后离场');
  ok(g.players.P1.discard.includes('u_yan_1'), '耐久耗尽进入弃牌区');
}

/* 6. 眩晕：不会失去耐久，也不能攻击 */
{
  const g = fresh();
  const u = give(g, 'P1', 'u_yan_1', 0, { stunned: true, dur: 3, sick: false });
  const target = give(g, 'P2', 'u_yan_1', 0, { sick: false });
  const r = g.action('P1', { type: 'attack', uid: u.uid, target: { kind: 'unit', uid: target.uid } });
  ok(!r.ok, '眩晕单位不能攻击');
  g.action('P1', { type: 'endTurn' });
  g.action('P2', { type: 'endTurn' });
  ok(g.players.P1.field[0] && g.players.P1.field[0].dur === 3, '眩晕单位回合开始不失去耐久');
}

/* 7. 指令：第 3 次使用后除外 */
{
  const g = fresh();
  const cid = 'c_yan_2'; // 突袭令：需要一个己方单位
  const ally = give(g, 'P1', 'u_yan_1', 0, { sick: false });
  for (let n = 0; n < 3; n++) {
    g.players.P1.ap = 3;
    const i = putHand(g, 'P1', cid);
    const r = g.action('P1', { type: 'command', hand: i, target: { kind: 'unit', uid: ally.uid } });
    ok(r.ok, `第 ${n + 1} 次使用指令应成功：` + r.error);
  }
  ok(g.players.P1.exile.filter((c) => c === cid).length === 1, '第 3 次使用后进入除外区');
  ok(g.players.P1.discard.filter((c) => c === cid).length === 2, '前两次使用进入弃牌区');
}

/* 8. 隐匿：己方场上还有非隐匿单位时不能被选为目标 */
{
  const g = fresh();
  const stealth = give(g, 'P2', 'u_ying_1', 0, { sick: false });
  const normal = give(g, 'P2', 'u_yan_1', 1, { sick: false });
  const atk = give(g, 'P1', 'u_yan_2', 0, { sick: false });
  let r = g.action('P1', { type: 'attack', uid: atk.uid, target: { kind: 'unit', uid: stealth.uid } });
  ok(!r.ok, '有非隐匿同伴时，隐匿单位不可被攻击');

  g.players.P2.field[1] = null;
  r = g.action('P1', { type: 'attack', uid: atk.uid, target: { kind: 'unit', uid: stealth.uid } });
  ok(r.ok, '非隐匿同伴离场后，隐匿单位可以被攻击：' + r.error);
}

/* 9. 群攻：攻击一个单位时对其它敌方单位也造成伤害 */
{
  const g = fresh();
  give(g, 'P1', 'u_yan_5', 0, { sick: false }); // 15/10 群攻
  const d1 = give(g, 'P2', 'u_sen_3', 0, { sick: false }); // 5/20 防御5
  const d2 = give(g, 'P2', 'u_yan_1', 1, { sick: false }); // 5/5
  const d3 = give(g, 'P2', 'u_yan_4', 2, { sick: false }); // 10/5
  g.action('P1', { type: 'attack', uid: g.players.P1.field[0].uid, target: { kind: 'unit', uid: d1.uid } });
  ok(d1.hp === 10, '主目标：15 - 防御 5 = 10 伤害');
  ok(d2.hp <= 0 && d2.dead, '群攻波及 5 血单位');
  ok(d3.hp <= 0 && d3.dead, '群攻波及另一个 5 血单位');
}

/* 10. 取整：非 5 的倍数向上取整到 5 */
{
  const g = fresh();
  ok(g.r5(0) === 0, '0 保持 0');
  ok(g.r5(1) === 5, '1 → 5');
  ok(g.r5(12) === 15, '12 → 15');
  ok(g.r5(9999) === 995, '超过上限降为 995');
}

/* 11. 亡计：从阵亡区发动后除外 */
{
  const g = fresh();
  give(g, 'P2', 'u_yan_2', 0, { sick: false, hp: 5, hpMax: 5 });
  g.players.P1.grave.push('u_yan_7');
  const r = g.action('P1', { type: 'deathrattle', grave: 0 });
  ok(r.ok, '亡计应可发动：' + r.error);
  ok(g.players.P2.field[0] === null || g.players.P2.field[0].hp < 5, '亡计对敌方造成伤害');
  ok(g.players.P1.exile.includes('u_yan_7'), '发动后除外');
}

/* 12. 牌库抽空后弃牌区洗回 */
{
  const g = fresh();
  g.players.P1.deck = [];
  g.players.P1.discard = ['u_yan_1', 'u_yan_2', 'u_yan_3'];
  g.draw('P1', 2, '测试');
  ok(g.players.P1.hand.length === 2, '抽 2 张');
  ok(g.players.P1.discard.length === 0 && g.players.P1.deck.length === 1, '弃牌区洗回牌库');
}

console.log(`✅ 规则测试全部通过（${passed} 条断言）`);
