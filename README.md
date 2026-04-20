# Kumiko·Amadeus

`Kumiko·Amadeus` 是一个以桌面常驻为核心的久美子陪伴应用。它更接近一款有聊天、语音、提醒、记忆和备份能力的桌面软件，而不是单纯把网页聊天页套进壳里。

## 这是什么 / What is this

- 桌面 IM 形式的陪伴体验，而不是只做一个问答框
- 聊天记录、记忆检索、语音文件、备份和本地数据全部留在你自己的电脑上
- 主线是 `Electron + React + Vite`，覆盖 Windows（x64 / ARM64）和 Linux（x64 / ARM64）
- 本地长期记忆 + RAG 检索（`bge-m3-onnx` + `hnswlib-node` + `better-sqlite3`）
- 语音消息、提醒、系统托盘、桌面通知、退出时自动 ZIP 备份

## 平台支持 / Platform Support

桌面端按以下矩阵发行，所有发行版共享同一套代码与功能：

| 操作系统 / OS | 架构 / Arch | 打包格式 / Format                   | 自动更新频道文件                   |
| ------------- | ----------- | ----------------------------------- | ---------------------------------- |
| Windows 10/11 | x64         | `Kumiko-Amadeus-Setup-x64.exe`      | `latest.yml`                       |
| Windows 10/11 | ARM64       | `Kumiko-Amadeus-Setup-arm64.exe`    | `latest-arm64.yml`                 |
| Linux (glibc) | x86_64      | `Kumiko-Amadeus-x86_64.AppImage`    | `latest-linux.yml`                 |
| Linux (glibc) | ARM64       | `Kumiko-Amadeus-arm64.AppImage`     | `latest-linux-arm64.yml`           |

目前 **不提供** 的平台：macOS、Linux deb/rpm/flatpak/snap、musl 发行版（Alpine 等）、Windows 32-bit。

### 系统要求 / System Requirements

| 项目 / Item       | Windows                                    | Linux (AppImage)                                              |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------- |
| 最低 OS           | Windows 10 1903 或更高                      | 主流 glibc 发行版（Ubuntu 20.04+ / Debian 11+ / Fedora 36+）  |
| CPU               | x64 或 ARM64                                | x86_64 或 aarch64                                             |
| 内存 / RAM        | ≥ 4 GB（RAG 建议 8 GB）                     | ≥ 4 GB（RAG 建议 8 GB）                                       |
| 硬盘 / Disk       | ≥ 2 GB                                     | ≥ 2 GB                                                        |
| 运行库 / Runtime  | 安装器自动配置                              | 需 `libfuse2`（多数发行版自带，Ubuntu 22.04+ 需 `apt install libfuse2`） |
| 可选：GPT-SoVITS  | 内置 `runtime\python.exe` 直接使用          | 需自备 Python 3.9–3.11 + 已安装 SoVITS 依赖（BYO Python）     |
| 可选：GPU 加速    | 取决于显卡（ONNX CPU 为默认）               | 同 Windows，ONNX 默认走 CPU                                   |

### Linux 特别说明 / Linux Notes

- **RAG 本地检索**：`bge-m3-onnx` 模型、`onnxruntime-node`、`hnswlib-node`、`better-sqlite3` 都随 AppImage 一起分发，首次启动即可用，无需自行 `node-gyp`。
- **用户数据目录**：按 XDG 规范落在 `$XDG_DATA_HOME/Kumiko-Amadeus`，未设置时默认 `~/.local/share/Kumiko-Amadeus`。可在设置里迁移到其他挂载点。
- **系统托盘**：使用 `StatusNotifierItem` 协议，部分极简桌面（i3、sway）需额外安装 `snixembed`、`libappindicator` 桥接才可见。
- **GPT-SoVITS（BYO Python）**：Linux 发行版 Python 差异较大，SoVITS **不随 AppImage 打包 Python 运行时**。使用时在设置里指定自己的 `python3` 解释器，并先按 [GPT-SoVITS 官方说明](https://github.com/RVC-Boss/GPT-SoVITS) 装好依赖。测试通过的解释器才会被授权启动子进程。
- **自动更新**：electron-updater 从 `latest-linux*.yml` 拉取更新信息后下载新 AppImage 覆盖安装；依赖 `AppImageLauncher` 或 `AppImageUpdate` 生态。

## 安装 / Install

每次发版在 GitHub Release 页面都有 9 个附件，但**普通用户只需下载 1 个对应自己 OS + 架构的安装包**。其余 8 个由应用自身或开发者工具链在后台消费，不用手动下。

| 文件                              | 用途                                         | 谁来下载                      |
| --------------------------------- | -------------------------------------------- | ----------------------------- |
| `Kumiko-Amadeus-Setup-x64.exe`    | Windows x64 安装器                           | Intel / AMD 设备用户 **手动**  |
| `Kumiko-Amadeus-Setup-arm64.exe`  | Windows ARM64 安装器                         | Snapdragon / Copilot+ PC **手动** |
| `Kumiko-Amadeus-x86_64.AppImage`  | Linux x64 AppImage                           | 绝大多数 Linux 用户 **手动**   |
| `Kumiko-Amadeus-arm64.AppImage`   | Linux ARM64 AppImage                         | 树莓派 / Jetson 等 **手动**     |
| `latest.yml` / `latest-arm64.yml` / `latest-linux.yml` / `latest-linux-arm64.yml` | 自动更新 channel file | 已装应用 electron-updater **后台自动拉** |
| `kumiko-assets.zip`               | 角色资产快照                                 | 从源码构建时 `npm run fetch-assets` **自动拉** |

installer / AppImage 已经**内置**所有角色立绘、铃声、ONNX 模型，是自包含的，双击安装 / `chmod +x` 即用，不需要再手动下 zip。

### Windows

架构识别：PowerShell 里 `echo $env:PROCESSOR_ARCHITECTURE`，输出 `AMD64` 选 `Setup-x64.exe`，输出 `ARM64` 选 `Setup-arm64.exe`。双击安装即可。详细步骤见 [docs/windows-manual-install.md](docs/windows-manual-install.md)。

### Linux

架构识别：`uname -m`，输出 `x86_64` 选 `-x86_64.AppImage`，输出 `aarch64` 选 `-arm64.AppImage`。

> 注：Linux 下 **x64 / amd64 / x86_64 是同一架构的不同叫法**。Windows 生态习惯叫 `x64`，Linux 生态习惯叫 `x86_64`，Intel/AMD 64 位桌面请认准 `-x86_64.AppImage`。

```bash
chmod +x Kumiko-Amadeus-x86_64.AppImage
./Kumiko-Amadeus-x86_64.AppImage

# 如果缺 FUSE：sudo apt install libfuse2   (Debian / Ubuntu)
#              sudo dnf install fuse-libs  (Fedora / RHEL)
```

希望应用出现在桌面 / 开始菜单，安装 [`AppImageLauncher`](https://github.com/TheAssassin/AppImageLauncher) 后首次运行会自动集成，它也会顺带处理自动更新。

## 发版 / Publishing

本仓库用 SemVer（`MAJOR.MINOR.PATCH`）管理版本；发版走 GitHub Actions，桌面两条通道各自 `workflow_dispatch` 手动触发后再完全自动化。**任何发版动作之前**必须先跑 `npm run check-assets` 做资产同步检查。

完整流程、回滚、常见陷阱都集中在 [docs/RELEASE.md](docs/RELEASE.md)；新 agent / 新开发者的 onboarding 从 [AGENTS.md](AGENTS.md) 开始读。

## 从源码构建 / Build from Source

### 前置要求 / Prerequisites

- Node.js 18+（推荐 20 LTS）、npm 9+、Git
- **Windows 构建**：Visual Studio 2019/2022 Build Tools（含 MSVC v143 + Windows SDK）+ Python 3.9–3.11（`node-gyp` 用）
- **Linux 构建**：`build-essential`、`python3`、`libfuse2`（运行 AppImage 时需要）
- **macOS**：未维护，如需自行尝试请准备 Xcode Command Line Tools

### 步骤 / Steps

1. **克隆仓库 / Clone**

   ```bash
   git clone https://github.com/OgalinLabM0/Kumiko-Amadeus.git
   cd Kumiko-Amadeus
   ```

2. **安装依赖 / Install**

   ```bash
   npm install
   ```

3. **拉取角色资源包 / Fetch character assets**

   ```bash
   npm run fetch-assets
   ```

   从 [GitHub Releases](https://github.com/OgalinLabM0/Kumiko-Amadeus/releases/latest) 下载 `kumiko-assets.zip`（约 135 MB）并解压到项目根目录。幂等：已有资源时自动跳过。换源：`ASSETS_URL=https://example.com/kumiko-assets.zip npm run fetch-assets`。

4. **补 ONNX 模型 / Add ONNX model**

   仓库里已带分词器文件：

   ```
   models/bge-m3-onnx/tokenizer.json
   models/bge-m3-onnx/tokenizer_config.json
   ```

   缺的是权重，下载到 `models/bge-m3-onnx/model_int8.onnx`：

   - 官方直链：<https://huggingface.co/Xenova/bge-m3/resolve/main/onnx/model_int8.onnx?download=true>
   - 国内镜像：<https://hugging-face.cn/Xenova/bge-m3/resolve/main/onnx/model_int8.onnx?download=true>

   或者用辅助脚本一条命令搞定：`node scripts/fetch-bge-model.cjs`。

   安装器（Setup.exe / AppImage）里已经内置这个模型，**只在从源码构建时**需要补。

5. **配置环境变量 / Configure environment**

   ```bash
   cp .env.example .env
   # 编辑 .env 填入 API Key（必需）+ 其他可选配置
   ```

6. **开发模式 / Dev mode**

   ```bash
   npm run desktop:dev
   ```

   同时启动 Vite 开发服务器 + Electron 窗口，带热重载。

7. **构建安装包 / Build installer**

   ```bash
   npm run desktop:build
   ```

   构建产物在 `release/` 下，Windows 主机产出两个 `Setup-<arch>.exe`，Linux 主机产出两个 `.AppImage`。**Linux AppImage 必须在 Linux 主机（或 WSL2 / CI）上构建**，`hnswlib-node` 无 Linux 预编译、必须本地 `node-gyp` 重编译，Windows 工具链不能跨编译到 Linux。

### 缺少资源包 / 模型时的行为

如果没跑 `fetch-assets`、没补 `model_int8.onnx`：

- 情绪立绘显示为文字占位符
- 铃声使用系统默认提示音
- 来电界面头像显示为「久」字
- 世界书为空（人格设定保留，但没有高中回忆）
- 剧情记忆为空
- RAG 检索无法启动（缺模型）

## 云端构建 / Cloud Build (GitHub Actions)

没有本地 Linux / Windows 设备时，可以在 GitHub Actions 上跑云端构建。仓库内置两条 workflow：

| Workflow | 产物 |
| --- | --- |
| [`.github/workflows/linux-appimage.yml`](.github/workflows/linux-appimage.yml) | Linux x64 + ARM64 AppImage、`latest-linux*.yml`、`kumiko-assets.zip` |
| [`.github/workflows/windows-release.yml`](.github/workflows/windows-release.yml) | Windows x64 + ARM64 NSIS installer、`latest.yml` / `latest-arm64.yml` |

### 如何触发

1. 仓库页 → `Actions` → 左侧选对应 workflow → 右侧 `Run workflow`
2. 选择 `publish`：
   - `publish=false`（默认）：产物作为 workflow artifact 上传 + 跑 smoke test，**不动任何 GitHub Release**。用于首次编译验证。
   - `publish=true`：附加跑 `electron-builder --publish always`，把产物直接追加到 `package.json#version` 对应的 GitHub Release（`releaseType: release`，不存在则自动新建并直接以 non-draft 状态发布，GitHub 会把最高 semver 自动标记为 `latest`）。用于实际发版。

两条 workflow 都是 15–30 分钟完成；ARM64 因为要本地 `node-gyp`，比 x64 慢一些。

### `publish=true` 前需要的配置

| 选项 | 做什么 | 说明 |
| --- | --- | --- |
| 自建 PAT | Settings → Secrets → Actions → `GH_TOKEN` = 你的 classic PAT（勾 `repo` scope） | **推荐**，workflow 优先用 `GH_TOKEN` |
| 什么都不配 | 回退到 Actions 内置 `GITHUB_TOKEN` | 只能发布到**当前仓库**的 release，`permissions: contents: write` 已内置 |

### Artifact 命名

- `kumiko-amadeus-linux-x64.zip` / `kumiko-amadeus-linux-arm64.zip`
- `kumiko-amadeus-windows-x64.zip` / `kumiko-amadeus-windows-arm64.zip`

Artifact 默认保留 14 天。实际发版的权威产物在 GitHub Release 页。

## 其他说明

- API Key 在软件内设置页配置即可
- 本地记忆数据库保存在 Electron 用户数据目录（Windows: `%APPDATA%/Kumiko-Amadeus`，Linux: `$XDG_DATA_HOME/Kumiko-Amadeus`）
- [`ping-server/`](ping-server/README.md) 是浏览器 Web Push 的本地测试工具，仅开发用途；不要把私钥提交进仓库

---

## 版权声明 / Copyright & Legal Notice

本项目为非商业同人作品（Fan Work），基于武田绫乃原作小说《吹响吧！上低音号》
（響け！ユーフォニアム）及京都动画（Kyoto Animation）制作的同名动画系列。

This project is a non-commercial fan work based on the novel series
"Hibike! Euphonium" (Sound! Euphonium) by Ayano Takeda and the anime
series produced by Kyoto Animation Co., Ltd.

### 权利归属 / Attribution

- 原作小说 / Original Novel：© 武田绫乃 / 宝岛社 (Takarajimasha)
- 动画作品 / Anime Series：© 武田绫乃・宝岛社／『响け！』制作委员会
- 角色设计 / Character Design：© 京都アニメーション (Kyoto Animation)
- 本项目中使用的角色名称、剧情设定均为上述权利人所有。
  All character names and story settings used in this project belong to the above rights holders.

### 免责声明 / Disclaimer

- 本项目不以任何形式获取商业利益。
  This project does not generate any commercial profit in any form.
- 本项目不代表原作者或版权方的官方立场。
  This project does not represent the official position of the original authors or rights holders.
- 本项目中的角色行为、对话均为 AI 生成的同人创作，与原作无关。
  All character behaviors and dialogues in this project are AI-generated fan creations, unrelated to the original work.
- 如权利方提出异议，将立即配合处理。
  If the rights holders raise any objections, we will immediately comply and take appropriate action.
- 项目源码本身（不含角色资产）采用 MIT 许可证。
  The project source code itself (excluding character assets) is licensed under MIT.

### 角色资产声明 / Character Assets

本仓库的源代码不包含任何版权素材。角色立绘、语音铃声、剧情数据等资产文件通过独立的资源包分发，仅供个人学习交流使用，禁止商业用途。

All character-specific assets (artwork, voice ringtones, story data) are distributed separately and are NOT included in this repository's source code. They are provided solely for personal, non-commercial, educational use. Commercial use is strictly prohibited.
