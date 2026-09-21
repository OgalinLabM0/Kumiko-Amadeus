# 2026-09-12 整理记录

本次按用户要求分类，不删除旧产物、源码或私人资料。23项移动的逐项原路径、新路径、类型与文件大小保存在本地 artifacts/archive/2026-09-12/move-manifest.json。

| 原位置/类型 | 新位置 |
|---|---|
| release中的2.14.30/2.14.31安装器与blockmap | artifacts/installers/legacy-v2/<版本>/windows-x64 |
| 2.14.31配套latest.yml | 与该版本安装器一起 |
| 根目录构建日志与builder-debug | artifacts/archive/2026-09-12/logs |
| 退役dev-dist | artifacts/archive/2026-09-12/build-cache |
| migrated_prompt_history | artifacts/archive/2026-09-12/history |
| 架构/备份/RAG文档 | docs/architecture |
| Windows安装、Android签名 | docs/guides |
| 原发布、iOS早期文档、README/AGENTS副本 | docs/archive/legacy-v2 |
| 旧PWA/手机桥接文档 | docs/archive/legacy-mobile |
| 原作资料 | docs/reference/canon |

保留release/win-unpacked作为已有诊断脚本固定入口，未归档Android/Node生成缓存，未改构建入口和运行资产位置。

恢复某项移动：先查清单并核对原位置没有新增文件，再使用原生文件移动回去；不能覆盖或批量删除。安装器和私人提示历史不提交Git。

当前有效文档链接检查通过。版本重置与功能修改未执行。此次暂停和下一步以 [CURRENT.md](CURRENT.md)为准。

## 用户追加三分钟后的接续

新增 `scripts/check-version-consistency.cjs` 与 `npm run check-version`，完成实际元数据检查及6个边界场景验证。版本值仍为2.14.31；0.0.0归零和更新源保护尚待实施。当前状态已更新，按时再次暂停。

## 用户再追加五分钟：0.0.0源码基线

源码版本归零为0.0.0，Android内部编号21432继续递增，CI从package.json独立读取并校验。更新器在0.x阶段过滤旧2.x，桌面同时拦截旧更新状态的下载/安装。应用身份、签名配置和数据路径保留。新增隔离更新器回归脚本；版本检查、TypeScript、更新器模拟、CI编号12个边界场景、104个文档链接与差异空白检查通过。未打包、未真机安装、未提交或发布。后续入口仍为CURRENT.md。
