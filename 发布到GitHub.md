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

## 1. 仓库已经建好并已推送

公开仓库：<https://github.com/Yukinooshita/sheng-bian-card-game>

本地 `origin` 已指向它，`main` 已推上去，提交作者已改成 `Yukinooshita`。
GitHub Actions 的 `tests` 工作流在首次推送和强推后各跑了一次，都是 ✅（41 + 44 条断言、机器人对局、联机 + 观战）。

> 首次推送踩到的坑：这台机器直连 `github.com` 会被限速掐断；开了加速器后，加速器会替换 TLS 证书，git 需要临时跳过校验。所以本机以后推送用：
>
> ```bash
> git -c http.sslVerify=false push
> ```
>
> 这只影响那一条命令，没有写进全局配置。

---

## 2. 日常提交

```bash
cd "C:\Users\jsf2026\Doubao\chats\2026-11-21\new-chat-1\升变卡牌"
git add -A
git commit -m "cards: 削弱杏子 40/35 -> 35/30"
git -c http.sslVerify=false push
```

改完卡池记得 `node test/export_cards.js` 重新生成 `卡表.md`，`npm test` 跑一遍。

### 走 SSH（想彻底摆脱证书问题）

本机已经生成好密钥 `C:\Users\jsf2026\.ssh\upvard_ed25519`，公钥还没加到账号：

1. 打开 <https://github.com/settings/ssh/new>，把 `C:\Users\jsf2026\.ssh\upvard_ed25519.pub` 的内容粘进去，标题随便（例如 `upvard-dev (Windows)`）。
2. 把远程换成 SSH，并强制走 443 端口（本机只有这个端口稳）：

```bash
git remote set-url origin git@github.com:Yukinooshita/sheng-bian-card-game.git
```

在 `C:\Users\jsf2026\.ssh\config` 里加：

```
Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile C:/Users/jsf2026/.ssh/upvard_ed25519
  IdentitiesOnly yes
```

`ssh -T git@github.com` 看到 `Hi Yukinooshita!` 就通了，之后直接 `git push`，不用再带任何参数。

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

**push 卡住 / 报 `Recv failure: Connection was reset` / `Operation timed out`**
这台机器到 `github.com` 的连接会被掐断：能连上、传几百 KB 就断。实测：
`api.github.com`、`codeload.github.com`、`raw.githubusercontent.com` 正常，`github.com` 超时，`ssh.github.com:443` 能连通。
解决办法：开加速器 / VPN 后再推（带 `-c http.sslVerify=false`），或走上面的 SSH 443 方案。

**大文件 / 运行时（已处理）**
`runtime/node.exe`（83 MB）**已经移出仓库**，历史也用 `git filter-branch --index-filter` 重写过，现在全新 clone 只有约 1 MB。
需要本地运行时：

- 双击 `启动游戏.bat`，它会自动调 `get-node.ps1` 下载（34 MB，一次）
- 或直接下 [Releases](https://github.com/Yukinooshita/sheng-bian-card-game/releases) 里的整合包，已内置运行时

> 注：GitHub 那边的仓库体积统计（32 MB 左右）要等平台自己回收不可达对象后才会降下来，新 clone 不受影响。

---

## 7. 发新版本（Release）

整合包已经发过 `v0.1.0`。改到值得发一版时：

1. 本地打包（在项目根目录，PowerShell）：

   ```powershell
   Compress-Archive -Path 启动游戏.bat,自测.bat,server.js,engine,public,runtime,README.md,使用说明.md,修改指南.md,卡表.md,LICENSE -DestinationPath "$pwd\sheng-bian-v0.2.0-win-x64.zip" -CompressionLevel Optimal
   ```

2. 打 tag 并推上去：

   ```bash
   git tag -a v0.2.0 -m "v0.2.0"
   git -c http.sslVerify=false push origin v0.2.0
   ```

3. 网页 Releases → Draft a new release → 选 `v0.2.0` → 填标题/说明 → 把 zip 拖进附件 → Publish。

**push 报 `src refspec main does not match any`**
先 `git log --oneline` 确认有提交、`git branch --show-current` 确认是 `main`。

**仓库已经推到一半失败，重新推**
`git push -u origin main` 再执行一次即可，已上传的对象不会重复传。

---

## 版权提醒

仓库是公开的，`LICENSE` 里已经写清：**代码 MIT，卡池角色名属于各自权利方，本项目是非商业同人二创**。
别人 fork 走也没关系，但请保留这段声明，别被拿去商用（尤其是别加付费、抽卡、广告）。
