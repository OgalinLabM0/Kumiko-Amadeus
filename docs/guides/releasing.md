# 发布指南

状态：重建期间的当前规则。0.0.0源码版本与旧2.x更新保护已实施，安装迁移待真机验证；本轮不发布。

1. 每次发布先读 [版本重启决策](../decisions/0001-version-restart.md)，保证显示版本、Android内部序号与更新行为一致。
2. 任一正式发行或刷新当前Latest资产ZIP之前，必须运行 `npm run check-assets` 并确认 In sync ... Safe to release；网络失败不算通过。
3. 若资产有变化，按提示先刷新当前Latest的kumiko-assets.zip，再重新检查。Linux x64工作流仍是发行时资产ZIP的唯一上传者。
4. 保留必要构建、安装包内容检查及各平台验证；不把前端编译通过当成真机验收。
5. 同仓库0.x发布：先补全安装器、4份更新元数据和资产ZIP，再显式设置Latest。旧版自动更新不能被强制降级。
6. 不删除旧tag/release，不重写历史，不复用不同签名的Android安装包做迁移。
7. 实际发布/远端写入应有本次明确授权；“以后可以同步仓库”不代表本轮已发布。

v2的完整命令、资源生命周期、回滚与历史问题保存在 [原发布手册](../archive/legacy-v2/RELEASE.md)。其中2.x版本节奏和旧平台描述是历史参考，当前重启规则以本页及版本决策为准。

## 本地版本预检

准备版本变更时运行 `npm run check-version`。它核对 package.json、锁文件与 Android 的版本值，并在0.x阶段要求Android内部编号大于旧版21431、停止使用旧CI版本公式。此检查不能验证更新源隔离、签名或资源同步；正式发行仍须完成本文原有检查。

更新保护回归使用 `node scripts/test-version-restart.cjs`。0.x阶段会忽略2.x候选版本；未来发行新一代2.x前必须修订此规则。Android每次新发行都要继续递增androidVersionCode，不能停留在21432。
