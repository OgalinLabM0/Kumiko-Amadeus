# Windows 手动安装说明

这份文档只按当前主线来写，也就是 `PC 原生端 / Windows 桌面版`。

如果你已经拿到了 `Kumiko-Amadeus-Setup.exe`，可以直接装；如果你是从源码开始自己打包，再看后面的模型补充部分。

## 适用场景

- 你已经拿到了现成安装包，想手动安装，不依赖应用内自动更新。
- 你从 GitHub 拉了源码，准备自己在本地打包。
- 你想确认 ONNX 模型该放在哪里。

## 一、直接安装现成 EXE

当前项目默认生成的是 Windows 安装器：

- 安装器文件：`Kumiko-Amadeus-Setup.exe`
- 安装后主程序：`Kumiko-Amadeus.exe`

直接安装步骤：

1. 双击 `Kumiko-Amadeus-Setup.exe`。
2. Windows 如果弹出 UAC / 管理员确认，选择允许。
3. 按安装向导继续。这个安装器不是“一键静默安装”，可以手动改安装目录。
4. 安装完成后，从桌面快捷方式或开始菜单启动软件。

补充说明：

- 安装器可能会优先给出一个非系统盘目录，比如 `D:` 或 `E:`，这是当前安装脚本的默认行为之一，你可以按自己需要改回别的位置。
- 如果你拿到的是作者已经完整打好的安装包，**通常不需要**再额外手动下载 ONNX 模型。
- 本项目当前默认产物是安装器，不是官方便携绿色版；`win-unpacked` 更适合调试，不建议当成普通用户安装方式。

## 二、卸载时需要知道的事

- 卸载前最好先把程序彻底退出。
- 卸载流程里会询问你：是否同时删除聊天记录、语音文件和设置。
- 如果你选择删除，当前设备上的本地数据会一起被清掉。

## 三、从源码自己构建时，为什么还要补模型

GitHub 仓库目前没有直接提交 `model_int8.onnx`，原因很简单：

- 这个文件体积太大，不适合直接放进普通 Git 仓库。
- 但项目在本地记忆检索时又确实需要它。

所以如果你是“从源码自己打包”，你需要手动把这个文件补回项目目录。

仓库里已经有：

- `models/bge-m3-onnx/tokenizer.json`
- `models/bge-m3-onnx/tokenizer_config.json`

你还需要补的只有：

- `models/bge-m3-onnx/model_int8.onnx`

## 四、模型下载链接

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

## 五、模型该放到哪里

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
npm run desktop:build
```

打包完成后，安装器会自动把这个模型一起带进桌面程序。

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

## 六、构建完成后你会得到什么

执行：

```bash
npm run desktop:build
```

完成后主要看 `release/` 目录，当前默认安装器就是：

```text
release/Kumiko-Amadeus-Setup.exe
```

这就是可以直接双击安装的 Windows 包。

## 七、最简结论

- 普通用户如果已经拿到现成的 `Kumiko-Amadeus-Setup.exe`，通常直接安装就行，不需要自己单独处理模型。
- 只有“从源码自构建”时，才需要手动下载并放置 `model_int8.onnx`。
- 模型位置固定为 `models/bge-m3-onnx/model_int8.onnx`。
