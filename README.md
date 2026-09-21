# Kumiko·Amadeus

目标：建立一个拥有连续人生、自己的事务和长期记忆的黄前久美子，让软件成为与远方的她保持联系的载体。

当前源码版本已重启为 **0.0.0**；Android内部安装序号继续递增为21432，保留应用身份和原数据路径。桌面与Android更新检查已排除旧2.x发行，新安装包尚未构建或发布。现有程序是 Electron + React/Vite 桌面应用，另有独立 Android/Capacitor 路径；持续服务器和双向语音尚未实现。

## 从这里开始

- **[文档总入口](docs/README.md)**：文档分类及阅读顺序。
- **[建设方案](docs/plans/rebuild-roadmap.md)**：目标、步骤、验收，供项目所有者与开发者共同阅读。
- **[当前进度与接续](docs/worklog/CURRENT.md)**：已完成、未完成、暂停原因和下一步。
- **[VPS 与安全方案](docs/architecture/hosting-security.md)**：已有服务器是否合适、未来用户如何部署。
- **[项目审视报告](docs/reviews/2026-09-12-project-audit.md)**：15 组已发现问题及证据。
- **[协作约定](AGENTS.md)**：给后续开发 agent 的短入口。

## 开发与文件位置

`npm install` 安装依赖；`npm run fetch-assets` 获取角色资产；`npm run desktop:dev` 本地开发；`npm run build:cap` 构建前端。

源码按现有 components/services/hooks/electron/store 等目录保留。public、assets、models 包含运行所需且部分未入 Git 的资源，不可当缓存清理。

- `release/`：当前打包和诊断使用的输出位置。
- `artifacts/installers/`：按轨道、版本、平台分类的本地成品。
- `artifacts/archive/`：旧日志、缓存、提示历史，默认不提交。
- `docs/archive/`：明确标为历史的旧方案，不能作为当前能力说明。

现有记忆、课表、日记、忙碌补回与 TTS 是重建基础。当前“来电”是合成语音播放；数据主要本地保存，但所选上下文会送往配置的模型服务。

Git 远程仍是 [OgalinLabM0/Kumiko-Amadeus](https://github.com/OgalinLabM0/Kumiko-Amadeus)。2026-09-21 用户授权同步当前源码；Release 暂不更新，不发布安装包或部署服务。发布规则见 [发布指南](docs/guides/releasing.md)，旧版完整说明保存在 [v2 历史档案](docs/archive/legacy-v2/README.md)。
