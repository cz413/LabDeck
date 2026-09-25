# LabDeck

LabDeck 是一款本地优先的 Windows 桌面应用，用来管理实验室 Linux 服务器、SSH 会话和 GPU 资源。它直接从当前电脑连接服务器，无需部署中心服务。

> 当前版本：0.6.13。项目仍在开发中，尚未提供自动更新或签名安装包。

## 主要功能

- 管理服务器、分组、标签和多条连接路径，支持直连与单级跳板机。
- 从本机 SSH Config 导入连接；首次连接时核对主机指纹。
- 在应用内使用本地 PowerShell 和跨服务器 SSH 终端会话；切换页面时连接继续运行，关闭会话或退出应用时断开。SFTP 在独立窗口传输文件。
- 按手动、按需或持续策略采集 CPU、内存、磁盘和 NVIDIA GPU 指标，查看 GPU 进程与历史曲线。
- 从服务器卡片打开 VS Code Remote-SSH；提供演示节点和三套界面主题。

## 环境要求

- Windows 10/11 x64
- Node.js 22 与 npm 11（从源码运行或构建时）
- 真实服务器需要 SSH 服务；GPU 指标需要服务器安装 `nvidia-smi`
- SSH Config 导入需要 Windows OpenSSH Client；VS Code 入口需要 VS Code 和 Remote - SSH 扩展

## 从源码运行

```powershell
git clone https://github.com/cz413/LabDeck.git
cd LabDeck
npm ci
npm run dev
```

首次启动会显示演示节点。添加真实服务器或导入 SSH Config 后，可在服务器卡片选择连接路径并打开终端。导入操作不会复制私钥或密码；真实服务器默认不会在启动时自动建立 SSH 连接。

## 检查与打包

```powershell
npm test
npm run typecheck
npm run build
npm run dist
```

`npm run build` 将应用构建到 `out/`；`npm run dist` 使用 electron-builder 在 `release/` 生成 Windows 安装版和便携版。`out/`、`release/`、本地测试数据和环境文件不会提交到仓库。

## 数据与安全

应用数据保存在 Electron 的 `userData` 目录。密码和私钥口令通过 Electron `safeStorage` 使用 Windows 的加密能力保存；服务器信息、监控快照和 GPU 历史保存在本地。首次 SSH 连接的主机指纹应通过可信渠道核对。

LabDeck 使用个人账号的 SSH 权限访问服务器。服务器上的 Linux、SSH 和文件权限仍决定实际可执行的操作。应用退出后，本地监控会停止。

## VS Code 集成

LabDeck 会查找当前 Windows 用户安装、系统安装或 PATH 中的 VS Code（含 Insiders）；自定义位置可通过 `VSCODE_PATH` 指向 `Code.exe`、`Code - Insiders.exe` 或相应的 `code.cmd`。启动前会检查 Remote - SSH 扩展，并在当前用户的 `~/.ssh/config` 中引用 LabDeck 维护的主机配置。该配置不包含密码或私钥内容。若 VS Code 的 `remote.SSH.configFile` 设置为其他文件，需要让该文件包含 LabDeck 的配置，或恢复使用默认 SSH config。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `src/main/` | Electron 主进程、SSH/SFTP、监控和本地存储 |
| `src/preload/` | 受限 IPC 桥接 |
| `src/renderer/` | React 界面 |
| `src/shared/` | 共享类型、校验和连接路径逻辑 |
| `resources/` | 应用图标 |
