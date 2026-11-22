# 参与开发（CONTRIBUTING）

欢迎一起改这个原型。下面的约定不是规矩，是让多人同时改同一个仓库时不互相踩脚的办法。

## 先读这三份

| 文档 | 什么时候看 |
| --- | --- |
| `使用说明.md` | 想知道怎么开服、怎么联机、怎么异地 |
| `修改指南.md` | 想改数值 / 加卡 / 加卡组 / 加关键词（带代码示例） |
| `规则原文整理.md` | 想知道每条规则对应的手写原稿与取舍 |

## 环境

- Node.js ≥ 18（工程零依赖，不需要 `npm install`）
- Windows 直接用自带的 `runtime\node.exe`；Mac/Linux 用系统 Node 即可
- `runtime\node.exe` 是 Windows 免安装运行时，提交时不要动它

```bash
node server.js 8080     # 起服务器，浏览器开 http://127.0.0.1:8080
```

## 分支与提交

- 从 `main` 切分支：`feature/add-xxx-deck`、`fix/upgrade-cost`、`docs/readme`
- 提交信息用一句话说清"改了什么、为什么"，例如：
  `cards: 削弱杏子 40/35 -> 35/30（对Ⅲ级升变太强）`
- 一个 PR 只做一件事。改卡池数值 + 顺手重构引擎，会让 review 很难受。

## 改卡池（最容易多人冲突的地方）

`engine/cards.js` 一个文件装着全部 71 张卡和 8 套卡组。

- **加一张卡**：在 `cards` 里加定义，字段含义见 `修改指南.md` 第 2 节。
- **效果写法**：`effects` 里用 `op` + `target`，可选 op 列表见 `修改指南.md` 第 3 节（约 30 个）。
- **加一套卡组**：`decks` 里加 24 张单位 + 3 张指令，然后跑
  `node test/export_cards.js` 重新生成 `卡表.md`（别手改卡表）。
- **数值规矩**：攻击/伤害/生命都按 5 的倍数向上取整，超过 995 截断（`engine/config.js`）。

多人同时改卡池时，建议按卡组分工（一人一套），减少同文件同区域的冲突。

## 加机制

- 新效果：`engine/engine.js` 的 `applyEffect` 里加 `case`，目标解析在 `resolveTargets`
- 新条件：`checkCond` 里加分支
- 新触发时点：目前有 `onPlay / onDeath / onGrave / onDiscard / onAttack / whenAttackIndex`，加新的要同时在 `applyEffect` 和触发处补
- 光环类（持续生效）走 `recalcAll()` + `auraTargets()`，别在回合里临时改 `atk/hp`，否则光环消失时会算错

## 提交前必做

```bash
node test/rules.js        # 基础规则 41 条
node test/rules_new.js    # 新卡组/新机制 44 条
node test/sim.js 100      # 机器人跑 100 局，查崩溃与非法状态
node test/net.js          # 真联机 + 观战
```

或者一把梭：`npm test`（Windows 也可以双击 `自测.bat`）。

改了界面再额外跑 `node test/cdp.js`（需要本机有 Edge、8080 上有服务，会输出截图）。

**测试挂了的 PR 不会合。** 如果测试本身写错了，改测试要说明理由。

## 代码风格

- 2 空格缩进、单引号、行尾不加分号以外的花活；跟现有文件保持一致
- 注释用中文，解释"为什么"而不是"是什么"
- 客户端（`public/app.js`）不做规则判定，只做"能不能点"的即时反馈；真判定一律在 `engine/`

## 不要提交

- `test/*.png`、`test/edge_profile/`（测试产物，已在 `.gitignore`）
- 任何个人账号、token、内网地址

## 关于版权

代码 MIT。卡池里的角色与作品名属于各自权利方，本项目是非商业同人二创，**不要加入付费、抽卡、广告之类的东西**。
