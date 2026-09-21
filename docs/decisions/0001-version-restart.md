# 决策0001：从0.0.0重新起步并保留原仓库

状态：源码版本与更新保护已实施；安装迁移和正式发行待验证。2026-09-12。

用户希望版本从0.0.0开始，继续使用 https://github.com/OgalinLabM0/Kumiko-Amadeus。保留Git历史、旧release/tag、应用身份、签名和用户数据。

## 已实施的源码改动

- package.json版本设0.0.0，package-lock顶层和根包同步。
- Android显示versionName=0.0.0，但内部versionCode必须大于旧21431；使用21432。
- 在package.json单独维护androidVersionCode，CI读取并验证安全整数及范围；Gradle同步。禁止再从0.0.0直接算出0。
- 0.x重建线在桌面与Android更新检查中忽略旧2.x。桌面还在更新事件、下载和安装入口拦截，自动下载与退出自动安装保持关闭；新的0.x更新继续允许。未来进入新2.x之前必须重新设计这条边界。
- 不改Electron appId、Android applicationId、数据路径和签名证书。
- 不设置allowDowngrade来强迫旧客户端降级。

Android内部版本码和展示版本名可以独立，版本码必须递增。[Android官方说明](https://developer.android.com/studio/publish/versioning)

## 同仓库的更新问题

当前electron-updater GitHubProvider先读取仓库Latest，再从该release取更新元数据；只改channel文件名不能让它跳过旧Latest。

未来每次0.x发行必须先齐备安装器、更新元数据与kumiko-assets.zip，再显式设为Latest。不能依赖自动语义版本选择，因为旧2.x在数值上更高。[GitHub发行说明](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository#creating-a-release)

旧2.x客户端不应自动降到0.x；首次迁移可能需要用户手动安装同身份/同签名的新版本，并做数据保留验收。未来0.x之间再正常更新。发布前还要确认v0.0.0 tag是否已存在。

## 尚需验证

本地版本一致性、CI编号边界与更新保护模拟已验证。发行前仍需验证：同签名Android覆盖安装保留数据、桌面手动跨版本安装保留数据、真实GitHub Latest与完整安装资产、fetch-assets行为。

版本元数据预检与TypeScript检查已通过；更新器回归结果和暂停接续以 [当前状态](../worklog/CURRENT.md) 为准。没有构建/发布0.0.0安装器，也没有改动远端Latest。
