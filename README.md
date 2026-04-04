# Kumiko·Amadeus

`Kumiko·Amadeus` 是一个以 Windows 桌面常驻为核心的久美子陪伴应用。

它更接近一款有聊天、语音、提醒、记忆和备份能力的桌面软件，而不是单纯把网页聊天页套进壳里。当前仓库也默认按 `PC 原生端` 维护，普通用户安装和使用时不需要额外关心浏览器推送那套配置。

## 项目定位

- 以桌面 IM 的形式去做陪伴体验，而不是只做一个问答框。
- 尽量把聊天记录、记忆检索、语音文件、备份和本地数据管理留在用户自己的电脑上。
- 目前主线是 `Electron + React + Vite` 的 Windows 桌面端。

## 目前已有的内容

- 桌面聊天界面，支持图片、引用回复、撤回、消息中心等常见交互。
- 语音消息、提醒、后台常驻和桌面通知。
- 本地长期记忆、RAG 检索和图谱化记忆整理。
- 本地备份、退出时自动 ZIP 备份、数据目录迁移。
- Windows 安装包、手动安装和 GitHub Release 更新分发。

## 安装方式

### 1. 直接安装现成 EXE

如果你已经拿到了 `Kumiko-Amadeus-Setup.exe`，直接双击安装即可。

这条路径不依赖 GitHub Release 自动更新流程，也不需要你先自己研究源码。详细步骤见：

- [`docs/windows-manual-install.md`](docs/windows-manual-install.md)

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

如果你只是安装别人已经打好的 `Kumiko-Amadeus-Setup.exe`，通常不需要自己再单独下载模型；只有在“从源码自构建”或者“拿到的安装包本身缺资源”时，才需要手动补这个文件。

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

生成 Windows 桌面安装产物：

```bash
npm run desktop:build
```

构建完成后，产物会输出到 `release/` 目录，当前默认安装器文件名为：

- `release/Kumiko-Amadeus-Setup.exe`

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

- Node.js 18+
- npm 9+
- Git

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
