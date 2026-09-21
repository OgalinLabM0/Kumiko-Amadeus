# 本地产物与归档

这些目录主要存放不进入Git的文件；只有本说明提交。

- installers/legacy-v2/版本/windows-x64：旧安装器及配套blockmap；2.14.31的latest.yml与它一起保存。
- archive/2026-09-12/logs：原根目录构建日志、builder-debug。
- archive/2026-09-12/build-cache：退役dev-dist。
- archive/2026-09-12/history：旧提示历史；按本地私人资料处理，不读取到项目报告，不提交。
- archive/2026-09-12/move-manifest.json：本次23项移动的原位置、新位置、类型和文件大小，方便恢复。

未来成品统一放 installers/<轨道>/<版本>/<平台架构>/，不要改成“新exe”“最终版2”。release/继续作为构建暂存；release/win-unpacked由诊断脚本依赖，当前保留。dist、Android构建缓存、node_modules已有明确位置，不为了表面整齐打乱构建。

本次没有删除文件、解压安装包、移动用户数据或角色资产。恢复归档时先核对当前目标是否已有新内容，禁止覆盖。
