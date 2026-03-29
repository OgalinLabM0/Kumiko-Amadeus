# iOS（Capacitor）长期方案说明

目标：与社区常见栈一致（**Vite + React 主工程 + Capacitor 薄壳**），便于后续加 Android、再接 PC（Tauri）共用同一 `dist/`。

## 1. 仓库内已具备的内容

- `capacitor.config.ts`：`webDir` 指向 `dist`，包名可在 `appId` 中改为你的反向域名。
- `npm run build:cap`：使用 `vite build --base ./`，便于在 App 内加载静态资源（与默认 `npm run build` 的 `/` 基路径区分，避免线上部署习惯被破坏）。
- `.github/workflows/ios-cap-bootstrap.yml`：**无 Mac** 时在 GitHub 的 macOS _runner 上执行 `cap add ios` + `cap sync`，产出可提交的 `ios/`。

## 2. 无 Mac：首次生成 `ios/` 目录

1. 将本仓库推送到 **GitHub**（需启用 Actions）。
2. 打开 **Actions** → **iOS Capacitor bootstrap** → **Run workflow**。
3. 完成后在运行结果中下载 **Artifact `ios-project`**，解压得到 `ios/`。
4. 将 `ios/` 放到仓库根目录，**提交并推送**。之后团队可在任意系统上 `npm run build:cap && npx cap sync ios`（仅同步资源，不依赖本机 Xcode 生成工程目录）。

> 说明：Apple 仅提供 macOS 版 Xcode；`cap add ios` 必须在 macOS 上执行一次。云端 workflow 等价于「借用一次 Mac」。

## 3. 有 Mac 的本地流程（可选）

```bash
npm ci
npm run build:cap
npx cap add ios    # 仅首次
npx cap sync ios
npx cap open ios   # Xcode 签名、真机、Archive
```

## 4. 签名与上架（与工程无关的步骤）

- 注册 [Apple Developer](https://developer.apple.com/)（年费）。
- 在 Xcode 中为 App 配置 **Team、Bundle Identifier、签名**。
- 使用 **TestFlight** 或 **App Store Connect** 分发。

CI 侧可选用 **Codemagic**、**GitHub Actions**（macOS + `xcodebuild`）或 **Fastlane** 做归档与上传；将证书与 API Key 放在 **Secrets** 中，勿提交仓库。

## 5. 与后续 PC / Android 的衔接

| 阶段 | 做法 |
|------|------|
| iOS（当前） | Capacitor `ios/` + 同上构建链 |
| PC（后续） | 新建 Tauri 工程，加载同一 `dist/`（或 dev URL） |
| Android（最后） | `npx cap add android`，仍同步同一 `dist/` |

业务代码始终只在 **当前 Vite 项目**中维护。

## 6. 真机调试局域网 dev 服务（可选）

在 `capacitor.config.ts` 的 `server.url` 中填写电脑局域网 IP 与端口（如 `http://192.168.1.10:3000`），并视情况设置 `server.cleartext: true`；再 `npx cap sync ios`。生产包发布前应去掉 `server.url`，改回仅加载包内 `dist`。
