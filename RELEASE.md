# 发布指南 / Release Guide

把 dsh-sidebar 发布到 GitHub(含 .vsix 安装包)的全流程。

**现在的发布是 tag 驱动的**:本地打 tag → push → CI 自动跑测试、打包、建 Release。
手工产物不再需要上传,第 3 节末尾留给 CI 不可用时的兜底。

## 0. 发布前自查(每次都要过一遍)

- 只提交 **dsh-webview 这个文件夹** 里的内容。git 仓库必须建在 dsh-webview 内,
  不能建在上一级 `ds_harness` 目录 —— 上一级有交接文档、npm 缓存等私人文件。
- `test/` 不进 vsix(`.vscodeignore`);本地回滚点与手工备份(`*.bak`、
  `_restore_backup_*/`)、`.vsix` 都已在 `.gitignore` 里,别用 `git add -f` 把它们带上去。
- 你的 DeepSeek API key 存在 `~/.dsh` 和 GUI 的浏览器存储里,永远不会进入本项目。
- 提交前 `git status` 干净、`git log` 上没有误提交的凭据或机器路径。

## 1. 改版本号与 CHANGELOG(顺序不能颠倒)

1. 改 `package.json` 的 `version`。**这是版本号唯一的权威来源**:README 的安装示例、
   CHANGELOG 的标题、git tag、Release 名都跟它走。
2. 在 `CHANGELOG.md` **顶部**加一节,标题必须正好是 `## <version>`(例如 `## 0.6.3`)。
   CI 用 `awk` 从 CHANGELOG 抓这一节当 Release 正文:
   - 抓不到 → CI 报 `No CHANGELOG section found for <version>` 并失败;
   - 正文从下一个 `^## ` 开始截断,所以这一节要自带完整叙述(界面 / 修复 / 测试分段是惯例)。
3. 顺带核对文档里的数字:增删断言后,README(中英)与 `docs/ARCHITECTURE.md` 里
   "10 个套件共 N 项"要跟着改,各套件后面的分项计数(如"36 项")也要对齐。

## 2. 本地验证

```powershell
cd C:\Users\20906\Desktop\ds_harness\dsh-webview

# 语法(与 CI 同一份清单)
node --check extension.js; node --check src/protocol.js; node --check src/websocket.js
node --check webview/app.js; node --check webview/markdown.js

# 回归(11 个套件;jsdom 靠下面这个环境变量)
$env:DSH_CHECKOUT_NODE_MODULES = "$PWD\node_modules"
node test/respond-wire-verify.js
node test/session-list-filter-verify.js
node test/launch-flags-verify.js
node test/approval-card-verify.js
node test/attach-paste-verify.js
node test/live-sync-verify.js
node test/pill-menu-verify.js
node test/header-composer-verify.js
node test/blank-session-verify.js
node test/panel-fixes-verify.js
node test/spawn-verify.js
```

> ⚠️ `spawn-verify.js` 与 `launch-flags-verify.js` 会真的起子进程(带管道 stdio)。
> 在受限沙箱里会以 `spawn EPERM` 失败,那是**环境**限制不是代码问题:换一个能起子进程的
> 终端跑,或放宽权限后再跑。CI 的 Linux runner 没有这个限制。
> `real-launch-verify.js` 会拉真的 `dsh web`,属手动测试,不作 CI 门禁。

## 3. 打 tag 并推送(CI 自动发布)

```powershell
cd C:\Users\20906\Desktop\ds_harness\dsh-webview
git add .
git commit -m "release: v0.6.3 — <一句话说明>"
git tag v0.6.3
git push && git push --tags
```

push 时会弹浏览器让你登录 GitHub(Git Credential Manager,Git for Windows 自带);
若弹窗失败:github.com → Settings → Developer settings → Personal access tokens (classic)
→ 生成一个勾选 `repo` 的 token,登录时用户名填 moxingovo、密码粘贴 token。

推上去之后 `.github/workflows/release.yml` 会依次做:

1. 5 个文件的 `node --check`(只查随包发布的脚本,不查 `test/` —— 否则删掉一个测试文件
   会让 check 先失败、一个测试都没跑,v0.5.0 踩过);
2. `npm install --no-save jsdom`,再按固定清单跑 11 个套件;
3. `vsce package`(Linux runner 输出干净 UTF-8,所以**不需要** `fix-vsix.ps1`);
4. 上传 artifact;
5. 从 CHANGELOG 抓 `<tag 去掉 v>` 那一节当正文,先删同 tag 的旧 Release(重发安全),
   再用 `softprops/action-gh-release` 建/更新 Release 并挂上 `.vsix`。

只看进度、不发布:仓库页 **Actions → Build & Release VSIX → Run workflow**
(`workflow_dispatch`,只出 artifact,不建 Release)。

### 兜底:CI 不可用或要手工发

```powershell
npx @vscode/vsce package
pwsh -File test\fix-vsix.ps1        # Windows 必跑:vsce 会把 package.json 中文转成 GBK 乱码
code --install-extension dsh-webview-0.6.3.vsix
```

然后在仓库页 **Releases → Draft a new release** → 选/建 tag `v0.6.3` → 贴 CHANGELOG 那一节
→ 把 `.vsix` 拖进附件区 → **Publish release**。tag 名必须是 `v<version>`,否则用户按
版本号找不到包。

## 4. 仓库首页与上架

**About**(仓库页右侧齿轮改,上限 350 字符,当前中英双语约 334):改的时候保留
`Unofficial community extension` / `非官方社区扩展` 字样,并留意字符上限。

**Topics**:`ai-chat` `deepseek` `deepseek-harness` `dsh-plugin` `sidebar` `vscode`
`vscode-extension` `webview`(`dsh-plugin` 会被官方生态收录)。

**Social preview**:Settings → General → Social preview → 传 `media/demo-panel.png`。

上架 VS Code Marketplace(可选):

1. marketplace.visualstudio.com → GitHub 账号登录 → 创建 publisher;
2. github.com → Settings → Developer settings → PAT,勾选 **Marketplace → Manage**;
3. `package.json` 的 `publisher`(`local-dsh`)改成你的 publisher ID;
4. `npx @vscode/vsce login <publisher>` 粘 PAT,再 `npx @vscode/vsce publish`。

## 5. 版本线备忘

- `0.4.0`–`0.4.2` 是另一条 UI 重构线(已 merge,其 tag 与 release 保留);
- `0.5.0` 是旧 wire(DSH 0.1.0–0.1.5)的最后一版;
- `0.6.0` 起跟进 **DSH 0.1.6 Typert 网关**,两套 wire 互不兼容 —— 动协议层前先看
  [docs/protocol.md](docs/protocol.md)。
