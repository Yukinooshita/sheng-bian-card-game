'use strict';
/**
 * ============================================================
 *  卡池与卡组 —— 想加卡/改卡/加卡组，改这个文件
 * ============================================================
 *
 * 单位卡字段：
 *   id        唯一标识（英文，别重复）
 *   name      卡名
 *   type      'unit' | 'command'
 *   level     等级 1~5（对应 Ⅰ~Ⅴ）
 *   atk       攻击（必须是 5 的倍数）
 *   hp        血量（必须是 5 的倍数）
 *   dur       耐久（不写则用 config 里的默认 3）
 *   kw        静态关键词，例如 { defense: 5, swift: true }
 *   effects   触发效果 { onDeploy:[], onAttack:[], onTurnStart:[], onDeath:[] }
 *   text      卡面文字（给玩家看的说明）
 *
 * 指令卡字段：
 *   cost      消耗行动点
 *   target    需要选目标时写 'enemyUnit' / 'allyUnit'，不需要就不写
 *   effects   使用后触发
 *
 * 效果写法（每条是一个 { op: ... }，从上到下执行）：
 *   { op:'damage',     value:15, target:'chosen' }       对单位造成伤害
 *   { op:'damage',     value:10, target:'allEnemyUnits' } 敌方全体
 *   { op:'damagePlayer', value:1, target:'enemyPlayer' }  对玩家造成生命伤害
 *   { op:'healFull',   target:'self' }                    修复（回满血）
 *   { op:'healPlayer', value:1 }                          己方玩家回血
 *   { op:'buff',       atk:5, hp:10, level:0, target:'self' }  加攻/加血/改等级
 *   { op:'draw',       value:1 }                          抽牌
 *   { op:'kw',         key:'defense', value:5, target:'self' }  获得关键词
 *   { op:'ready',      target:'self' }                    解除“已行动”
 *   { op:'discardRandom', value:1 }                       随机弃手牌
 *   { op:'gainAp',     value:1 }                          获得行动点
 *   { op:'stun',       target:'chosen' }                  施加眩晕
 *   { op:'bounce',     target:'chosen' }                  返回手牌
 *   { op:'destroy',    target:'chosen' }                  消灭单位
 *   target 可选：self / chosen / attackTarget / allEnemyUnits /
 *               enemyUnitRandom / enemyPlayer / selfPlayer
 *
 * 关键词（写进 kw）：
 *   swift      迅捷/闪击：部署当回合可攻击
 *   defense    n：受到攻击伤害 -n
 *   counter    n：被攻击时反击 n
 *   cleave     群攻：攻击时对敌方全体造成等同攻击力的伤害
 *   ricochet   弹射：攻击时对敌方每个单位造成 攻击力/敌方单位数（向上取 5）
 *   stealth    隐匿：己方场上还有非隐匿单位时无法被攻击
 *   impact     冲击：只有第一次攻击时触发 onAttack 效果
 *   pursuit    追击：攻击已受伤单位时才触发 onAttack 效果
 *   immediate  立即：该卡的行动不消耗行动点
 *   wither     凋亡：耐久耗尽时进入阵亡区（而不是弃牌区）
 *
 * 卡组写法：units 里 [卡号, 张数] 合计必须 = config.deckUnits（默认 24），
 *          commands 张数必须 = config.deckCommands（默认 3）。
 *          想加自己的卡组，照着复制一段改 id/name/内容即可。
 * ============================================================
 */

const KW_TEXT = {
  swift: '迅捷',
  defense: '防御',
  counter: '反击',
  cleave: '群攻',
  ricochet: '弹射',
  stealth: '隐匿',
  impact: '冲击',
  pursuit: '追击',
  immediate: '立即',
  wither: '凋亡',
  device: '装置',
  double: '连击',
  immuneCmd: '不受指令',
  unsuppressible: '不可压制',
  equip: '装备'
};

/**
 * 关键词释义：给界面上的「卡牌详情 / 卡组说明」用，改机制时顺手改这里。
 * 前端只负责展示，不重复实现规则。
 */
const KW_DESC = {
  swift: '部署当回合就能攻击（普通单位要等下一回合）',
  defense: '受到攻击时，那次伤害减少标注的数值',
  counter: '被攻击时，对攻击者反击标注的数值',
  cleave: '攻击时同时对敌方所有单位造成等量的攻击力伤害',
  ricochet: '攻击时对敌方每个单位造成「攻击力 ÷ 敌方单位数」的伤害，向上取 5',
  stealth: '己方场上还有其他非隐匿单位时，它不能被选为攻击目标',
  impact: '只有本回合的第一次攻击才触发它的「攻击时」效果',
  pursuit: '攻击已经受伤的单位时，才触发它的「攻击时」效果',
  immediate: '这张卡的行动不消耗行动点',
  wither: '耐久耗尽时进入阵亡区（而不是弃牌区），可以被「亡计」利用',
  device: '装置类关键词：挂在场上持续生效（原型还未出卡）',
  double: '一回合可以攻击两次',
  immuneCmd: '不会被敌方指令选为目标',
  unsuppressible: '不会被压制',
  equip: '作为装备挂到己方单位上，不占部署槽；等级要求见卡面'
};

const cards = {
  /* ================= 炎 · 速攻 ================= */

  u_yan_1: {
    id: 'u_yan_1', name: '焰苗', type: 'unit', level: 1,
    atk: 5, hp: 5, dur: 3, kw: { swift: true },
    text: '迅捷：部署当回合即可攻击。'
  },
  u_yan_2: {
    id: 'u_yan_2', name: '火舌兵', type: 'unit', level: 1,
    atk: 10, hp: 5, dur: 3, kw: { impact: true },
    effects: { onAttack: [{ op: 'damage', value: 5, target: 'attackTarget' }] },
    text: '冲击：第一次攻击时，对目标额外造成 5 伤害。'
  },
  u_yan_3: {
    id: 'u_yan_3', name: '灰烬壁垒', type: 'unit', level: 1,
    atk: 0, hp: 10, dur: 3, kw: { defense: 5 },
    text: '防御 5。'
  },
  u_yan_4: {
    id: 'u_yan_4', name: '燃火术士', type: 'unit', level: 2,
    atk: 10, hp: 5, dur: 3,
    effects: { onDeploy: [{ op: 'damagePlayer', value: 1, target: 'enemyPlayer' }] },
    text: '部署时：敌方玩家失去 1 点生命。'
  },
  u_yan_5: {
    id: 'u_yan_5', name: '烈焰先锋', type: 'unit', level: 3,
    atk: 15, hp: 10, dur: 3, kw: { cleave: true },
    text: '群攻：攻击时对敌方每个单位造成等同攻击力的伤害。'
  },
  u_yan_6: {
    id: 'u_yan_6', name: '熔岩巨兽', type: 'unit', level: 4,
    atk: 20, hp: 25, dur: 3, kw: { impact: true },
    effects: { onAttack: [{ op: 'damage', value: 10, target: 'attackTarget' }] },
    text: '冲击：第一次攻击时，对目标额外造成 10 伤害。'
  },
  u_yan_7: {
    id: 'u_yan_7', name: '炎狱之主', type: 'unit', level: 5,
    atk: 30, hp: 40, dur: 3,
    effects: { onDeath: [{ op: 'damage', value: 10, target: 'allEnemyUnits' }] },
    text: '亡计：在阵亡区时可发动 —— 对敌方全体造成 10 伤害，然后除外。'
  },

  /* ================= 森 · 防守 ================= */

  u_sen_1: {
    id: 'u_sen_1', name: '幼苗', type: 'unit', level: 1,
    atk: 5, hp: 5, dur: 3,
    effects: { onDeploy: [{ op: 'healPlayer', value: 1 }] },
    text: '部署时：己方玩家回复 1 点生命。'
  },
  u_sen_2: {
    id: 'u_sen_2', name: '苔藓盾', type: 'unit', level: 1,
    atk: 0, hp: 10, dur: 3, kw: { defense: 5 },
    text: '防御 5。'
  },
  u_sen_3: {
    id: 'u_sen_3', name: '铁木卫士', type: 'unit', level: 2,
    atk: 5, hp: 20, dur: 3, kw: { defense: 5 },
    text: '防御 5。'
  },
  u_sen_4: {
    id: 'u_sen_4', name: '荆棘兽', type: 'unit', level: 3,
    atk: 10, hp: 20, dur: 3, kw: { counter: 5 },
    text: '反击 5：被攻击时，攻击者受到 5 伤害。'
  },
  u_sen_5: {
    id: 'u_sen_5', name: '林间守望', type: 'unit', level: 4,
    atk: 15, hp: 30, dur: 3, kw: { stealth: true },
    text: '隐匿：己方场上还有别的非隐匿单位时，无法被攻击。'
  },
  u_sen_6: {
    id: 'u_sen_6', name: '世界树', type: 'unit', level: 5,
    atk: 25, hp: 50, dur: 3,
    effects: { onTurnStart: [{ op: 'healFull', target: 'self' }] },
    text: '回合开始时：修复自身。'
  },

  /* ================= 影 · 控制 ================= */

  u_ying_1: {
    id: 'u_ying_1', name: '影刺', type: 'unit', level: 1,
    atk: 10, hp: 5, dur: 3, kw: { stealth: true },
    text: '隐匿：己方场上还有别的非隐匿单位时，无法被攻击。'
  },
  u_ying_2: {
    id: 'u_ying_2', name: '飞刃', type: 'unit', level: 1,
    atk: 10, hp: 5, dur: 3, kw: { swift: true },
    text: '迅捷：部署当回合即可攻击。'
  },
  u_ying_3: {
    id: 'u_ying_3', name: '毒刃刺客', type: 'unit', level: 2,
    atk: 10, hp: 10, dur: 3, kw: { pursuit: true },
    effects: { onAttack: [{ op: 'damage', value: 5, target: 'attackTarget' }] },
    text: '追击：攻击已受伤单位时，额外造成 5 伤害。'
  },
  u_ying_4: {
    id: 'u_ying_4', name: '暗杀者', type: 'unit', level: 3,
    atk: 20, hp: 10, dur: 3, kw: { impact: true },
    effects: { onAttack: [{ op: 'damage', value: 10, target: 'attackTarget' }] },
    text: '冲击：第一次攻击时，对目标额外造成 10 伤害。'
  },
  u_ying_5: {
    id: 'u_ying_5', name: '虚空使徒', type: 'unit', level: 4,
    atk: 20, hp: 25, dur: 3, kw: { ricochet: true },
    text: '弹射：攻击时，对敌方每个单位造成 攻击力÷敌方单位数（向上取 5）。'
  },
  u_ying_6: {
    id: 'u_ying_6', name: '影主', type: 'unit', level: 5,
    atk: 35, hp: 35, dur: 3, kw: { cleave: true },
    text: '群攻：攻击时对敌方每个单位造成等同攻击力的伤害。'
  },

  /* ================= 指令 ================= */

  c_yan_1: {
    id: 'c_yan_1', name: '烈焰弹', type: 'command', cost: 2, target: 'enemyUnit',
    effects: [{ op: 'damage', value: 15, target: 'chosen' }],
    text: '对一个敌方单位造成 15 伤害。'
  },
  c_yan_2: {
    id: 'c_yan_2', name: '突袭令', type: 'command', cost: 1, target: 'allyUnit',
    effects: [{ op: 'ready', target: 'chosen' }],
    text: '解除一个己方单位的“已行动”，使其本回合可再次攻击。'
  },
  c_yan_3: {
    id: 'c_yan_3', name: '燃尽', type: 'command', cost: 1,
    effects: [
      { op: 'damagePlayer', value: 2, target: 'enemyPlayer' },
      { op: 'draw', value: 1 }
    ],
    text: '敌方玩家失去 2 点生命，你抽 1 张牌。'
  },

  c_sen_1: {
    id: 'c_sen_1', name: '生长', type: 'command', cost: 2, target: 'allyUnit',
    effects: [{ op: 'buff', atk: 5, hp: 10, level: 0, target: 'chosen' }],
    text: '一个己方单位 +5 攻击、+10 血量。'
  },
  c_sen_2: {
    id: 'c_sen_2', name: '荆棘之环', type: 'command', cost: 2,
    effects: [{ op: 'damage', value: 5, target: 'allEnemyUnits' }],
    text: '对敌方每个单位造成 5 伤害。'
  },
  c_sen_3: {
    id: 'c_sen_3', name: '铁壁', type: 'command', cost: 1, target: 'allyUnit',
    effects: [{ op: 'kw', key: 'defense', value: 5, target: 'chosen' }],
    text: '一个己方单位获得“防御 5”。'
  },

  c_ying_1: {
    id: 'c_ying_1', name: '暗算', type: 'command', cost: 2, target: 'enemyUnit',
    effects: [{ op: 'damage', value: 10, woundedValue: 20, target: 'chosen' }],
    text: '对一个敌方单位造成 10 伤害；若它已受伤，改为 20。'
  },
  c_ying_2: {
    id: 'c_ying_2', name: '迷雾', type: 'command', cost: 1, target: 'allyUnit',
    effects: [{ op: 'kw', key: 'stealth', value: true, target: 'chosen' }],
    text: '一个己方单位获得“隐匿”。'
  },
  c_ying_3: {
    id: 'c_ying_3', name: '掠夺', type: 'command', cost: 1,
    effects: [
      { op: 'draw', value: 2 },
      { op: 'discardRandom', value: 1 }
    ],
    text: '抽 2 张牌，随机弃 1 张手牌。'
  },

  /* ================= 魔法少女小圆 ================= */

  u_mad_1: {
    id: 'u_mad_1', name: '丘比', type: 'unit', level: 1,
    atk: 0, hp: 20, dur: 3,
    effects: { onGrave: [{ op: 'draw', value: 1 }, { op: 'healPlayer', value: 1 }] },
    text: '进入阵亡区时：抽 1 张牌，己方玩家回复 1 点生命。'
  },
  u_mad_2: {
    id: 'u_mad_2', name: '沙耶香', type: 'unit', level: 2,
    atk: 20, hp: 30, dur: 3,
    effects: { onTurnStart: [{ op: 'healFull', target: 'allyMostWounded' }] },
    text: '回合开始时：修复 1 个己方受伤单位。'
  },
  u_mad_3: {
    id: 'u_mad_3', name: '杏子', type: 'unit', level: 3,
    atk: 40, hp: 35, dur: 3,
    effects: { onDeploy: [{ op: 'discardRandom', value: 1 }] },
    text: '升变时：随机弃 1 张手牌。'
  },
  u_mad_4: {
    id: 'u_mad_4', name: '巴麻美', type: 'unit', level: 4,
    atk: 50, hp: 30, dur: 3, kw: { double: true },
    effects: { onAttack: [{ op: 'damage', value: 5, target: 'attackTarget', whenAttackIndex: 2 }] },
    text: '可攻击 2 次；第二次攻击时，额外造成 5 伤害。'
  },
  u_mad_5: {
    id: 'u_mad_5', name: '晓美焰', type: 'unit', level: 4,
    atk: 50, hp: 50, dur: 3,
    effects: { onDiscard: [{ op: 'buff', atk: 5, hp: 5, target: 'allyLevelAtLeast', level: 4 }] },
    text: '进入弃牌区时：己方 Ⅳ 级及以上单位永久 +5/+5。'
  },
  u_mad_6: {
    id: 'u_mad_6', name: '鹿目圆', type: 'unit', level: 5,
    atk: 60, hp: 60, dur: 3,
    aura: [{ scope: 'allyAtLeast', level: 4, dieToDiscard: true }],
    text: '光环：己方 Ⅳ 级及以上单位阵亡后进入弃牌区（不进阵亡区）。'
  },
  c_mad_1: {
    id: 'c_mad_1', name: '魔女之夜', type: 'command', cost: 3,
    effects: [{ op: 'clearFieldDraw' }],
    text: '双方将场上所有单位加入弃牌区，各自抽等量的牌。'
  },
  c_mad_2: {
    id: 'c_mad_2', name: '奇迹与魔法', type: 'command', cost: 2, target: 'allyUnit',
    effects: [
      { op: 'buff', atk: 5, hp: 5, target: 'chosen' },
      { op: 'discardToGrave', value: 1 }
    ],
    text: '1 张手牌加入阵亡区；1 个己方单位永久 +5/+5。'
  },
  c_mad_3: {
    id: 'c_mad_3', name: '碎裂', type: 'command', cost: 1, target: 'allyUnit',
    effects: [
      { op: 'doomedAttack', target: 'chosen' },
      { op: 'healPlayerByLevel', target: 'chosen' }
    ],
    text: '1 个己方单位立即多攻击 1 次，但回合结束时阵亡；回复等于其等级的生命。'
  },

  /* ================= 海贼王 ================= */

  u_op_1: {
    id: 'u_op_1', name: '新人', type: 'unit', level: 1,
    atk: 15, hp: 15, dur: 3, kw: { equip: true, equipMinLevel: 2 },
    text: '装备：可挂到己方 Ⅱ 级及以上单位身上，给它 +15/+15。'
  },
  u_op_2: {
    id: 'u_op_2', name: '超新星', type: 'unit', level: 2,
    atk: 25, hp: 25, dur: 3,
    text: '升变时：身上的装备由新单位继承。'
  },
  u_op_3: {
    id: 'u_op_3', name: '王下七武海', type: 'unit', level: 3,
    atk: 50, hp: 50, dur: 3,
    effects: { onTurnStart: [{ op: 'gainAp', value: -1, cond: { apAtLeast: 1 } }, { op: 'durPlus', value: 1, cond: { apAtLeast: 1 } }, { op: 'draw', value: 1, cond: { apAtLeast: 1 } }] },
    text: '固有：回合开始时花 1 点行动点，回复 1 点耐久并抽 1 张牌。'
  },
  u_op_4: {
    id: 'u_op_4', name: '皇副', type: 'unit', level: 4,
    atk: 65, hp: 65, dur: 3,
    aura: [{ scope: 'allyLevelDiff', atk: 5, hp: 5 }],
    text: '光环：己方场上每有 1 张等级不同的其它单位，它 +5/+5。'
  },
  u_op_5: {
    id: 'u_op_5', name: '四皇', type: 'unit', level: 5,
    atk: 80, hp: 80, dur: 3, kw: { immuneCmd: true },
    effects: { onDeploy: [{ op: 'stunEnemyAtMost', maxLevel: 2, value: 1 }] },
    text: '部署时：眩晕敌方所有 Ⅱ 级及以下单位；不受敌方指令影响。'
  },
  c_op_1: {
    id: 'c_op_1', name: '见闻色', type: 'command', cost: 1,
    effects: [{ op: 'handToDeckBottom', value: 1 }, { op: 'draw', value: 1 }],
    text: '对手 1 张手牌放回其牌库底，你抽 1 张牌。'
  },
  c_op_2: {
    id: 'c_op_2', name: '武装色', type: 'command', cost: 2, target: 'allyUnit',
    effects: [{ op: 'buffPct', atkPct: 50, hpPct: 50, target: 'chosen' }, { op: 'healFull', target: 'chosen' }],
    text: '1 个单位攻击与血量 +50%，并修复。'
  },
  c_op_3: {
    id: 'c_op_3', name: '霸王色', type: 'command', cost: 3,
    costIf: { level: 5, cost: 1 },
    require: { ownHasLevelAtLeast: 4 },
    effects: [{ op: 'stunEnemyAll', value: 2 }],
    text: '眩晕敌方所有单位 2 回合。需己方 Ⅳ 级及以上在场；有 Ⅴ 级在场时只花 1 点。'
  },

  /* ================= 孤独摇滚 ================= */

  u_boc_1: {
    id: 'u_boc_1', name: '星歌', type: 'unit', level: 1,
    atk: 20, hp: 20, dur: 3,
    effects: {
      onDeploy: [
        { op: 'draw', value: 1 },
        { op: 'draw', value: 1, cond: { hasLevelAtLeast: 4 } }
      ]
    },
    text: '部署时：抽 1 张牌；若场上有 Ⅳ 级及以上己方单位，再抽 1 张。'
  },
  u_boc_2: {
    id: 'u_boc_2', name: '山田凉', type: 'unit', level: 2,
    atk: 15, hp: 25, dur: 3,
    aura: [{ scope: 'selfIfSole', atk: 5, hp: 5 }],
    text: '若是己方唯一单位：+5/+5。'
  },
  u_boc_3: {
    id: 'u_boc_3', name: '广井菊里', type: 'unit', level: 2,
    atk: 25, hp: 15, dur: 3, kw: { swift: true },
    effects: { onAttack: [{ op: 'stunSelf' }] },
    text: '迅捷；攻击后眩晕自身 1 回合。'
  },
  u_boc_4: {
    id: 'u_boc_4', name: '喜多郁代', type: 'unit', level: 3,
    atk: 30, hp: 30, dur: 2, kw: { swift: true },
    text: '耐久 2；迅捷。'
  },
  u_boc_5: {
    id: 'u_boc_5', name: '虹夏', type: 'unit', level: 4,
    atk: 45, hp: 45, dur: 3,
    effects: { onDeploy: [{ op: 'suppressWeak' }] },
    text: '部署时：压制敌方血最少的单位；若它血量比虹夏更低，再压制 1 个。'
  },
  u_boc_6: {
    id: 'u_boc_6', name: '波奇', type: 'unit', level: 5,
    atk: 30, hp: 30, dur: 3, kw: { stealth: true },
    aura: [{ scope: 'selfIfSole', atk: 50, hp: 50 }],
    text: '若是己方唯一单位：+50/+50；否则隐匿。'
  },
  c_boc_1: {
    id: 'c_boc_1', name: '阴暗地爬行', type: 'command', cost: 1, target: 'enemyUnit',
    effects: [{ op: 'suppress', value: 1, target: 'chosen' }, { op: 'draw', value: 2 }],
    text: '压制 1 个敌方单位，抽 2 张牌。'
  },
  c_boc_2: {
    id: 'c_boc_2', name: '贝斯笑话', type: 'command', cost: 0,
    effects: [{ op: 'freeLevel2' }],
    text: '本回合 Ⅱ 级单位的部署和攻击不消耗行动点。'
  },
  c_boc_3: {
    id: 'c_boc_3', name: '下北泽的暑假', type: 'command', cost: 3,
    effects: [
      { op: 'suppressAllHighest' },
      { op: 'soleAll' },
      { op: 'nextTurnAp', value: 2 }
    ],
    text: '完全压制所有等级最高的单位；所有单位视为唯一单位，直到下回合结束；下回合额外 +2 行动点。'
  },

  /* ================= 结城友奈是勇者 ================= */

  u_yuyu_1: {
    id: 'u_yuyu_1', name: '犬吠埼树', type: 'unit', level: 1,
    atk: 0, hp: 25, dur: 3, kw: { unsuppressible: true },
    aura: [{ scope: 'allyAtLeast', level: 3, atk: 5, hp: 5 }],
    text: '光环：己方 Ⅲ 级及以上单位 +5/+5；自身无法被压制。'
  },
  u_yuyu_2: {
    id: 'u_yuyu_2', name: '犬吠埼风', type: 'unit', level: 2,
    atk: 30, hp: 20, dur: 3,
    effects: {
      onDeploy: [
        { op: 'draw', value: 4, cond: { soleHighest: true } },
        { op: 'discardToGrave', value: 1, cond: { soleHighest: true } }
      ]
    },
    text: '部署时：若它是己方唯一最高等级，抽 4 张，其中 1 张放入阵亡区。'
  },
  u_yuyu_3: {
    id: 'u_yuyu_3', name: '三好夏凜', type: 'unit', level: 3,
    atk: 20, hp: 20, dur: 3, kw: { swift: true, double: true },
    effects: { onDeploy: [{ op: 'gainAp', value: 1, debt: 1 }] },
    text: '迅捷，可攻击 2 次；部署时 +1 行动点，下回合少 1 点。'
  },
  u_yuyu_4: {
    id: 'u_yuyu_4', name: '东乡美森', type: 'unit', level: 4,
    atk: 80, hp: 50, dur: 3,
    effects: {
      onDeploy: [{ op: 'destroyLowEnemy', maxLevel: 2 }],
      onDiscard: [{ op: 'buff', atk: -10, hp: -10, target: 'allyLevelAtLeast', level: 4 }]
    },
    text: '部署时：消灭 1 个敌方 Ⅱ 级及以下单位；进入弃牌区时，己方 Ⅳ 级以上单位永久 -10/-10。'
  },
  u_yuyu_5: {
    id: 'u_yuyu_5', name: '结城友奈', type: 'unit', level: 5,
    atk: 60, hp: 60, dur: 3,
    effects: { onDeploy: [{ op: 'exileReturn' }] },
    text: '部署时：除外 1 个敌方单位，它在主人下回合开始时返回（等级 ≥ Ⅳ 时返回即眩晕）。'
  },
  c_yuyu_1: {
    id: 'c_yuyu_1', name: '满开', type: 'command', cost: 0, target: 'allyUnit',
    effects: [{ op: 'buff', atk: 30, hp: 20, level: 3, target: 'chosen' }],
    text: '1 个己方单位 +30/+20，等级变为 Ⅲ。'
  },
  c_yuyu_2: {
    id: 'c_yuyu_2', name: '锻坏', type: 'command', cost: 1, target: 'enemyUnit',
    effects: [
      { op: 'damagePlayer', value: 2, target: 'selfPlayer' },
      { op: 'discardRandom', value: 2 },
      { op: 'damage', value: 80, target: 'chosen' }
    ],
    text: '失去 2 点生命、弃 2 张牌，对 1 个单位造成 80 伤害。'
  },
  c_yuyu_3: {
    id: 'c_yuyu_3', name: '勇者部', type: 'command', cost: 2, target: 'allyUnit',
    effects: [{ op: 'ready', target: 'chosen' }, { op: 'draw', value: 1 }],
    text: '1 个己方单位立即可以再攻击 1 次，抽 1 张牌。'
  },

  /* ================= 学院孤岛 ================= */

  u_gak_1: {
    id: 'u_gak_1', name: '太郎丸', type: 'unit', level: 1,
    atk: 15, hp: 15, dur: 3,
    effects: { onDeploy: [{ op: 'draw', value: 1, cond: { minTotalUnits: 4 } }] },
    text: '部署后：若场上单位总数 ≥ 4，抽 1 张牌。'
  },
  u_gak_2: {
    id: 'u_gak_2', name: '直树美纪', type: 'unit', level: 2,
    atk: 10, hp: 20, dur: 2,
    aura: [{ scope: 'adjacent', atk: 15, hp: 15 }],
    text: '光环：相邻的己方单位 +15/+15；耐久 2。'
  },
  u_gak_3: {
    id: 'u_gak_3', name: '胡桃', type: 'unit', level: 3,
    atk: 15, hp: 30, dur: 3, kw: { swift: true, double: true },
    aura: [{ scope: 'selfPerAdjacent', atk: 15 }],
    text: '迅捷，可攻击 2 次；每有 1 个相邻己方单位 +15 攻击。'
  },
  u_gak_4: {
    id: 'u_gak_4', name: '若狭悠里', type: 'unit', level: 4,
    atk: 40, hp: 50, dur: 3,
    aura: [{ scope: 'adjacent', defense: 15 }, { scope: 'allAlly', cmdDiscount: true }],
    text: '光环：相邻己方单位防御 +15；己方每回合第 2 张指令少 1 点消耗。'
  },
  u_gak_5: {
    id: 'u_gak_5', name: '丈枪由纪', type: 'unit', level: 5,
    atk: 0, hp: 80, dur: 3,
    aura: [{ scope: 'adjacent', atk: 30, hp: 30 }],
    effects: {
      onDeploy: [{ op: 'addToken', cid: 't_gak_ci', value: 1 }],
      onTurnStart: [{ op: 'addToken', cid: 't_gak_ci', value: 1 }]
    },
    text: '光环：相邻己方单位 +30/+30；部署时与回合开始时，各拿 1 张“慈”。'
  },
  c_gak_1: {
    id: 'c_gak_1', name: '学院生活部', type: 'command', cost: 1,
    effects: [{ op: 'healPlayer', value: 2 }, { op: 'addToken', cid: 't_gak_ci', value: 1 }],
    text: '生命 +2，拿 1 张“慈”。'
  },
  c_gak_2: {
    id: 'c_gak_2', name: '紧急状况应对手册', type: 'command', cost: 2, target: 'enemyUnit',
    effects: [{ op: 'bounceAndDiscard', target: 'chosen' }],
    text: '1 个单位返回其主人手牌，对方弃掉等于它等级的牌。'
  },
  c_gak_3: {
    id: 'c_gak_3', name: '毕业', type: 'command', cost: 3,
    effects: [
      { op: 'buff', atk: 30, hp: 30, target: 'allAllies' },
      { op: 'buff', atk: 30, hp: 30, target: 'allAllies', cond: { cmdIndexAtLeast: 2 } }
    ],
    text: '己方全体 +30/+30；若是本回合第 2 张指令，改为 +60/+60。'
  },
  // 衍生物（不在卡组里，由“丈枪由纪 / 学院生活部”生成）
  t_gak_ci: {
    id: 't_gak_ci', name: '慈', type: 'command', cost: 1, target: 'enemyUnit', token: true,
    effects: [
      { op: 'damage', value: 25, soleValue: 50, target: 'chosen' },
      { op: 'draw', value: 1 }
    ],
    text: '对一个单位造成 25 伤害（若它是唯一单位则 50），抽 1 张牌。'
  }
};

const decks = [
  {
    id: 'yan', name: '炎 · 燎原', faction: '炎', desc: '低费单位铺场，靠迅捷与群攻抢血。',
    units: [['u_yan_1', 4], ['u_yan_2', 4], ['u_yan_3', 4], ['u_yan_4', 4], ['u_yan_5', 4], ['u_yan_6', 3], ['u_yan_7', 1]],
    commands: ['c_yan_1', 'c_yan_2', 'c_yan_3']
  },
  {
    id: 'sen', name: '森 · 长青', faction: '森', desc: '高血量与防御反击，用世界树拖垮对手。',
    units: [['u_sen_1', 6], ['u_sen_2', 5], ['u_sen_3', 4], ['u_sen_4', 4], ['u_sen_5', 4], ['u_sen_6', 1]],
    commands: ['c_sen_1', 'c_sen_2', 'c_sen_3']
  },
  {
    id: 'ying', name: '影 · 无声', faction: '影', desc: '隐匿与爆发，靠单体高攻与弹射清场。',
    units: [['u_ying_1', 6], ['u_ying_2', 6], ['u_ying_3', 4], ['u_ying_4', 4], ['u_ying_5', 3], ['u_ying_6', 1]],
    commands: ['c_ying_1', 'c_ying_2', 'c_ying_3']
  },
  {
    id: 'madoka', name: '魔法少女小圆 · 圆环', faction: '圆', desc: '低费铺场、亡语滚雪球，靠鹿目圆把阵亡变成资源。',
    units: [['u_mad_1', 12], ['u_mad_2', 3], ['u_mad_3', 3], ['u_mad_4', 3], ['u_mad_5', 2], ['u_mad_6', 1]],
    commands: ['c_mad_1', 'c_mad_2', 'c_mad_3']
  },
  {
    id: 'onepiece', name: '海贼王 · 霸者', faction: '海', desc: '装备叠数值，四皇一键清场。',
    units: [['u_op_1', 12], ['u_op_2', 6], ['u_op_3', 3], ['u_op_4', 2], ['u_op_5', 1]],
    commands: ['c_op_1', 'c_op_2', 'c_op_3']
  },
  {
    id: 'bocchi', name: '孤独摇滚 · 下北泽', faction: '音', desc: '唯一单位加成与压制，靠单核站场。',
    units: [['u_boc_1', 6], ['u_boc_2', 4], ['u_boc_3', 4], ['u_boc_4', 5], ['u_boc_5', 4], ['u_boc_6', 1]],
    commands: ['c_boc_1', 'c_boc_2', 'c_boc_3']
  },
  {
    id: 'yuyuyu', name: '结城友奈 · 勇者部', faction: '勇', desc: '光环与大身材，靠东乡和友奈压制场面。',
    units: [['u_yuyu_1', 10], ['u_yuyu_2', 6], ['u_yuyu_3', 4], ['u_yuyu_4', 3], ['u_yuyu_5', 1]],
    commands: ['c_yuyu_1', 'c_yuyu_2', 'c_yuyu_3']
  },
  {
    id: 'gakkou', name: '学院孤岛 · 学园生活部', faction: '学', desc: '相邻光环互相加成，靠站位滚出大场面。',
    units: [['u_gak_1', 10], ['u_gak_2', 6], ['u_gak_3', 4], ['u_gak_4', 3], ['u_gak_5', 1]],
    commands: ['c_gak_1', 'c_gak_2', 'c_gak_3']
  }
];

module.exports = { cards, decks, KW_TEXT, KW_DESC };
