'use strict';
/** 从 cards.js 导出卡表，生成 卡表.md（改完卡之后重新跑一遍即可） */
const fs = require('fs');
const path = require('path');
const { cards, decks, KW_TEXT } = require('../engine/cards');

const ROMAN = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ'];

function kwText(kw) {
  if (!kw) return '';
  return Object.keys(kw).map((k) => {
    const label = KW_TEXT[k] || k;
    return typeof kw[k] === 'number' ? label + kw[k] : label;
  }).join('、');
}

function effectText(def) {
  const out = [];
  const map = { onDeploy: '部署时', onAttack: '攻击时', onTurnStart: '回合开始', onDeath: '亡计' };
  Object.keys(def.effects || {}).forEach((hook) => {
    (def.effects[hook] || []).forEach((e) => {
      out.push(map[hook] + '：' + JSON.stringify(e));
    });
  });
  return out.join('；');
}

let md = '# 卡表\n\n';
md += '> 本文件由 `test/export_cards.js` 根据 `engine/cards.js` 自动生成。\n';
md += '> 改完卡后运行 `node test/export_cards.js` 重新生成，避免手抄出错。\n\n';

decks.forEach((d) => {
  md += `## ${d.name}（\`${d.id}\`）\n\n${d.desc}\n\n`;
  md += '| 等级 | 卡名 | 攻 / 血 | 耐久 | 关键词 | 说明 |\n';
  md += '| --- | --- | --- | --- | --- | --- |\n';
  d.units.forEach(([cid, n]) => {
    const c = cards[cid];
    md += `| ${ROMAN[c.level]} | ${c.name} ×${n} | ${c.atk} / ${c.hp} | ${c.dur == null ? 3 : c.dur} | ${kwText(c.kw) || '—'} | ${c.text || ''} |\n`;
  });
  md += '\n**指令**\n\n';
  md += '| 消耗 | 卡名 | 需要目标 | 说明 |\n| --- | --- | --- | --- |\n';
  d.commands.forEach((cid) => {
    const c = cards[cid];
    const target = c.target === 'enemyUnit' ? '敌方单位' : c.target === 'allyUnit' ? '己方单位' : '—';
    md += `| ${c.cost} | ${c.name} | ${target} | ${c.text || ''} |\n`;
  });
  md += '\n';
});

// 没有出现在任何卡组里的卡（衍生物）
const used = new Set();
decks.forEach((d) => {
  d.units.forEach(([cid]) => used.add(cid));
  d.commands.forEach((cid) => used.add(cid));
});
const tokens = Object.keys(cards).filter((cid) => !used.has(cid));
if (tokens.length) {
  md += '## 衍生物（不在卡组里，由效果生成）\n\n';
  md += '| 类型 | 卡名 | 消耗 | 说明 |\n| --- | --- | --- | --- |\n';
  tokens.forEach((cid) => {
    const c = cards[cid];
    md += `| ${c.type === 'command' ? '指令' : '单位'} | ${c.name} | ${c.cost == null ? '—' : c.cost} | ${c.text || ''} |\n`;
  });
  md += '\n';
}

fs.writeFileSync(path.join(__dirname, '..', '卡表.md'), md, 'utf8');
console.log('已生成 卡表.md');
