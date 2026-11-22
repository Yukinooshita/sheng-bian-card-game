# 发布到 GitHub（一次性操作）

本地仓库已经建好了：分支 `main`，初始提交 `46e973a`，30 个文件已入库（含 `runtime\node.exe`）。
下面只剩"在 GitHub 上建空仓库 + 推上去"。

---

## 0. 先确认 Git 能用

Git 已装在 `D:\Tools\PortableGit`，并加进了用户 PATH。**新开的** PowerShell / cmd 窗口里执行：

```
git --version
```

能打印 `git version 2.51.0.windows.1` 就行。如果当前已打开的窗口里没有，重开一个。

---

## 1. 在 GitHub 上创建一个空仓库

1. 打开 <https://github.com/new>
2. Repository name 建议：`sheng-bian-card-game`（也可以用 `upvard-card-game`，随便）
3. 选 **Public**（你刚才选的是公开）
4. **不要**勾选 "Add a README file"、".gitignore"、"license"——本地已经有了，勾了会冲突
5. 点 Create repository

建完页面会给你一个地址，形如：

```
https://github.com/<你的用户名>/sheng-bian-card-game.git
```

---

## 2. 把本地仓库推上去

```bash
cd "C:\Users\jsf2026\Doubao\chats\2026-11-21\new-chat-1\升变卡牌"

git remote add origin https://github.com/<你的用户名>/sheng-bian-card-game.git
git push -u origin main
```

第一次 push 会弹一个窗口让你登录 GitHub（Git Credential Manager 会打开浏览器，点 Authorize 即可）。
也可以用 Personal Access Token 当密码：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained → 勾 `Contents: Read and write`。

> `runtime/node.exe` 是 83 MB，第一次推送会比较慢（几分钟，看上传带宽）。GitHub 单文件上限 100 MB，这个尺寸没问题，但每次 clone 都会把 83 MB 一起拉下来。以后如果觉得太重，可以改用 Git LFS 或换成下载 Release 里的整合包。

---

## 3. 把提交作者改成你自己（可选但建议）

初始提交现在挂的是占位身份。设成你自己的：

```bash
git config user.name "你的名字"
git config user.email "你的GitHub邮箱（或 xxx@users.noreply.github.com）"
git commit --amend --reset-author --no-edit
git push -f origin main
```

---

## 4. 让仓库像个正经项目（网页上点几下）

- 仓库首页右上 **About** 齿轮：填 Description，例如
  `零依赖的 1v1 联机卡牌原型：8 套卡组、服务端权威、支持观战，规则与卡池可自行修改`
- Topics 建议：`card-game` `nodejs` `websocket` `multiplayer` `fan-made`
- **Settings → Actions → General**：确认 Workflow permissions 至少是 "Read and write"（CI 只读就够，保持默认也行）
- 想放个"下载即玩"的包：Releases → Draft a new release → 把整个文件夹压成 zip 传上去（这样别人不用 clone 也能玩）

---

## 5. 拉人一起改

两种方式，按关系选：

### A. 直接给写权限（几个人小圈子）

Settings → Collaborators → Add people → 输入对方 GitHub 用户名 → 邀请。
对方接受后就能直接 `git clone` + `git push`（建议仍然开分支，见 `CONTRIBUTING.md`）。

### B. 走 Fork + Pull Request（公开仓库推荐）

别人 fork → 在自己仓库里改 → 提 PR 回来。PR 会自动跑 `.github/workflows/test.yml`（4 条测试），绿了再合。

---

## 6. 以后日常提交

```bash
git status                 # 看改了什么
git add -A
git commit -m "cards: 削弱杏子 40/35 -> 35/30"
git push
```

改完卡池记得：

```bash
node test/export_cards.js   # 重新生成 卡表.md
npm test                    # 41 + 44 条断言 + 机器人 + 联机
```

---

## 常见问题

**push 报 `src refspec main does not match any`**
说明本地还没有提交或分支名不对，先 `git log --oneline` 确认有提交、`git branch --show-current` 确认是 `main`。

**push 报 `Authentication failed`**
凭证管理器没弹窗：手动执行 `git credential-manager configure`，或改用 PAT 当密码。

**推送卡在 `Writing objects: 100%` 很久**
83 MB 的 `node.exe` 在上传，等它。断网重来会从头传，尽量一次推完。

**不想再带 83 MB**
```bash
git rm --cached runtime/node.exe
echo runtime/ >> .gitignore
git commit -m "chore: 不再入库 runtime"
```
但这样别人 clone 后必须自己装 Node 才能双击 bat（`启动游戏.bat` 会回退到系统 `node`）。

**仓库已经推到一半失败，重新推**
`git push -u origin main` 再执行一次即可，已上传的对象不会重复传。

---

## 版权提醒

仓库是公开的，`LICENSE` 里已经写清：**代码 MIT，卡池角色名属于各自权利方，本项目是非商业同人二创**。
别人 fork 走也没关系，但请保留这段声明，别被拿去商用（尤其是别加付费、抽卡、广告）。
