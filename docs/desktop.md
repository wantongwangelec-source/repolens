# 桌面客户端

`packages/desktop` 用 Electron 把 RepoLens 封装成 macOS / Windows / Linux 应用。
界面、API、扫描逻辑和命令行版完全是同一套代码，桌面端只负责窗口、菜单、目录选择、
AI 设置和自动更新。

## 结构

```
Electron 主进程（src/main.ts）
├── 服务进程（utilityProcess，src/server-process.ts）
│   └── @repolens/server，监听 127.0.0.1 的随机端口
│       └── 扫描 worker（scan-worker.js）
└── 窗口：加载 http://127.0.0.1:<端口>/，preload 暴露 window.repolensDesktop
```

- **服务跑在独立进程里**：扫描大仓库时占满 CPU 也不会卡住窗口；服务崩溃会自动重启，
  一分钟内崩溃超过三次才停下报错。
- **访问令牌**：每次启动生成随机令牌，`/api/*` 没有令牌一律 401。窗口通过 httpOnly
  cookie 自动带上，本机其他程序和网页拿不到。
- **目录选择**：网页只发起请求，路径由主进程弹出系统对话框选出，页面无法指定任意路径。
- **配置共用**：服务地址、模型写在 `~/.config/repolens/config.json`，仓库列表在
  `~/.repolens/repos.json`，命令行和桌面端互相可见。
- **API Key**：设置里填的 key 用系统钥匙串（macOS Keychain、Windows DPAPI、
  Linux Secret Service / KWallet）加密后只存在桌面端自己的数据目录，不写进配置文件。
  它优先于环境变量里的同名 key。Linux 上没有可用的钥匙串服务时不允许在界面保存 key，
  只能用环境变量。
- **Key 只发给它所属的服务**：保存的 key 记着当时的服务地址（域名、协议、端口），
  在设置里换了服务就必须填新服务的 key，原来的 key 不再使用。配置里 key 的变量名也会
  改成 `REPOLENS_API_KEY`，免得命令行拿旧变量里的 key 去请求新地址。
  仓库里的 `.repolens.json` 不能修改服务地址和 key 变量名，打开陌生仓库不会把 key 发到别处。
- **环境变量**：从 Dock / 开始菜单启动时读不到 `~/.zshrc` 里 export 的变量，
  桌面端启动时会用登录 shell 读一遍（Windows 不需要）。所以命令行里配好的
  `OPENAI_API_KEY` 在桌面端直接可用。

## 开发

Electron 44 起 `pnpm install` 不再自动下载 Electron 本体，第一次要手动装一次：

```bash
pnpm install
pnpm --filter @repolens/desktop exec install-electron
pnpm desktop            # 全量构建后启动桌面端
```

只改了桌面端代码时，`pnpm --filter @repolens/desktop start` 更快（不重建其他包）。
前端改动仍然推荐用 `pnpm dev:web` 在浏览器里调，桌面端只是多一层壳。

`scripts/build.mjs` 用 esbuild 把主进程、preload、服务进程打成单个 CJS 文件放进
`packages/desktop/app/`。better-sqlite3 和两个 tree-sitter 包无法打进 bundle，
打安装包时会被复制进 `app/node_modules`。better-sqlite3 用的是 N-API 预编译二进制，
不需要针对 Electron 重新编译。

## 打包

```bash
pnpm dist:desktop                                  # 当前平台的安装包，输出到 packages/desktop/release/
pnpm --filter @repolens/desktop pack               # 只生成可运行的应用目录，不做安装包，快
```

| 平台 | 产物 | 架构 |
| --- | --- | --- |
| macOS | `.dmg`（安装）、`.zip`（自动更新用） | arm64、x64 |
| Windows | NSIS 安装程序 `.exe` | x64 |
| Linux | `.AppImage`、`.deb` | x64、arm64 |

只能在对应系统上打对应平台的包。macOS 一台机器能同时打 arm64 和 x64，
Linux 同理。三个平台一起打交给 GitHub Actions。

## 发布

1. 修改 `packages/desktop/package.json` 里的 `version`，提交。
2. 打同名标签并推送：

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

3. `.github/workflows/desktop-release.yml` 会先检查标签和版本号一致，再在三个平台上
   构建、测试、打包，上传到同名的 Release **草稿**。
4. 三个平台都成功后，workflow 会自动把这份 Release 改成公开。
   自动更新只看已发布的 Release，任一平台失败则保持草稿（或不创建公开版）。

在 Actions 页面手动运行这个 workflow 只打包不发布，安装包在本次运行的 Artifacts 里。

## 签名

目前三个平台都**没有配置签名证书**，用户首次打开时会看到系统警告（见下文）。

### macOS

没有证书时 `scripts/dist.mjs` 自动使用 ad-hoc 签名。Apple 芯片的 Mac 会把完全没有签名的
应用报告为“已损坏”，ad-hoc 签名后只是提示“无法验证开发者”，可以手动放行。

以后要启用 Developer ID 签名和公证：

1. 在 Apple Developer 后台创建 **Developer ID Application** 证书，导入钥匙串后导出为 `.p12`。
2. 在 GitHub 仓库的 Settings → Secrets and variables → Actions 里添加：

   | Secret | 内容 |
   | --- | --- |
   | `MAC_CERTIFICATE_P12_BASE64` | `base64 -i cert.p12` 的输出 |
   | `MAC_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设的密码 |
   | `APPLE_ID` | 开发者账号的 Apple ID |
   | `APPLE_APP_SPECIFIC_PASSWORD` | 在 appleid.apple.com 生成的 App 专用密码 |
   | `APPLE_TEAM_ID` | 开发者团队 ID |

   配齐后 electron-builder 会自动签名并提交公证，workflow 不用改。
3. 把 `src/updater.ts` 里的 `CAN_INSTALL` 改成对 macOS 也为 `true`：签名后的应用才能
   在后台下载并安装更新，现在 macOS 上只会提示用户去下载页。

本机打签名包：`CSC_NAME="Developer ID Application: 名字 (团队ID)" pnpm dist:desktop`。

### Windows

没有证书时 SmartScreen 会拦截。以后可以在 GitHub Secrets 里配 `WIN_CSC_LINK` /
`WIN_CSC_KEY_PASSWORD`（`.pfx` 证书），并在 workflow 的打包步骤里传进去；
使用 Azure Trusted Signing 等云签名服务需要另外配置 electron-builder 的 `win.azureSignOptions`。

## 用户首次打开

- **macOS**：打开 `.dmg`，把 RepoLens 拖进“应用程序”。第一次打开会提示无法验证开发者，
  到“系统设置 → 隐私与安全性”底部点“仍要打开”。
  也可以在终端执行 `xattr -dr com.apple.quarantine /Applications/RepoLens.app`。
  升级到新版本后，系统可能询问是否允许 RepoLens 访问钥匙串，选“始终允许”即可
  （未签名的应用每个版本的签名都不同，签名后不再出现）。
- **Windows**：安装时 SmartScreen 提示“Windows 已保护你的电脑”，点“更多信息 → 仍要运行”。
- **Linux**：AppImage 需要 `chmod +x RepoLens-*.AppImage` 后运行，Ubuntu 22.04 及以后
  可能要先 `sudo apt install libfuse2`。deb 包用 `sudo apt install ./RepoLens-*.deb` 安装。

## 自动更新

启动 10 秒后在后台检查 GitHub Releases，也可以从菜单“检查更新…”手动检查。

- Windows 和 Linux AppImage：后台下载，完成后询问是否重启安装。
- macOS：未签名的应用无法自动替换自身，只提示有新版本并打开下载页。
- Linux deb：不自动更新，需要重新下载安装。

## 数据和日志位置

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 桌面端状态（窗口位置、加密的 Key） | `~/Library/Application Support/RepoLens` | `%APPDATA%\RepoLens` | `~/.config/RepoLens` |
| 日志（`main.log`、`server.log`） | `~/Library/Logs/RepoLens` | `%APPDATA%\RepoLens\logs` | `~/.config/RepoLens/logs` |

菜单“帮助 → 打开日志文件夹”可以直接打开日志目录。和命令行共用的配置、仓库列表、
每个仓库下的 `.repolens/index.db` 见上文“结构”。

应用图标的源文件是 `packages/desktop/build/icon.svg`，改完后用
`rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png` 重新生成 `icon.png`。
网页标签页的图标 `packages/web/public/favicon.svg` 是同一个图形，记得一起改。
