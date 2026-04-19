# Kumiko·Amadeus

`Kumiko·Amadeus` 是一个以桌面常驻为核心的久美子陪伴应用。

它更接近一款有聊天、语音、提醒、记忆和备份能力的桌面软件，而不是单纯把网页聊天页套进壳里。当前仓库也默认按 `PC 原生端` 维护，普通用户安装和使用时不需要额外关心浏览器推送那套配置。

## 项目定位

- 以桌面 IM 的形式去做陪伴体验，而不是只做一个问答框。
- 尽量把聊天记录、记忆检索、语音文件、备份和本地数据管理留在用户自己的电脑上。
- 主线是 `Electron + React + Vite`，优先覆盖 Windows 桌面端，并提供 Linux AppImage 作为等价发行通道。

## 目前已有的内容

- 桌面聊天界面，支持图片、引用回复、撤回、消息中心等常见交互。
- 语音消息、提醒、后台常驻和桌面通知。
- 本地长期记忆、RAG 检索和图谱化记忆整理。
- 本地备份、退出时自动 ZIP 备份、数据目录迁移。
- Windows 安装包、Linux AppImage、手动安装和 GitHub Release 更新分发。

## 平台支持 / Platform Support

桌面端按以下矩阵发行，所有发行版共享同一套代码与功能（对应功能对同一主版本号等同可用）：

| 操作系统 / OS | 架构 / Arch | 打包格式 / Format                   | 自动更新频道文件                   | 状态 / Status                |
| ------------- | ----------- | ----------------------------------- | ---------------------------------- | ---------------------------- |
| Windows 10/11 | x64         | `Kumiko-Amadeus-Setup-x64.exe`      | `latest.yml`                       | 已发布 / Released            |
| Windows 10/11 | ARM64       | `Kumiko-Amadeus-Setup-arm64.exe`    | `latest-arm64.yml`                 | 已发布 / Released            |
| Linux (glibc) | x64         | `Kumiko-Amadeus-x64.AppImage`       | `latest-linux.yml`                 | 已适配，待发布验证 / Ready    |
| Linux (glibc) | ARM64       | `Kumiko-Amadeus-arm64.AppImage`     | `latest-linux-arm64.yml`           | 已适配，待发布验证 / Ready    |

目前 **不提供** 的平台/格式：macOS、Linux deb/rpm/flatpak/snap、musl 发行版（Alpine 等）、Windows 32-bit。如果后续收到稳定的需求可以再开分支适配，但不在当前主线计划里。

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

- **RAG 本地检索：** `bge-m3-onnx` 模型、`onnxruntime-node`、`hnswlib-node`、`better-sqlite3` 都随 AppImage 一起分发，首次启动即可用。AppImage 内嵌 glibc 版原生模块，无需自行 `node-gyp`。
- **用户数据目录：** 按 XDG 规范落在 `$XDG_DATA_HOME/Kumiko-Amadeus`，未设置时默认 `~/.local/share/Kumiko-Amadeus`。可在设置里继续迁移到其他挂载点。
- **系统托盘：** 使用 `StatusNotifierItem` 协议，部分极简桌面（i3、sway）需额外安装 `snixembed`、`libappindicator` 之类的桥接才可见。
- **GPT-SoVITS（BYO Python）：** 由于 Linux 发行版 Python 版本差异较大，SoVITS **不随 AppImage 打包 Python 运行时**。需要使用时在设置里额外指定自己的 `python3` 解释器，并先按 [GPT-SoVITS 官方说明](https://github.com/RVC-Boss/GPT-SoVITS) 装好依赖。应用会在设置里提供"浏览解释器 → 测试"按钮，测试通过的解释器才会被授权启动子进程。
- **自动更新：** electron-updater 从 `latest-linux.yml` / `latest-linux-arm64.yml` 拉取更新信息，然后下载新的 AppImage 覆盖安装；自动更新依赖 AppImage 的 `appimagelauncher` 或 `AppImageUpdate` 生态。

## 安装方式

### 1. 直接安装现成安装包

**Windows** — 按 CPU 架构分两份：

- Intel / AMD 设备（绝大多数情况）：`Kumiko-Amadeus-Setup-x64.exe`
- Snapdragon / Copilot+ PC 等 ARM64 设备：`Kumiko-Amadeus-Setup-arm64.exe`

不确定自己是哪种？在 PowerShell 里跑 `echo $env:PROCESSOR_ARCHITECTURE`，输出 `AMD64` 选 x64，输出 `ARM64` 选 arm64。

拿到对应的 `Kumiko-Amadeus-Setup-<arch>.exe` 双击即可安装。这条路径不依赖 GitHub Release 自动更新流程，也不需要你先自己研究源码。详细步骤见：

- [`docs/windows-manual-install.md`](docs/windows-manual-install.md)

**Linux** — 按 CPU 架构分两份：

- 主流 Intel / AMD x86_64 设备：`Kumiko-Amadeus-x64.AppImage`
- 国产 / 树莓派 / Jetson 等 aarch64 设备：`Kumiko-Amadeus-arm64.AppImage`

不确定自己是哪种？在终端里跑 `uname -m`，输出 `x86_64` 选 `x64`，输出 `aarch64` 选 `arm64`。

下载到本地后赋予执行权限即可启动：

```bash
chmod +x Kumiko-Amadeus-x64.AppImage
./Kumiko-Amadeus-x64.AppImage

# 如果系统缺少 FUSE：sudo apt install libfuse2  (Debian / Ubuntu)
# 或：                sudo dnf install fuse-libs (Fedora / RHEL)
```

如果希望应用出现在桌面/开始菜单，安装 [`AppImageLauncher`](https://github.com/TheAssassin/AppImageLauncher) 后首次运行 AppImage 会自动集成；它也会顺带处理 electron-updater 的自动更新。

### 2. 从源码自己构建

当前仓库**默认不包含**大体积的 ONNX 权重文件 `models/bge-m3-onnx/model_int8.onnx`，所以如果你是从源码开始自己打包，先要把模型下载到指定目录，再执行构建。

需要补的文件、下载链接和放置位置，同样写在：

- [`docs/windows-manual-install.md`](docs/windows-manual-install.md)

## ONNX 模型说明

本项目的本地语义检索使用 `bge-m3-onnx` 目录下的 ONNX 权重。

仓库里已经带着：

- `models/bge-m3-onnx/tokenizer.json`
- `models/bge-m3-onnx/tokenizer_config.json`

你需要额外补的只有：

- `models/bge-m3-onnx/model_int8.onnx`

如果你只是安装别人已经打好的 `Kumiko-Amadeus-Setup-x64.exe` / `Kumiko-Amadeus-Setup-arm64.exe`，通常不需要自己再单独下载模型；只有在“从源码自构建”或者“拿到的安装包本身缺资源”时，才需要手动补这个文件。

下载入口：

- 官方页面：<https://huggingface.co/Xenova/bge-m3/tree/main/onnx>
- 官方直链：<https://huggingface.co/Xenova/bge-m3/resolve/main/onnx/model_int8.onnx?download=true>
- 国内镜像页面：<https://hugging-face.cn/Xenova/bge-m3>
- 国内镜像直链：<https://hugging-face.cn/Xenova/bge-m3/resolve/main/onnx/model_int8.onnx?download=true>

更详细的放置位置和安装说明见：

- [`docs/windows-manual-install.md`](docs/windows-manual-install.md)

## 开发

前提：

- Node.js
- npm

安装依赖：

```bash
npm install
```

启动桌面开发模式：

```bash
npm run desktop:dev
```

这会先启动 Vite 开发服务器，再由 Electron 加载桌面窗口。

## 构建

### Windows 构建

在 Windows 主机（x64 或 ARM64）上直接跑：

```bash
npm run desktop:build
```

构建完成后，产物会输出到 `release/` 目录。默认会同时打两套架构：

- `release/Kumiko-Amadeus-Setup-x64.exe` + `.blockmap`
- `release/Kumiko-Amadeus-Setup-arm64.exe` + `.blockmap`
- `release/latest.yml`（给 x64 应用内自动更新用）
- `release/latest-arm64.yml`（给 ARM64 应用内自动更新用）
- `release/kumiko-assets.zip`（角色资源包）

### Linux 构建

**Linux AppImage 必须在 Linux 主机（或 WSL2、CI 容器）上构建**，因为 `hnswlib-node` 无 Linux 预编译、必须 `node-gyp` 本地重编译。Windows 原生工具链不能跨编译到 Linux。

准备工作（以 Ubuntu 22.04+ 为例）：

```bash
sudo apt update
sudo apt install -y build-essential python3 python3-pip libfuse2 git
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

然后在克隆好的仓库里：

```bash
npm install
npm run build                                        # 前端产物
npx electron-builder --linux AppImage --x64 --arm64 --publish never
node scripts/generate-latest-yml.cjs                 # 生成 latest-linux*.yml
node scripts/package-assets.cjs                      # 可选：生成 kumiko-assets.zip
node scripts/clean-release.cjs postbuild             # 清掉打包中间产物
```

或者直接跑一键脚本（与 Windows 主机使用同一条命令，electron-builder 会自动按当前主机平台挑 target）：

```bash
npm run desktop:build
```

产物会在 `release/` 下：

- `release/Kumiko-Amadeus-x64.AppImage`
- `release/Kumiko-Amadeus-arm64.AppImage`
- `release/latest-linux.yml`
- `release/latest-linux-arm64.yml`
- `release/kumiko-assets.zip`

> **已知限制：** 当前没有官方的 deb / rpm / flatpak / snap。AppImage 是自包含的绿色程序，能覆盖绝大多数 glibc 发行版；如需额外格式欢迎在 Issue 里反馈。

### 云端构建 / Cloud Build (GitHub Actions)

没有本地 Linux 设备时，可以在 GitHub Actions 上跑云端 Linux 构建。仓库已内置工作流 [`.github/workflows/linux-appimage.yml`](.github/workflows/linux-appimage.yml)，同时产出 x64 和 arm64 的 AppImage，`hnswlib-node` 的 `node-gyp` 编译也是在 Linux runner 上完成。

**如何触发：**

1. GitHub 仓库页 → `Actions` → 左侧列表里选 `Linux AppImage build` → 右侧 `Run workflow`
2. 根据需要选择 `publish`：
   - `publish=false`（默认）：只把产物作为 workflow artifact 上传，**不改动任何 GitHub Release**。适合首次验证编译。
   - `publish=true`：在产物上传到 artifact 的基础上，额外调用 `electron-builder --publish always`，把 AppImage + `latest-linux*.yml` 追加到 `package.json` 里 `version` 对应的 Release（若没有会自动建 draft）。**适合确认编译通过后发布给用户试用。**
3. 点 `Run workflow` 按钮启动，通常 15–25 分钟完成（arm64 因为要在 arm runner 上 node-gyp 重编译，稍慢于 x64）。

**如何下载 artifact：**

在该次 workflow run 详情页底部 `Artifacts` 区下载：

- `kumiko-amadeus-linux-x64.zip` → 里面是 `Kumiko-Amadeus-x64.AppImage` + `latest-linux.yml`
- `kumiko-amadeus-linux-arm64.zip` → 里面是 `Kumiko-Amadeus-arm64.AppImage` + `latest-linux-arm64.yml`

Artifact 默认保留 14 天。

**`publish=true` 前需要的配置：**

| 选项 | 做什么 | 说明 |
| --- | --- | --- |
| 用项目自身的 PAT | Settings → Secrets and variables → Actions → `New repository secret`：`Name=GH_TOKEN`，`Value=` 你创建的 Personal Access Token（classic，勾 `repo` scope） | **推荐做法**，工作流优先用 `GH_TOKEN` |
| 什么都不配 | workflow 会自动回退到 GitHub Actions 内置的 `GITHUB_TOKEN` | 只能发布到**当前仓库**的 release；`permissions: contents: write` 已内置，无需手动勾 |

**已知风险（第一次跑请留意 log）：**

- `hnswlib-node` node-gyp 失败（`gyp ERR!` / `fatal error`）：多数情况是 `build-essential` 版本问题，可试把 matrix 的 runner 改回 `ubuntu-22.04`。
- arm64 runner 不可用：部分老账号 / 私仓暂未开放 `ubuntu-24.04-arm`；回退方法是在 matrix 里去掉 arm64 一行，只发 x64。
- HuggingFace 拉模型超时：脚本会自动切 `hugging-face.cn` 镜像，极少数情况下重跑一次就过。
- `publish=true` 时 electron-builder 报 `Cannot find credentials`：说明 `GH_TOKEN` 没配好，检查 secrets 设置。

## 其他说明

- API Key 在软件内设置页配置即可。
- 本地记忆数据库保存在 Electron 的用户数据目录中。
- 浏览器 Web Push 相关内容目前只保留给开发/测试用途，不是桌面端主流程。
- 如果你确实要用浏览器侧本地推送测试，请参考 `ping-server/README.md`，并且不要把私钥提交进仓库。

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

---

## 从源码构建 / Build from Source

### 前置要求 / Prerequisites

- Node.js 18+（推荐 20 LTS）
- npm 9+
- Git
- **Windows 构建额外项：** Visual Studio 2019/2022 Build Tools（安装"使用 C++ 的桌面开发"工作负载，含 MSVC v143、Windows SDK）+ Python 3.9–3.11（用于 `node-gyp`）
- **Linux 构建额外项：** `build-essential`（gcc / make）、`python3`、`libfuse2`（跑 AppImage 时需要）
- **macOS**：暂未维护，如需手动尝试请自行准备 Xcode Command Line Tools。

### 步骤 / Steps

1. **克隆仓库 / Clone**

   ```bash
   git clone https://github.com/xxx/kumiko-amadeus.git
   cd kumiko-amadeus
   ```

2. **安装依赖 / Install dependencies**

   ```bash
   npm install
   ```

3. **下载角色资源包 / Download character asset pack**

   从 [GitHub Releases](https://github.com/xxx/kumiko-amadeus/releases) 下载最新的 `kumiko-assets.zip`。

   解压到项目根目录（会自动放入正确的子目录）：

   ```bash
   # Windows (PowerShell)
   Expand-Archive kumiko-assets.zip -DestinationPath . -Force

   # macOS / Linux
   unzip -o kumiko-assets.zip -d .
   ```

   解压后目录结构应为：

   ```
   项目根目录/
   ├── public/
   │   ├── images/
   │   │   ├── emotions/    ← 17张 .png 情绪立绘
   │   │   └── logo.png     ← 应用 logo
   │   ├── ringtones/       ← 01.mp3 ~ 08.mp3 来电铃声
   │   ├── CCA-P2.png       ← 来电界面头像
   │   └── favicon-KA.ico   ← 应用图标
   └── assets/
       ├── worldbook.enc    ← 世界书数据（加密）
       └── lore.enc         ← 剧情记忆数据（加密）
   ```

4. **配置环境变量 / Configure environment**

   ```bash
   cp .env.example .env
   ```

   编辑 `.env`，填入你的 API Key（必需）和其他可选配置。

5. **开发模式运行 / Dev mode**

   ```bash
   npm run dev          # 启动 Vite 开发服务器
   npm run electron     # 启动 Electron（另一个终端）
   ```

6. **构建安装包 / Build installer**

   ```bash
   npm run desktop:build
   ```

   构建产物在 `release/` 目录下。

### 缺少资源包时的行为 / Behavior without asset pack

如果未放置资源包，应用仍可正常启动和运行，但：

- 情绪立绘显示为默认文字占位符
- 铃声使用系统默认提示音
- 来电界面头像显示为「久」字
- 世界书为空（久美子没有高中回忆，仅保留人格设定）
- 剧情记忆为空（无法回忆具体高中剧情细节）
- 应用图标使用通用占位图标
