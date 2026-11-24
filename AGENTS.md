# AGENTS.md · 给 AI 编码助手的项目说明

> 这份文件是给 **AI 编码助手**（Claude Code / Cursor / Codex / GitHub Copilot 等）看的。
> 人看的话，先读 `README.md`、`修改指南.md`。
> 每次开新会话，先读完这份文件再动手。

---

## 1. 这是什么

「升变」：一个按手写规则做成的 **1v1 联机卡牌对战原型**。服务端权威（所有判定在服务器），浏览器只负责展示与操作。当前 8 套卡组、71 张卡、带观战。

- 玩家在浏览器打开 `http://localhost:8080`，一个人建房拿到 4 位房间码，另一个输码加入。
- 规则来源是手写笔记，文字整理见 `规则原文整理.md`，取舍有说明，别自己发明规则。

## 2. 绝对不能破坏的三条

1. **零依赖**。不允许出现 `import` 第三方包、不允许 `npm install`、不允许改 `package.json` 的 `dependencies`。只用 Node 标准库。原因：这个文件夹要能整包拷给任何人直接跑。
2. **零构建**。前端是原生 HTML/CSS/JS，直接由 `server.js` 静态托管。不允许引入 React/Vue/Vite/TypeScript/打包步骤/`tsconfig`。
3. **服务端权威**。任何"能不能打/算多少伤害/谁赢了"的判断必须发生在 `engine/`（由 `server.js` 调用）。前端 `public/app.js` 里的合法性预判只用于即时反馈，**不能作为唯一判据**，也不要把它当成可以绕过的地方。

## 3. 目录职责（改东西先找对文件）

| 路径 | 职责 | 什么情况下改它 |
| --- | --- | --- |
| `engine/config.js` | 全部数值常量：生命、行动点、槽位数、抽牌数、耐久衰减、升变配方、取整规则 | 调规则数值 |
| `engine/cards.js` | 71 张卡定义 + 8 套卡组的 id 列表 + 关键词中文名 | 改卡面数值、加卡、加卡组、改卡组配比 |
| `engine/engine.js` | 规则裁判：部署、升变、攻击、装备、效果结算、视角过滤（`specView`） | 加/改机制、修判定 bug |
| `server.js` | 零依赖 HTTP + 手写 WebSocket：房间码、座位、观战、断线重连、`/health` | 改联机、房间、同步 |
| `public/index.html` `style.css` `app.js` | 大厅与牌桌前端 | 改界面、交互、提示文案 |
| `test/rules.js` | 41 条基础规则断言 | 基础规则改动必须同步补 |
| `test/rules_new.js` | 44 条新卡组/新机制断言 | 新机制改动必须同步补 |
| `test/sim.js` | 机器人自动对局（8 套轮转），查崩溃/非法状态 | 机制大改后跑 |
| `test/net.js` | 真联机端到端：建房→加入→开局→部署→拒绝非法攻击→重连→观战 | 动了 `server.js` 必须跑 |
| `test/cdp.js` | 无头 Edge 截图验收（需要本机 Edge，会杀进程删临时 profile） | 动了前端想看图 |
| `test/export_cards.js` | 从 `cards.js` 生成 `卡表.md` | 改了卡池就跑 |
| `get-node.ps1` | 下载免安装 Node 到 `runtime/`（`runtime/` 不入库） | 基本不用改 |
| `docs/screenshots/` | README 配图 | 界面大改后换图 |

文档：`README.md`（对外门面）、`使用说明.md`（给玩家）、`修改指南.md`（给改代码的人）、`卡表.md`（自动生成，**不要手改**）、`CONTRIBUTING.md`（协作约定）。

## 4. 跑起来 / 跑测试

本地若没有 `runtime\node.exe`（比如刚 clone 下来），先跑一次：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\get-node.ps1
```

之后统一用：

```powershell
.\runtime\node.exe server.js 8080                      # 起服务器
.\runtime\node.exe test\rules.js                       # 41 条基础断言
.\runtime\node.exe test\rules_new.js                   # 44 条新机制断言
.\runtime\node.exe test\sim.js 40                       # 40 局机器人对局
.\runtime\node.exe test\net.js                          # 联机 + 观战
```

装了系统 Node 的机器上，把 `.\runtime\node.exe` 换成 `node` 即可（CI 就是这样跑的）。

## 5. 改动必须满足的验收线（提交前自查）

- 改了 `engine/` 的判定逻辑 → `rules.js` 和 `rules_new.js` **必须全绿**，而且**新行为要有新断言**（一条行为至少一条断言，写清"为什么这条断言能证明它"）。
- 改了 `cards.js` → 跑 `node test/export_cards.js` 重新生成 `卡表.md`，并跑 `test\sim.js 40` 确认没崩溃。
- 改了 `server.js` → 必须跑 `test/net.js`（它会真起服务器、真连 WebSocket）。
- 改了前端 → 至少跑一次 `test/net.js` 确认页面还能被托管；有条件跑 `test/cdp.js` 出图。
- **不要在测试里放宽断言来"让它变绿"**。测试挂了要么改代码，要么改断言并在提交信息里说明为什么原断言是错的。
- 不要为了让测试通过而引入 `try/catch` 吞异常。

## 6. 提交与协作

- 分支：从 `main` 切，命名 `cards/xxx`、`engine/xxx`、`server/xxx`、`ui/xxx`、`docs/xxx`、`test/xxx`。
- 提交信息：`前缀: 中文简述`，前缀用上面那几种。一个提交只做一件事。
- 一个 PR 只做一件事；PR 描述写"改了什么 / 为什么 / 跑了哪些测试"。
- 推送（本机若开着加速器，需要临时跳证书校验）：

  ```powershell
  git -c http.sslVerify=false push
  ```

- CI（`.github/workflows/test.yml`）会在 push / PR 上跑 rules / rules_new / sim 40 / net 四步。**CI 红了就是改坏了，不要绕过。**

## 7. 代码风格（跟着现有代码走）

- 纯函数优先，`engine.js` 里的结算逻辑保持"输入状态 → 输出状态/事件"，不要偷偷改全局。
- 命名用现有词汇：`deploy`、`ascend`（升变）、`attack`、`discard`、`graveyard`（阵亡区）、`hand`、`deck`、`field`、`slot`。
- 注释与文案一律中文；不要引入表情符号。
- 不写 class 继承、不用装饰器、不用 `async` 做同步逻辑。`server.js` 里手写 WebSocket 帧解析是刻意为之，不要换成 `ws` 库。
- 单个函数超过 ~80 行就该拆；`engine.js` 若因加机制变长，允许拆成 `engine/effects/*.js`（需同步更新本文档第 3 节）。
- 新增文件一律放在既有目录层级里，不要新建 `src/`、`lib/` 之类的新顶层目录。

## 8. 不要碰的东西

- `LICENSE` 与 README 末尾的**同人非商用声明**。卡池角色均属原版权方，本项目为非商业二创，这条不能改。
- `.gitignore` 里对 `runtime/`、`test/*.png` 的排除规则。
- `runtime/`（免安装 Node，已被 git 忽略，体积 83MB，**不要提交**）。
- 已有的房间码位数（4 位）、WebSocket 协议字段名（`type`/`action` 等），改了会同时破坏前端与 `test/net.js`。

## 9. 常见任务怎么下手

| 想做 | 大致步骤 |
| --- | --- |
| 改某张卡的数值 | `cards.js` 里找到卡 → 改 `atk/hp/cost` 等 → `export_cards.js` → `sim.js 40` |
| 加一张卡 | `cards.js` 里按现有对象结构加 → 加进对应卡组 id 列表 → 加断言 → 重新生成卡表 |
| 加一套卡组 | `cards.js` 加卡 + 加 `decks` 条目 → `server.js` 的卡组下拉是读 `decks` 的，无需改前端 → 跑 sim |
| 加一个关键词机制 | `engine/engine.js` 加结算分支（搜索现有 `kw.` 用法）→ `cards.js` 的 `KW_TEXT` 与 `KW_DESC` 各加一条（`KW_DESC` 是给「卡牌详情 / 卡组说明」看的释义，漏了界面会出现"（还没写释义）"）→ `rules_new.js` 补断言 |
| 调平衡 | 先跑 `sim.js` 收集胜率，再改 `cards.js` 数值，再跑对比；**数值变更需人工确认** |
| 改界面 | `public/` 三个文件；改完跑 `test/cdp.js` 出图对比 |
| 加联机功能 | `server.js`（房间/座位/广播）+ `public/app.js`（前端）+ `test/net.js`（断言） |

## 10. 提需求给 AI 时的推荐句式

- 先让它读：`读 AGENTS.md、engine/engine.js、engine/cards.js，再……`
- 先要方案：`只给方案和改动清单，先别改代码`
- 划清边界：`不要引入依赖、不要动 LICENSE、只改 xxx 文件`
- 要证据：`改完跑 rules.js / rules_new.js / sim.js 40，把输出贴给我`

---

## 11. 已知待办（可以主动认领）

1. 补 3~5 个关键词（装置、逼制、放逐），每个约 10~20 行 + 断言。
2. 卡组编辑器（现在加卡组要改文件）。
3. 人机对战（`test/sim.js` 的机器人逻辑可直接搬进 `engine`）。
4. 悔棋 / 回放（服务端权威，记录 action 序列即可实现）。
5. 观战者聊天、房间码自定义。
6. `docs/screenshots/` 三张配图已压成 webp（共约 170KB），界面大改后重新截图再压一次，别传原始 PNG。
