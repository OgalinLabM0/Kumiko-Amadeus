# 文档入口

这是项目文档的固定入口。先读建设方案，再看当前状态；技术细节按需展开。

| 你想了解什么 | 文件 |
|---|---|
| 我们要造什么、先做什么、做到什么算完成 | [建设方案](plans/rebuild-roadmap.md) |
| 现在完成了什么、暂停后从哪里继续 | [当前状态](worklog/CURRENT.md) |
| 原项目有哪些问题 | [审视报告](reviews/2026-09-12-project-audit.md) |
| 第一批可靠性问题改了什么、如何验证 | [修复记录](worklog/2026-09-12-reliability.md) |
| 已有 VPS 是否可用、以后用户怎样自托管 | [部署与安全](architecture/hosting-security.md) |
| 为什么版本归零还要保留内部序号 | [版本重启决策](decisions/0001-version-restart.md) |
| 截图中的多 agent、hooks、上下文是否值得采用 | [协作与上下文](guides/agent-workflow.md) |
| 怎样准备发行、哪些事情当前不能跳过 | [发布指南](guides/releasing.md) |

固定分类：`plans/` 方案；`architecture/` 架构；`decisions/` 决策；`guides/` 操作；`reviews/` 审视；`reference/` 内容资料；`worklog/` 状态；`archive/` 历史。

现有深度资料保留在 [数字主体架构记录本](architecture/digital-person-architecture-notebook.md)、[记忆架构参考](architecture/rag-architecture.md)、[备份架构参考](architecture/backup-architecture.md)。记录本是设计讨论，部分技术选型和硬件判断是旧快照，实施时核实；RAG/备份文档是 v2 参考，实际实现以代码和审视证据核对。

旧 PWA 桥接、手机镜像与早期 iOS/Tauri 文档已归入 [历史说明](archive/README.md)，不作为当前能力。原作资料在 `reference/canon/`，其中本地 story-notes 继续保持 Git 忽略。

写新方案用 [方案模板](plans/TEMPLATE.md)。不要另建散落根目录的 PLAN-final-new.md；在同一议题文件更新状态和决定。
