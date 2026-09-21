# 当前状态与接续入口

更新：2026-09-21。**用户仅授权将当前本地源码同步到 GitHub，Release 暂不更新。功能开发仍保持暂停，未恢复后续可靠性任务。**

## 2026-09-21 源码同步

- 实时 fetch 确认远端 main 在 e343f37（v2.14.28），本地已有4个尚未推送的提交，另有版本重启、可靠性修复和文档整理尚未提交。
- 本次将上述现有源码与文档纳入同步；保留原历史、用户已有缩进修改和本地运行资产。安装器、缓存、私人提示历史、环境配置与签名文件不纳入提交。
- 本次复跑5份行为回归（备份、RAG、摘要、日记、更新器）、版本一致性检查、TypeScript检查和差异空白检查，均通过。
- 所有现有 GitHub 工作流均为手动触发；本次只推送 main，不推送标签、不触发构建或更新 Release。同步前最新 Release 为 v2.14.28；源码0.0.0不表示已有对应安装包。
- 下方保留上轮开发收尾记录；其中“未commit/push”和旧Git状态仅描述2026-09-12。后续功能与真机验证仍待另行继续。

## 用户目标与约定

- 最高目标：真实存在于远方、拥有连续人生和自主性的黄前久美子。
- 用户认可审视指出的缺口，均需解决；整理和版本源码归零已完成，当前继续阶段1可靠性修复。
- 软件希望从0.0.0重新起步，继续使用原GitHub仓库。
- 安全第一；已有VPS与域名，但本轮只研究、不登录或改服务器。
- 子agent按任务复杂度选择模型/思考。轻量盘点Luna/medium、版本兼容Terra/high、安全分析Sol/high已完成。
- 通常在任一相关Codex额度窗口剩余≤2%时收尾；原14:59截止后曾暂停；用户先追加三分钟、再于15:11追加五分钟。15:17:06快照剩8%，15:21:23快照剩7%，均为10080分钟窗口。记录只来自本任务rate_limits元数据，不读取凭据。新停止条件以用户本次说明为准：回升或归零即停，≤2%先准备。
- 不自动兑换重置、购买额度、推送、发布、部署或开启自动推进。

## 已完成

- 确认origin为 https://github.com/OgalinLabM0/Kumiko-Amadeus.git，保留main、原历史和远端。
- 完成目录盘点，23项文件/目录移动，未删除内容；移动清单在 artifacts/archive/2026-09-12/move-manifest.json。
- 旧2.14.30/2.14.31安装器与blockmap按版本归档；根目录4份日志、旧dev-dist和私人提示历史归档。
- 保留 release/win-unpacked，因为已有诊断脚本依赖；dist、Android缓存、node_modules保留固定构建位置。
- 文档按plans/architecture/guides/decisions/reviews/reference/worklog/archive分类；旧PWA资料标记为历史。
- 原README和AGENTS已保存历史副本；新README和AGENTS提供短入口、资产/发布约束和接续规则。
- 完整审视报告已复制到仓库并转为相对链接。
- 建设方案、VPS安全方案、版本重启决策、协作与上下文说明、方案模板和当前发布规则已落盘。
- 修正文档搬迁引用及Windows指南中已过时的blockmap说明；Android工作流同步更新签名指南路径和独立版本编号读取/校验。
- .gitignore保护artifacts私密/大文件；本地story-notes继续忽略。

- 追加三分钟内增加 npm run check-version：核对桌面/锁文件/Android版本元数据，阻止归零时沿用旧Android编号或CI版本公式；尚不验证更新源隔离。

- 五分钟追加工作已完成源码0.0.0、锁文件与Gradle同步、Android独立内部序号21432和CI校验；桌面与Android过滤旧2.x候选，保留未来0.x更新。

## 尚未完成／不能误报完成

- **源码版本已为0.0.0；新安装包尚未构建、安装或发布。** 同签名Android覆盖安装、桌面跨版本安装的数据保留尚待真机验证。
- F01/F02/F03/F04/F06/F15的本批源码修复与隔离回归已完成；共享模块开发兼容、摘要原子提交与畸形输出校验均已补齐。其余F05、F07—F14未修复。详见 [可靠性修复记录](2026-09-12-reliability.md)。
- F04额外边界：合法空vectors数组现会替换为空库；IndexedDB替换使用事务。Android仍沿用实际Dexie恢复路径，其HNSW缓存重建一致性尚待另行验证，不能误报全平台恢复已验收。
- VPS没有新服务、Compose包、认证或持久Worker；部署文档是草案。
- 没有安装hooks、GSD、配额监控服务或修改Codex全局设置。
- 没有commit、push、GitHub release、DNS或服务器操作。

## 已有工作必须保留

- 用户原有 services/kumikoStateMachine.ts 缩进修改，未改动。
- 原未跟踪 docs/digital-person-architecture-notebook.md 已完整迁至 docs/architecture/digital-person-architecture-notebook.md，不能当成新实现或删除。
- public/assets/models的运行资源、.env.local、签名与现有应用数据保持原位置。
- Git状态显示旧docs路径删除与新目录未跟踪，是尚未暂存的移动；不是内容丢失。

## 验证

- 当前有效文档与审视报告共112个本地链接检查通过（历史档案和原作资料不作为当前操作链接验收）。
- git diff --check通过；仅存在LF/CRLF格式提示，无空白错误。
- 移动前检查来源/目标都在工作区，拒绝已存在目标与重解析点；移动后文件大小核对通过。
- 本轮0.0.0实际版本预检、更新器JavaScript语法检查及TypeScript检查通过；版本预检此前6个边界场景通过。桌面/Android更新器模拟回归通过，覆盖0.0.0及0.0.1拦截2.14.31、可继续发现0.x、旧2.x自身更新保留；桌面事件及直接注入旧状态后的下载/安装入口均验证。Android CI实际校验代码的12个有效/无效边界场景通过。上轮2.14.31前端构建和7个迁移测试通过；本轮未重新打包或真机测试。
- 历史文档仍保留其时代描述，已有退役提示；不应据此恢复旧PWA功能。

## VPS核验结论

用户授权参考资料位于 D:\MAINSPACE\OpenClaw-Hermes\Hermes\LLM Wiki AI-Knowledge\OMKK 网站与服务器管理。
只读取非凭据规格/拓扑：RackNerd、Debian12、1核约2GB、已有多个生产站点；资料为历史快照，未实时核验。
建议独立实例或独立家用设备承载私人角色原型；可继续使用同域名体系的新子域。详见架构方案，不要直接占用现机80/443或复用公共图库/数据库。

## 恢复后的第一步

1. 若已经因额度回升或归零暂停，先等用户调整配置并明确继续；当前活动阶段先核验额度快照，发现回升/归零就停止新任务并保存进度。
2. 阅读 [版本决策](../decisions/0001-version-restart.md)，复核本轮改动并按发行需要安排实际安装迁移测试；可运行 npm run check-version 和 node scripts/test-version-restart.cjs。保留appId、数据路径、Android签名、旧release/tag。
3. 对本轮文档/目录整理做最终人工复核；有明确同步指令再commit/push，不发布。
4. 与用户按 [建设方案](../plans/rebuild-roadmap.md)进入可靠性修复阶段。优先备份导入、摘要游标、召回证据、恢复、日记跨日，再完整覆盖15组问题。

入口：[文档目录](../README.md)、[建设方案](../plans/rebuild-roadmap.md)、[服务器与安全](../architecture/hosting-security.md)、[审视报告](../reviews/2026-09-12-project-audit.md)。

## 本次收尾与下一步

- 子agent全部工作已返回；主agent已复跑5份行为回归（备份、RAG、摘要、日记校验、更新器）及版本预检，均通过。最终TypeScript检查通过，git diff --check通过。
- F01共享校验为 electron/backup-import-validation.mjs；开发模式转换和最终生产构建通过。打包文件规则electron/**/*覆盖该模块，但没有生成/安装新应用包。
- 本次额度基线15:17剩8%，随后降到2%开始收尾，15:38:25快照剩1%；只从本任务日志读取rate_limits元数据。额度回升或归零即停，≤2%后不再开新任务。
- 下一批优先F05跨日日记，再F07/F08离线心理与课表，后续F09—F14。当前F06和F15已完成，避免重复修复。
- 深层工作仍包括：跨存储恢复回滚、Android恢复索引同步、真实设备断电/重启与覆盖安装、长期事实连续性测试。现有VPS没有部署，持续生活主体尚未实现。
