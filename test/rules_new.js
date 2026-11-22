'use strict';
/**
 * 新卡组（小圆 / 海贼王 / 孤独摇滚 / 友奈 / 学院孤岛）的规则断言
 * 用法： node test/rules_new.js
 */
const { Game } = require('../engine/engine');
const CARDS = require('../engine/cards').cards;

let pass = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error('断言失败：' + msg);
  pass++;
};

function deck(id, units, cmds) {
  return { id, name: id, units: units, commands: cmds || [], desc: '' };
}

function fresh(cfg) {
  const g = new Game({
    p1: 'A', p2: 'B',
    deckP1: deck('a', [['u_yan_1', 20]]),
    deckP2: deck('b', [['u_yan_1', 20]]),
    config: cfg || {}
  });
  g.first = 'P1';
  g.active = 'P1';
  g.action('P1', { type: 'mulligan', cards: [] });
  g.action('P2', { type: 'mulligan', cards: [] });
  return g;
}

// 直接摆一个单位到槽位上（跳过部署流程，方便测效果）
function put(g, pid, cid, slot) {
  const u = g.makeUnit(cid, pid);
  u.sick = false;                     // 测试里默认已经过了部署回合
  u.attacksLeft = u.maxAttacks;
  g.me(pid).field[slot] = u;
  g.recalcAll();
  return u;
}

function giveHand(g, pid, cid) {
  g.me(pid).hand.push({ cid, uses: 0 });
  return g.me(pid).hand.length - 1;
}

console.log('— 装备 —');
{
  const g = fresh();
  const host = put(g, 'P1', 'u_op_2', 0); // 超新星 Ⅱ 25/25
  const i = giveHand(g, 'P1', 'u_op_1');  // 新人 15/15
  const r = g.action('P1', { type: 'equip', hand: i, uid: host.uid });
  ok(r.ok, '装备应当成功');
  ok(host.atk === 40 && host.hpMax === 40, '装备后 25/25 → 40/40，实际 ' + host.atk + '/' + host.hpMax);

  const host1 = put(g, 'P1', 'u_yan_1', 1); // Ⅰ 级
  const j = giveHand(g, 'P1', 'u_op_1');
  const r2 = g.action('P1', { type: 'equip', hand: j, uid: host1.uid });
  ok(!r2.ok, '不能装备到 Ⅰ 级单位上');
}

console.log('— 连击（可攻击 2 次） —');
{
  const g = fresh();
  const atk = put(g, 'P1', 'u_mad_4', 0); // 巴麻美 Ⅳ 50/30
  const def = put(g, 'P2', 'u_mad_1', 0); // 丘比 0/20
  def.baseHp = 200;                       // 撑大一点，别第一次就被打死
  def.dur = 99;
  g.recalcAll();
  g.me('P1').ap = 5;
  const r1 = g.action('P1', { type: 'attack', uid: atk.uid, target: { kind: 'unit', uid: def.uid } });
  ok(r1.ok, '第一次攻击应当成功');
  ok(atk.attacksLeft === 1, '攻击 1 次后还剩 1 次');
  const r2 = g.action('P1', { type: 'attack', uid: atk.uid, target: { kind: 'unit', uid: def.uid } });
  ok(r2.ok, '第二次攻击应当成功');
  ok(atk.attacksLeft === 0, '两次之后不能继续攻击');
  const r3 = g.action('P1', { type: 'attack', uid: atk.uid, target: { kind: 'unit', uid: def.uid } });
  ok(!r3.ok, '第三次攻击应当被拒绝');
}

console.log('— 相邻光环 —');
{
  const g = fresh();
  const me = put(g, 'P1', 'u_gak_2', 0);   // 直树美纪 Ⅱ 10/20，相邻 +15/+15
  const mate = put(g, 'P1', 'u_gak_1', 1); // 太郎丸 Ⅰ 15/15
  ok(mate.atk === 30 && mate.hpMax === 30, '相邻单位应 15/15 → 30/30，实际 ' + mate.atk + '/' + mate.hpMax);
  g.killUnit(me, true);
  ok(mate.atk === 15 && mate.hpMax === 15, '光环消失后应恢复 15/15，实际 ' + mate.atk + '/' + mate.hpMax);
}

console.log('— 唯一单位 —');
{
  const g = fresh();
  const b = put(g, 'P1', 'u_boc_2', 0); // 山田凉 Ⅱ 15/25，唯一时 +5/+5
  ok(b.atk === 20 && b.hpMax === 30, '唯一单位应 15/25 → 20/30，实际 ' + b.atk + '/' + b.hpMax);
  put(g, 'P1', 'u_yan_1', 1);
  ok(b.atk === 15 && b.hpMax === 25, '不再是唯一单位，应回到 15/25，实际 ' + b.atk + '/' + b.hpMax);
}

console.log('— 压制 —');
{
  const g = fresh();
  const u = put(g, 'P1', 'u_yan_1', 0);
  const foe = put(g, 'P2', 'u_mad_1', 0);
  g.me('P1').ap = 3;
  g.applyEffect('P2', null, { op: 'suppress', value: 1, target: 'enemyUnitRandom' }, {});
  ok(u.suppress === 1, '应被压制 1 层');
  g.me('P1').ap = 3;
  const r = g.action('P1', { type: 'attack', uid: u.uid, target: { kind: 'unit', uid: foe.uid } });
  ok(r.ok && g.me('P1').ap === 1, '压制 1 层时攻击花 2 点，剩 1 点，实际剩 ' + g.me('P1').ap);
  g.applyEffect('P2', null, { op: 'suppress', value: 2, target: 'enemyUnitRandom' }, {});
  ok(u.suppress === 2, '应被压制到 2 层');
  g.me('P1').ap = 5;
  const r2 = g.action('P1', { type: 'attack', uid: u.uid, target: { kind: 'unit', uid: foe.uid } });
  ok(!r2.ok, '压制 2 层不能攻击');
}

console.log('— 进入阵亡区触发（丘比） —');
{
  const g = fresh();
  const q = put(g, 'P1', 'u_mad_1', 0);
  const hand0 = g.me('P1').hand.length;
  const life0 = g.me('P1').life;
  g.killUnit(q, true);
  ok(g.me('P1').hand.length === hand0 + 1, '丘比进阵亡区应抽 1 张');
  ok(g.me('P1').life === life0 + 1, '丘比进阵亡区应回 1 点生命');
  ok(g.me('P1').grave.indexOf('u_mad_1') >= 0, '丘比应进入阵亡区');
}

console.log('— 除外并返回（结城友奈） —');
{
  const g = fresh();
  const y = put(g, 'P1', 'u_yuyu_5', 0); // Ⅴ 60/60
  const enemy = put(g, 'P2', 'u_yan_1', 1);
  g.fire(y, 'onDeploy', {});
  ok(g.me('P2').field.filter(Boolean).length === 0, '敌方单位应被除外');
  ok(g.returns.length === 1, '应有一条返回记录');
  g.action('P1', { type: 'endTurn' }); // 轮到 P2
  ok(g.me('P2').field.filter(Boolean).length === 1, '敌方单位应在其回合开始时返回');
}

console.log('— 衍生物“慈” —');
{
  const g = fresh();
  const y = put(g, 'P1', 'u_gak_5', 0); // 丈枪由纪
  g.fire(y, 'onDeploy', {});
  const has = g.me('P1').hand.some((c) => c.cid === 't_gak_ci');
  ok(has, '部署由纪应拿到 1 张“慈”');
}

console.log('— 魔女之夜 —');
{
  const g = fresh();
  put(g, 'P1', 'u_yan_1', 0);
  put(g, 'P1', 'u_yan_1', 1);
  put(g, 'P2', 'u_yan_1', 0);
  const i = giveHand(g, 'P1', 'c_mad_1');
  g.me('P1').ap = 3;
  const hand0 = g.me('P1').hand.length - 1;
  const r = g.action('P1', { type: 'command', hand: i });
  ok(r.ok, '魔女之夜应当可用');
  ok(g.me('P1').field.filter(Boolean).length === 0 && g.me('P2').field.filter(Boolean).length === 0, '双方场上应清空');
  ok(g.me('P1').hand.length === hand0 + 2, '自己失去 2 个应抽 2 张，实际手牌 ' + g.me('P1').hand.length);
}

console.log('— 碎裂 —');
{
  const g = fresh();
  const u = put(g, 'P1', 'u_yan_1', 0);
  const i = giveHand(g, 'P1', 'c_mad_3');
  g.me('P1').ap = 3;
  const life0 = g.me('P1').life;
  const r = g.action('P1', { type: 'command', hand: i, target: { kind: 'unit', uid: u.uid } });
  ok(r.ok, '碎裂应当可用');
  ok(u.attacksLeft === 1 && u.doomed, '应获得一次额外攻击并标记阵亡');
  g.action('P1', { type: 'endTurn' });
  ok(g.me('P1').field.filter(Boolean).length === 0, '回合结束应阵亡');
  ok(g.me('P1').life === life0 + 1, '应回复等于等级（1）的生命');
}

console.log('— 学院孤岛：第 2 张指令加成 —');
{
  const g = fresh();
  const u1 = put(g, 'P1', 'u_yan_1', 0);
  const u2 = put(g, 'P1', 'u_yan_1', 1);
  g.me('P1').ap = 9;
  const a = giveHand(g, 'P1', 'c_gak_1');
  ok(g.action('P1', { type: 'command', hand: a }).ok, '第 1 张指令应可用');
  const b = giveHand(g, 'P1', 'c_gak_3');
  ok(g.action('P1', { type: 'command', hand: b }).ok, '第 2 张指令应可用');
  ok(u1.atk === 5 + 60, '第 2 张指令应 +60 攻击，实际 ' + u1.atk);
  ok(u2.atk === 65, '其它单位也应 +60，实际 ' + u2.atk);
}

console.log('— 霸王色：需要 Ⅳ 级在场 —');
{
  const g = fresh();
  g.me('P1').ap = 9;
  const i1 = giveHand(g, 'P1', 'c_op_3');
  const r1 = g.action('P1', { type: 'command', hand: i1 });
  ok(!r1.ok, '没有 Ⅳ 级单位时不能用霸王色');
  const big = put(g, 'P1', 'u_op_4', 0); // 皇副 Ⅳ
  g.me('P1').ap = 9;
  const i2 = giveHand(g, 'P1', 'c_op_3');
  const r2 = g.action('P1', { type: 'command', hand: i2 });
  ok(r2.ok, '有 Ⅳ 级单位后应当可用');
  ok(big.level === 4, '测试用单位等级应为 4');
}

console.log('— 免疫敌方指令 —');
{
  const g = fresh();
  const boss = put(g, 'P2', 'u_op_5', 0); // 四皇
  const i = giveHand(g, 'P1', 'c_yan_1');  // 烈焰弹
  g.me('P1').ap = 6;
  const r = g.action('P1', { type: 'command', hand: i, target: { kind: 'unit', uid: boss.uid } });
  ok(!r.ok, '四皇不受敌方指令影响，应被拒绝');
}

console.log('— 贝斯笑话：Ⅱ 级攻击免费 —');
{
  const g = fresh();
  const u = put(g, 'P1', 'u_mad_2', 0);  // 沙耶香 Ⅱ
  const foe = put(g, 'P2', 'u_yan_1', 0);
  const i = giveHand(g, 'P1', 'c_boc_2');
  ok(g.action('P1', { type: 'command', hand: i }).ok, '贝斯笑话应当可用');
  g.me('P1').ap = 0;
  const r = g.action('P1', { type: 'attack', uid: u.uid, target: { kind: 'unit', uid: foe.uid } });
  ok(r.ok, '0 行动点也应能攻击');
}

console.log('— 进入弃牌区触发（晓美焰） —');
{
  const g = fresh();
  const yan = put(g, 'P1', 'u_mad_5', 0); // 晓美焰 Ⅳ 50/50
  const other = put(g, 'P1', 'u_mad_4', 1); // 巴麻美 Ⅳ
  const i = giveHand(g, 'P1', 'u_mad_6');  // 鹿目圆 Ⅴ，用两张 Ⅳ 升变
  g.me('P1').ap = 3;
  other.equip = [{ cid: 'u_op_1', atk: 15, hp: 15 }];
  const r = g.action('P1', { type: 'upgrade', hand: i, materials: [yan.uid] });
  ok(r.ok, '一张 Ⅳ 应能升变 Ⅴ');
  ok(other.atk === 70 && other.hpMax === 50, '晓美焰进弃牌区后，Ⅳ 级单位应 +5/+5（50+15+5），实际 ' + other.atk + '/' + other.hpMax);
}

console.log('— 鹿目圆光环：Ⅳ 级阵亡进弃牌区 —');
{
  const g = fresh();
  put(g, 'P1', 'u_mad_6', 0); // 鹿目圆
  const four = put(g, 'P1', 'u_mad_4', 1);
  g.killUnit(four, true);
  ok(g.me('P1').discard.indexOf('u_mad_4') >= 0, 'Ⅳ 级单位阵亡应进弃牌区');
  ok(g.me('P1').grave.indexOf('u_mad_4') < 0, '不应进阵亡区');
}

console.log(`\n✅ 新机制测试全部通过（${pass} 条断言）`);
