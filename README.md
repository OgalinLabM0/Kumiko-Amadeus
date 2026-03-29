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

本项目的本地语义检索使用 `bge-m3` 的 ONNX 权重。

仓库里已经带着：

- `models/bge-m3-onnx/tokenizer.json`
- `models/bge-m3-onnx/tokenizer_config.json`

你需要额外补的只有：

- `models/bge-m3-onnx/model_int8.onnx`

如果你只是安装别人已经打好的 `Kumiko-Amadeus-Setup.exe`，通常不需要自己再单独下载模型；只有在“从源码自构建”或者“拿到的安装包本身缺资源”时，才需要手动补这个文件。

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
