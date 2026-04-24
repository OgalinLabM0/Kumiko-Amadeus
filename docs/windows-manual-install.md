# Windows 手动安装说明

这份文档只按当前主线来写，也就是 `PC 原生端 / Windows 桌面版`。

如果你已经拿到了对应架构的 `Kumiko-Amadeus-Setup-<arch>-<version>.exe`，可以直接装；如果你是从源码开始自己打包，再看后面的模型补充部分。

## 适用场景

- 你已经拿到了现成安装包，想手动安装，不依赖应用内自动更新。
- 你从 GitHub 拉了源码，准备自己在本地打包。
- 你想确认 ONNX 模型该放在哪里。

## 一、先选对正确的架构

本项目现在为 Windows 发布**两个独立安装包**：

| 架构 | 文件 | 典型机型 |
| --- | --- | --- |
| x64（绝大多数情况）| `Kumiko-Amadeus-Setup-x64-<version>.exe` | Intel、AMD 台式机 / 笔记本 |
| ARM64 | `Kumiko-Amadeus-Setup-arm64-<version>.exe` | Copilot+ PC、Surface Pro X / Pro 9 5G / Pro 11、Snapdragon X Elite 笔记本等 |

`<version>` 跟 `package.json` 里的版本号同步，比如 `2.14.0`，所以实际文件名会是 `Kumiko-Amadeus-Setup-x64-2.14.0.exe`。

怎么判断自己的机器？在 PowerShell 里跑：

```powershell
echo $env:PROCESSOR_ARCHITECTURE
```

- 输出 `AMD64` → 选 **Setup-x64-`<version>`.exe**
- 输出 `ARM64` → 选 **Setup-arm64-`<version>`.exe**

注：ARM64 Windows 能通过 x64 仿真层跑 x64 版安装器，但会损失性能，并且 RAG 里某些原生模块（如 `hnswlib-node`、`better-sqlite3`）在仿真层下比原生 ARM64 慢很多；**ARM 机器强烈建议装 ARM64 版本**。

应用内自动更新（electron-updater）会根据你当前运行的架构，自动拉取 `latest.yml`（x64）或 `latest-arm64.yml`（arm64）频道，互不串台，所以**装错架构一次，之后不会自动跳回另一边**。

## 二、直接安装现成 EXE

安装后主程序文件都叫 `Kumiko-Amadeus.exe`。以 x64 为例：

1. 双击 `Kumiko-Amadeus-Setup-x64-<version>.exe`（ARM64 用户换成 `Setup-arm64-<version>.exe`）。
2. Windows 如果弹出 UAC / 管理员确认，选择允许。
3. 按安装向导继续。这个安装器不是“一键静默安装”，可以手动改安装目录。
4. 安装完成后，从桌面快捷方式或开始菜单启动软件。

补充说明：

- 安装器可能会优先给出一个非系统盘目录，比如 `D:` 或 `E:`，这是当前安装脚本的默认行为之一，你可以按自己需要改回别的位置。
- 如果你拿到的是作者已经完整打好的安装包，**通常不需要**再额外手动下载 ONNX 模型。
- 本项目当前默认产物是安装器，不是官方便携绿色版；`win-unpacked` 更适合调试，不建议当成普通用户安装方式。

## 三、卸载时需要知道的事

- 卸载前最好先把程序彻底退出。
- 卸载流程里会询问你：是否同时删除聊天记录、语音文件和设置。
- 如果你选择删除，当前设备上的本地数据会一起被清掉。

## 四、从源码自己构建时，为什么还要补两套文件

GitHub 仓库目前**既不包含 ONNX 模型权重，也不包含角色资源**（立绘、铃声、图标、加密的世界书/剧情数据）。原因分别是：

- `model_int8.onnx`（约 568 MB）体积太大，不适合直接放进普通 Git 仓库。
- 角色资源是版权素材，不在源码仓库里托管，只能通过 GitHub Release 附件分发。

所以如果你是"从源码自己打包"，需要补两样东西：

| 类别 | 获取方式 | 放置位置 |
| --- | --- | --- |
| `model_int8.onnx` | 手动从 HuggingFace / 国内镜像下载（见下一节） | `models/bge-m3-onnx/model_int8.onnx` |
| 角色资源包 | `npm run fetch-assets`（自动下载并解压） | `public/` 和 `assets/` 下的若干子目录 |

仓库里已经有：

- `models/bge-m3-onnx/tokenizer.json`
- `models/bge-m3-onnx/tokenizer_config.json`

你还需要补的只有：

- `models/bge-m3-onnx/model_int8.onnx`
- 通过 `npm run fetch-assets` 拿到的角色资源包（约 135 MB）

## 五、模型下载链接

推荐优先使用官方源：

- 官方页面：<https://huggingface.co/Xenova/bge-m3/tree/main/onnx>
- 官方直链：<https://huggingface.co/Xenova/bge-m3/resolve/main/onnx/model_int8.onnx?download=true>

如果你在国内访问官方源比较慢，可以试这个镜像入口：

- 镜像页面：<https://hugging-face.cn/Xenova/bge-m3>
- 镜像直链：<https://hugging-face.cn/Xenova/bge-m3/resolve/main/onnx/model_int8.onnx?download=true>

说明：

- 当前项目实际使用的文件名就是 `model_int8.onnx`，这一点和上面的链接是对得上的。
- 这个文件大约是 `568 MB` 左右，下载时间会比较久。
- 镜像站不是项目方维护的官方服务，可用性和速度会受网络环境影响；如果镜像异常，以官方链接为准。

## 六、模型该放到哪里

### 1. 你是从源码自己构建

把下载好的文件放到项目根目录下这个位置：

```text
models/
  bge-m3-onnx/
    model_int8.onnx
    tokenizer.json
    tokenizer_config.json
```

放好之后再执行：

```bash
npm install
npm run fetch-assets          # 下载并解压 kumiko-assets.zip
npm run desktop:build
```

打包完成后，安装器会自动把模型和角色资源一起带进桌面程序。

### 2. 你已经安装好了软件，但拿到的包缺模型

这种情况不算正常，更推荐你直接换一个完整的安装包。

如果你确实要手动补，可以把模型放到安装目录下的：

```text
resources/models/bge-m3-onnx/model_int8.onnx
```

常见完整路径会类似：

```text
你的安装目录/resources/models/bge-m3-onnx/model_int8.onnx
```

比如你安装在 `D:\Kumiko-Amadeus`，那就是：

```text
D:\Kumiko-Amadeus\resources\models\bge-m3-onnx\model_int8.onnx
```

## 七、构建完成后你会得到什么

执行：

```bash
npm run desktop:build
```

完成后主要看 `release/` 目录，里面有这 5 个产物（自 v2.14.0 起 `differentialPackage: false`，不再生成 `.blockmap`）：

```text
release/
├── Kumiko-Amadeus-Setup-x64-<version>.exe    # x64 安装器（如 …-x64-2.14.0.exe）
├── Kumiko-Amadeus-Setup-arm64-<version>.exe  # ARM64 安装器
├── latest.yml                                 # x64 应用内自动更新频道
├── latest-arm64.yml                           # ARM64 应用内自动更新频道
└── kumiko-assets.zip                          # 附属资源包
```

x64 用户双击 `Setup-x64-<version>.exe`，ARM64 用户双击 `Setup-arm64-<version>.exe`。两个 `latest*.yml` 是给应用内 AutoUpdater 用的频道文件，发布时需要一并上传到 GitHub Release。

## 八、最简结论

- 普通用户先确认机型架构，再下载对应的 `Kumiko-Amadeus-Setup-x64-<version>.exe` 或 `Kumiko-Amadeus-Setup-arm64-<version>.exe`。通常直接安装就行，不需要自己单独处理模型和资源包。
- 只有"从源码自构建"时，才需要手动下载并放置 `model_int8.onnx`，并跑一次 `npm run fetch-assets` 把角色资源拉下来。
- 模型位置固定为 `models/bge-m3-onnx/model_int8.onnx`；角色资源由脚本自动解压到 `public/` 和 `assets/`。
