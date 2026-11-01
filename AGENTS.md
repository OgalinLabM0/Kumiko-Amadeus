# 项目工作入口

## 目标与当前阶段

项目最高目标：建立真实存在于远方、保持连续人生和自主性的黄前久美子。工程验收落在事实、记忆、目标、行动、持久性与长期行为上；不得把计划写成已实现能力。

用户位置认知以聊天中主动告知的原话为准，持续有效直到再次告知；不得从设备、IP或软件时区设置自动更新角色认知。时间、天气和提醒的边界见 [位置认知决策](docs/decisions/0002-user-location-knowledge.md)。

先读 [当前状态](docs/worklog/CURRENT.md) 和 [文档入口](docs/README.md)，再按任务读 [建设方案](docs/plans/rebuild-roadmap.md) 的相关部分。不要每次加载全部历史笔记。

## 工作边界

- 用户当前明确要求优先；仅完成授权范围，保留无关修改和本地运行资产。
- 解释、审视和方案不自动授权实施；本轮后续功能需按当前状态记录接续。
- 不默认创建 worktree，不默认安装 GSD、不设置自动推进。需要时先按共享约定与用户讨论。
- 未获发布/部署授权，不推送发行、改服务器、修改 DNS 或移动远端 Latest。
- 子 agent 只用于有独立收益的明确子任务。用户允许按复杂度选模型/思考程度：盘点与机械任务优先轻量模型，跨模块实现用中档，架构/数据安全由主 agent 或强分析模型处理。
- 子 agent 返回简短结论、改动文件、验证和未决事项；避免复制整段历史上下文。

## 文档与接续

- plans 放建设/实施方案；architecture 放架构；decisions 放已确认决策；guides 放操作；reviews 放审视；worklog 放当前状态和完成记录；archive 仅历史。
- 一个议题维护一个权威文件，使用状态“草案/已确认/实施中/完成/历史”。新方案采用 [模板](docs/plans/TEMPLATE.md)。
- 当前状态只维护在 docs/worklog/CURRENT.md；重要取舍与被否决方向保存在对应方案/决策。小步骤不重复生成新 md。
- 每个有意义的工作块结束或暂停前，保存完成项、未完成项、验证、风险和下一步。
- 用户要求 Codex 相关额度窗口剩余 ≤2% 时开始收尾：停止新任务/新子 agent，收集在途结果，保存接续文档后结束。不自动兑换重置或购买额度。
- 额度只能依据可用的、带时间的账号/会话 rate-limit 快照；不可将上下文剩余量当订阅额度。不可读写或输出 auth.json 中的凭据。
- 最新用户指令（2026-09-12）：已继续阶段1；同一额度窗口剩余值回升（重置）或归零即暂停，≤2%开始准备收尾。暂停后等用户调整配置并明确继续，不自动恢复。源码已为0.0.0，发行与安装迁移待验证。
- 截图方法的取舍见 [协作与上下文方案](docs/guides/agent-workflow.md)。

## 工程和资产

- 主进程 electron-main.cjs；preload.cjs 是桥接；electron-rag.cjs / rag-worker.cjs 是原生记忆；React 入口 index.tsx / components/App.tsx。
- public/images/emotions、public/ringtones、public/images/logo.png、public/CCA-P2.png、public/favicon-KA.ico、assets/lore.enc、assets/worldbook.enc、models/bge-m3-onnx/model_int8.onnx 是必要本地资产，部分不在 Git。
- scripts/check-onnxruntime-electron.cjs 依赖 release/win-unpacked；整理时保留这一固定诊断位置。
- artifacts 中安装器、日志、缓存和私人提示历史不得加入 Git。
- 核心修改应做相应检查；文档改动检查链接即可，不每轮重复完整打包。行为检查包括 TypeScript 与相关回归；必要时生产前端构建、真机验证。
- 任何正式发行或刷新当前最新资产 ZIP 之前，必须运行 npm run check-assets，并确认输出 In sync ... Safe to release。网络失败不算通过。
- 资产变化先按既有流程刷新当前 Latest 的 kumiko-assets.zip，再重新核对。ZIP 上传仍由 Linux x64 工作流单独负责。
- 本轮不删除旧 release/tag，不重写 Git 历史，不重置应用 ID、签名或用户数据。

版本重启规则见 [版本决策](docs/decisions/0001-version-restart.md)，当前发布操作见 [发布指南](docs/guides/releasing.md)。原完整工程说明保存在 [历史入口](docs/archive/legacy-v2/AGENTS-before-restart.md)；有效的资产/发布约束继续适用，过时功能描述不自动恢复。
