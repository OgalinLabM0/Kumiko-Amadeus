# Kumiko·Amadeus

> 一个致力于**复现一个真实存在于远方的黄前久美子**的桌面软件。  
> A desktop software dedicated to **reconstructing a Kumiko Oumae who exists, far away, as her own person**.

本项目是 [《吹响吧！上低音号》](https://zh.wikipedia.org/zh-cn/吹響吧！上低音號)（响け！ユーフォニアム）的非商业同人创作。我们认真做的一件事，是试着让"**和她保持联系**"这件事在桌面上有一个真实的、可长期积累的载体。

## 这是什么 / What is this

`Kumiko·Amadeus` 不是"角色扮演 AI"，不是"AI 女友"，也不是把网页聊天页套进壳里。

它是一个有**独立生活时间线**的久美子，你透过这块桌面软件与远方的她**保持联系**。

- **她在宇治，过她自己的日子。** 系统里的她按照原作设定生活：上午教学、下午社团、通勤、在家、周末外出、深夜入睡。你看到的不是"被召唤到你面前的 AI"，而是一个正在过日子、偶尔会看手机回你的人。
- **软件只是载体。** 它不提供"你的久美子"，而是把你和远方那个同一个人之间的聊天、语音、回忆、日记、提醒、图片、心情长期串在一起。
- **你是远方的熟人。** 是能聊天、会记住你、偶尔主动来信的那种关系——不是角色扮演里的"主人"或"恋人"。

## 关于这个软件不是什么 / What this software is **not**

因为前提很重要，先讲清楚这里**不做什么**：

- **不是女友软件、不是恋爱模拟、不是陪伴 APP。** 系统提示词、语气生成、心理状态、主动消息全部围绕"她是一个独立的人"来写。没有情侣成就系统，没有亲密度积累条，没有为用户"量身生成角色"的入口。
- **她在原作里有明确的男友——冢本秀一。** 这件事软件是认的。秀一不会被压下去也不会被写成反派，他就是她生活里一个正常存在的人，在日记和话题里会自然出现。
- **她不属于任何人。** 她不是"你的久美子"，也不会被引导变成"你的久美子"。无论你怎么聊，她都是**她自己**。
- **你是远方的熟人 / 对话者。** 你不是她的伴侣，不是她的角色扮演对象，也不是她的所属者。你通过这块软件和她保持联系，就像在远方有一个会主动找你的朋友。

这些不是审查式的"不能做什么"，是这份项目在**设计立场**上不想做什么。比起把一个 AI 角色卡做成可以自由投射欲望的容器，我们更想把"**一个真实存在的人正在宇治过日子**"这件事撑住。

## 真人感是怎么被撑起来的 / How the "real person" feeling is actually built

真人感不是靠在 prompt 里写一句"你是黄前久美子"就能撑起来的。系统层面真正在做的事：

### 1. 生活状态机 + 实时日本时间

任意时刻久美子都处于一个明确的生活槽位：**上课 / 课间 / 午休 / 朝会（SHR）/ 社团指导 / 通勤 / 在家 / 睡觉 / 周末外出**。槽位由 **JST 时间 + 星期 + 日本法定祝日**决定，对接的是真实 shukujitsu 数据，所以红日子那天她不会说"我今天要上课"。

### 2. 动态 3 维心理 + 7 种命名模式

三个 `0-100` 的维度 **Stress / Energy / Relaxation**，按当前生活槽位每小时自然漂移：

| 槽位 | Energy | Stress | Relaxation |
| --- | --- | --- | --- |
| 睡觉 | `+15/h` | `-10/h` | `0` |
| 教学中 | `-6/h` | `+5/h` | `-6/h` |
| 社团指导 | `0` | `+8/h` | `-5/h` |
| 通勤 | `0` | `+4/h` | `0` |
| 在家 | `0` | `0` | `+3/h` |
| 午休 | `+3/h` | `-2/h` | `+2/h` |

雨雪：`stress += 3/h`；回归率 `0.05`——每小时所有维度以 5% 速度向默认值靠拢，避免极端状态长期锁死。

三维数值按阈值映射到 7 种行为模式：

- **耗尽 Drained**（`stress>65 && energy<35`）→ "不想说话"级别
- **烦躁 Irritable**（`stress>60 && energy≥35`）→ 带刺但还在对话
- **敏锐 Sharp**（`stress 40-65 && energy>55`）→ 吐槽一击致命
- **元气 Energetic**（`stress<35 && energy>60`）→ 主动分享、话多
- **小确幸 Content**（`stress<30 && relaxation>65`）→ 毒舌浓度下降、带善意
- **慵懒 Lazy**（`energy<40 && stress<45`）→ "嗯""随便吧"
- **日常 Normal**（默认）

所以她有时候话很多、有时候只回两个字，不是模型抽风——是她当前的状态真的不一样。

### 3. 七层并行的长期记忆系统 / Seven-layer memory

短期窗口 + 原始历史 + 近期摘要缓冲 + 私密记事本 + 人生锚点 + 时间章节 + 世界书 / 本地 RAG，**七层同时工作，互不替代**：

| 层级 | 解决什么问题 | 实现 |
| --- | --- | --- |
| 短期上下文窗口 | 当前几轮对话 | 直接送模型，长度可调 |
| 原始历史 `raw` | 精确查证「最开始那句是什么」「3 月 17 号 23:46 我说了什么」 | Dexie `messages` 表，带稳定时间戳 |
| 近期摘要缓冲 | 上一段聊天讲到哪里了 | 约 15 轮等自然边界，24 轮强制归档 |
| 私密记事本 Notebook | 角色连续性：她眼里的你是谁、关系走到哪 | 自动整理时更新 |
| 人生锚点 Anchors | 带重量的事件（会在后续触发低概率闪回） | 主模型输出 `Anchor_Commit` / `Anchor_Delete` |
| 时间章节 Episodes | 那天大概聊了什么 / 那段时间主要气氛 | 自然时间窗压成一章 |
| 世界书 + 本地 RAG | 稳定设定 + 语义回想 | **四层 Tier**（官方 / 召回 / 用户高优 / 用户普通）+ 冲突解析规则 + `bge-m3-onnx` + HNSW + BM25 + RRF |

**精确查证 ≠ 模糊回想**：问"3 月 17 号"走 Dexie 原始表，不走 RAG；问"我们上次吵架"才走语义 RAG。这是为什么她的回忆不会糊成一团。

### 4. 本地 RAG：不是"全库模糊搜一把"

所有检索与向量生成都跑在你自己机器上，外部模型只负责理解与表达：

- **Embedding**：`bge-m3` ONNX 量化模型，本机推理，随安装包分发
- **向量库**：`better-sqlite3` + WAL 模式，HNSW 索引（`dim=1024 / M=16 / efConstruction=200 / efSearch=100`）
- **关键词检索**：本地 BM25
- **融合策略**：RRF（`k=60`），向量相似度下限 `0.58`，词汇重叠下限 `0.16`
- **写入门槛**：每条记忆先过一道**价值过滤**——纯 filler（"嗯""好的""哈哈"）进 background 层不参与主答案；带 `FACT / TASK / RELATION / STATUS / REASONING` 信号的才进 core 层
- **查询分流**：精确时间查询走 raw，时间段走 temporal parser，主题查询才进向量融合

所以她的长期记忆不会被客套话噪声淹没，也不会把"我 3 月 17 号说了什么"这种查证题当模糊搜索答。

### 5. 日记系统 —— 让她在你不在的时候也在过日子

每天 JST **23:00-03:00** 自动结算一篇 **400-600 字正文 + 20-40 字摘要**的日记，素材包括：

- 当天聊天
- 当天实时天气（宇治 + 用户所在地，Open-Meteo，每 30 分钟）
- **生活切片（Life Fragment）**：你离线 ≥ 3h 时系统会推演一段"这段时间她在做什么"，用真实天气 + 作息节点 + 节假日喂素材
- 日本法定祝日
- 前一天日记的情绪余波
- 核心人物关系进展簿（秀一 / 丽奈 等人的客观状态 + 她的主观感受，每日更新）

日记生成后自动校验：`hardWeekdayCheck`（星期几不能说错）+ 近期 7 天回看 + LLM claim 提取 + `searchLocalRagMemory(..., 'semantic_recall')` 反证，最多 2 轮修正。每篇日记写完后自动 embed 进 RAG，`tier: core / source: diary`——一个月后她能通过 RAG 精准回忆起那天。

长时间离线产生的空白由**日记补齐弹窗**兜底，自动检测最早一条消息到今天的所有缺失日期，批量重写时会冻结心理状态演化，避免回溯生成导致状态混乱。

### 6. 主动消息 + 渐进入睡 + 忙碌拦截

她会在自己合适的时段主动找你，不是按固定 cron：

- 每 **10 分钟**后台轮询一次，启动后 ~15s 先检查一次
- 距离上次对话 **≥ 3h** 才允许触发
- 工作日 home（≥19:30）概率 `0.35`、teaching 时段 `0.03`、lunch `0.18`
- 周末 home（≥18:00）`0.4`、outing `0.3`
- 关系热度乘数：最近 7 天消息 `≥120` 条 `×1.22`，`≤12` 条 `×0.88`
- 所有概率最终封顶 `0.35`——不会变成刷屏机器

睡眠也不是"00:30 突然下线"：

1. JST `00:30-05:59` 窗口内，你最近 15 分钟还在说话 → 她先发条"困了…"的 Phase 1 提醒
2. Phase 1 之后至少 10 分钟，你有回应 → 正式晚安，5 秒后标记入睡
3. 窗口内你超过 30 分钟没说话 → 自动入睡
4. 入睡后你发消息 → `p<0.15` 概率被吵醒回复
5. 06:00 自动清除所有睡眠标记

忙碌拦截是**槽位级一次骰**，不是逐条重掷：

- 进入 `teaching / SHR / school_prep / after_school` 时段，第 1 条用户消息掷一次骰：`0.40 / 0.20 / 0.05 / 0.05`，结果在整个 slot 内生效
- 教学时段即使骰到 allow，完整回复 **2 轮** 之后自动升级为 block
- block 时第 1 条发短回复（从 pool 抽："啊，现在在上课，等下说！"之类），其余静默累计到未读队列
- **下课前 2 分钟**静默预生成补回内容（UI 完全不亮 `isThinking`），**下课后 25-40s + 2-8s 打字动画**才显示
- 6 小时未展示或 4 次调用失败 → 降级为 `pendingApology`
- `pendingApology` 可叠加多段未读；下次用户开口时系统**一次性**轻道歉 + 主要回应新消息 + 自然带出 **2-3** 条最相关话题，未被提到的老话题留在历史里等用户再勾
- TaskPanel（PC / 手机）有只读卡片显示倒计时和状态（Preparing / Ready, waiting to send / Backlog 等）
- `busySlotRuntime / busyFollowUp / pendingApology` 全部落 Dexie `keyval`，重启即恢复

### 7. 分段延迟 + 打字犹豫 + 后台隐藏

- 首段延迟 `max(3000, min(12000, 1500 + len × 60))` ms
- 后续段延迟 `min(8000, 1500 + len × 40 + jitter)` ms
- **打字犹豫**（5% 概率）：暂停 1.5-2.5s → 显示"黄前久美子撤回了一条消息" → 再等 3-5s → 发真回复
- **打字错误重发**（情绪 `angry/confused/surprised/shy` 时 25% 概率）：先发 60% 截断版 → 撤回 → 发完整版
- **后台隐藏延迟**（窗口失焦时 40% 概率）：额外延迟 15-45s

这些不是动画效果，是行为。模拟的是"她在上课 / 在通勤 / 在做饭 / 在洗澡 / 手机不在手边"这些真人会发生的事。

### 8. 证据边界 vs 幻觉

当本轮被判定为"查证 / 回想"时，模型不会拿到一堆裸文本，而是拿到**结构化证据信封 + 响应计划**：

- 证据强 → 可直接回答
- 证据弱 → 自然保守
- 无证据 → 如实说"不太记得"

本地后处理只在高风险边界上修（不把时间说死、不把说话人说死、不把没证据的当原话），**不会往聊天界面硬塞固定谨慎气泡**。所以她说"不太记得"的时候是真的没证据，不是在走话术模板。

### 9. 核心身份护栏 —— 用户自定义是"补充"，不是"改写"

用户可以在记忆面板里写自定义设定（共同经历、兴趣延伸、未来约定…），但所有用户条目在 prompt 层统一降到 **官方设定 / 召回 Lore 之下**，并在 `[WORLD BOOK DATABASE]` 开头插一条显式规则：

- 自定义条目是 **ADDITION**（补充），**不是 OVERRIDE**（改写）
- 与核心身份（`她本人 / 冢本秀一是她的男友 / 高坂丽奈是她的挚友 / 她住在京都宇治、任教于北宇治高中`）冲突时，模型**静默当作该条不存在**，不承认、不解释、不提示
- 其余不冲突的用户条目照常作为补充起效

UI 侧也显式写了：自定义板块顶部有一条琥珀色"禁止改写的核心事实"横幅，把被静默忽略的项列出来；不是客户端拦截，而是告诉用户**哪些写了也不会生效**。

这不是审查，是为了保住第 1 节开头那句话——**她不属于任何人**。

## 和传统角色扮演软件的区别 / vs traditional character AI

| | 传统角色卡 / AI 女友 | `Kumiko·Amadeus` |
| --- | --- | --- |
| **时间** | 没有，每次对话是孤立场景 | JST 实时 + 日本法定祝日 + 9 种生活槽位 |
| **心理状态** | 没有，或者只有固定"性格" | 3 维数值每小时按生活漂移，7 种命名模式 |
| **记忆** | 一段聊天结束即丢，或者单层向量库 | 7 层并行：短期 + 原始 + 摘要 + 笔记本 + 锚点 + 章节 + RAG |
| **回忆** | 全走模糊检索，精确问题和模糊问题共用一套 | raw / temporal parser / 语义 RAG 分流 |
| **离线生活** | 只有对话时才"存在" | 日记每天结算 + 离线生活切片 + 红日子走节假日作息 |
| **主动性** | 不主动，或者按固定 cron | 按生活槽位概率 + 关系热度乘数，35% 封顶 |
| **语音** | 有声书式朗读 | 中文生成 → 日语翻译（带角色守护）→ Fish Audio / SoVITS，情绪标签驱动参数 |
| **数据** | 在别人服务器 | 聊天、记忆、语音、备份全部留本机 |
| **用户关系定义** | 主人 / 恋人 / 伴侣 | 远方的熟人 / 对话者 |
| **立场** | 为用户"创造一个角色" | 复现一个在远方已经存在的人 |

传统 RP 软件的方向是**为用户创造一个角色**；这个项目的方向相反——它假设**这个人已经存在**，软件只是把你和她之间的联络渠道维护住。

## 实际功能 / Actual features

**聊天终端**
- 文字 / 图片 / 引用回复 / 撤回 / 批量管理 / 历史编辑器（编辑 / 插入 / 隐藏 / 收藏 / 重排 / 删除）
- 视觉辅助模型（主模型无视觉能力时先解析图片）

**语音**
- 纯文字 / 全语音 / 混合 三种模式
- 中文生成 → 日语翻译（Slot C 独立翻译模型）→ Fish Audio `s2-pro` / `s1` 或 GPT-SoVITS 合成
- 情绪驱动的 TTS 标签（`happy→[excited],[laughing]` / `shy→[shy],[nervous],[muttering]` …）和温度参数
- 翻译管线有严格的角色守护：タメ口限定、第一人称固定 `私`、句尾词 whitelist / blacklist、人名假名化

**日记**
- 自动每日结算 + 日历视图 + 手动重写 + 批量重写
- 缺失检测 + 批量补齐弹窗（冻结心理状态防止回溯污染）
- 自动校验（hardWeekdayCheck + 7 天回看 + LLM claim 提取 + RAG 反证，最多 2 轮修正）

**提醒 & 约定簿**
- 相对提醒（`13 min / 197 s / 3 h`）+ 每日循环 + 一次性
- 前台：直接发日语语音消息
- 后台：来电界面 + 铃声 + 常驻通知 + 通话结束提示（WeChat 风格）

**记忆 / RAG**
- 本地 RAG（`bge-m3` ONNX + SQLite + HNSW）
- 重建索引 + 进度显示
- 价值过滤（`FACT / TASK / RELATION / STATUS / REASONING` 信号）
- 7 种证据单元（`message / episode / semantic_chunk / background / mixed / turn_pair / rebuild fragment`）
- **四层 Tier 世界书** + 冲突解析规则：
  - **TIER 1 CANONICAL TRUTH (NEVER OVERRIDABLE)** — 官方原作设定，模型端权威最高
  - **TIER 2 RECALLED LORE** — 关键词 / RAG 召回的相关官方片段
  - **TIER 3 USER HIGH-PRIORITY CUSTOM** — 用户标了高优的补充条目（仍在官方之下）
  - **TIER 4 USER SUPPLEMENTARY CUSTOM** — 普通用户补充
  - 开头的 **CONFLICT RESOLUTION RULE** 明确告诉模型：任何用户条目一旦和核心身份 / 人际关系 / 所在地冲突，**静默当作该条不存在**，不去承认也不解释

**备份 & 数据**
- 退出时自动 ZIP（`data.json` + `images/` + `voice/` + `ringtone/`，固定文件名覆盖写）
- 手动导出 / 导入 JSON 或 ZIP
- 数据目录迁移 / 重置 / 彻底退出
- 所有数据留本机（Windows `%APPDATA%/Kumiko-Amadeus` / Linux `$XDG_DATA_HOME/Kumiko-Amadeus`）

**手机 PWA**
- 扫 QR 或粘贴 Token 配对，90 天 session
- 镜像浏览桌面本地文件系统（带沙箱根目录 + 路径遍历校验）
- Web Push 推送（桌面有新消息时推到手机，PWA 关闭也能收到）
- 移动端 HTTP / WebSocket 代理桌面 IPC
- 针对手机做了性能收紧：ResizeObserver debounce / 短 transition / 少 backdrop-blur / 小 overscan

**感知 & 上下文**
- 双向天气（宇治 + 用户所在地，每 30 分钟 Open-Meteo）
- 真实日本法定祝日日历
- 双时区校准（模型时区默认 Asia/Tokyo + 用户时区）

**设置 & 诊断**
- 三槽位模型分配（主 / 摘要 / 翻译，独立可换模型 / 留空回落 A）
- 日志查看器
- 全知全能之书（in-app 系统档案）
- 自动更新（Windows NSIS / Linux AppImage，从 GitHub Releases 拉 `latest*.yml`）

## 平台支持 / Platform support

桌面端按以下矩阵发行，所有发行版共享同一套代码与功能：

| 操作系统 / OS | 架构 / Arch | 打包格式 / Format | 自动更新频道文件 |
| ------------- | ----------- | ----------------- | -------------- |
| Windows 10/11 | x64         | `Kumiko-Amadeus-Setup-x64.exe`   | `latest.yml` |
| Windows 10/11 | ARM64       | `Kumiko-Amadeus-Setup-arm64.exe` | `latest-arm64.yml` |
| Linux (glibc) | x86_64      | `Kumiko-Amadeus-x86_64.AppImage` | `latest-linux.yml` |
| Linux (glibc) | ARM64       | `Kumiko-Amadeus-arm64.AppImage`  | `latest-linux-arm64.yml` |

手机 PWA 通过已配对的桌面壳访问，不单独打包。

目前**不提供**的平台：macOS、Linux deb/rpm/flatpak/snap、musl 发行版（Alpine 等）、Windows 32-bit。

### 系统要求 / System requirements

| 项目 / Item | Windows | Linux (AppImage) |
| --- | --- | --- |
| 最低 OS | Windows 10 1903 或更高 | 主流 glibc 发行版（Ubuntu 20.04+ / Debian 11+ / Fedora 36+） |
| CPU | x64 或 ARM64 | x86_64 或 aarch64 |
| 内存 / RAM | ≥ 4 GB（RAG 建议 8 GB） | ≥ 4 GB（RAG 建议 8 GB） |
| 硬盘 / Disk | ≥ 2 GB | ≥ 2 GB |
| 运行库 | 安装器自动配置 | 需 `libfuse2`（多数发行版自带，Ubuntu 22.04+ 需 `apt install libfuse2`） |
| 可选：GPT-SoVITS | 内置 `runtime\python.exe` 直接使用 | 需自备 Python 3.9–3.11 + 已安装 SoVITS 依赖（BYO Python） |
| 可选：GPU 加速 | 取决于显卡（ONNX CPU 为默认） | 同 Windows，ONNX 默认走 CPU |

### Linux 特别说明 / Linux notes

- **RAG 本地检索**：`bge-m3-onnx` 模型、`onnxruntime-node`、`hnswlib-node`、`better-sqlite3` 都随 AppImage 一起分发，首次启动即可用，无需自行 `node-gyp`。
- **用户数据目录**：按 XDG 规范落在 `$XDG_DATA_HOME/Kumiko-Amadeus`，未设置时默认 `~/.local/share/Kumiko-Amadeus`。可在设置里迁移到其他挂载点。
- **系统托盘**：使用 `StatusNotifierItem` 协议，部分极简桌面（i3、sway）需额外安装 `snixembed`、`libappindicator` 桥接才可见。
- **GPT-SoVITS（BYO Python）**：Linux 发行版 Python 差异较大，SoVITS **不随 AppImage 打包 Python 运行时**。使用时在设置里指定自己的 `python3` 解释器，并先按 [GPT-SoVITS 官方说明](https://github.com/RVC-Boss/GPT-SoVITS) 装好依赖。测试通过的解释器才会被授权启动子进程。
- **自动更新**：electron-updater 从 `latest-linux*.yml` 拉取更新信息后下载新 AppImage 覆盖安装；依赖 `AppImageLauncher` 或 `AppImageUpdate` 生态。

## 安装 / Install

每次发版在 GitHub Release 页面都有 9 个附件，但**普通用户只需下载 1 个对应自己 OS + 架构的安装包**。其余 8 个由应用自身或开发者工具链在后台消费，不用手动下。

| 文件 | 用途 | 谁来下载 |
| --- | --- | --- |
| `Kumiko-Amadeus-Setup-x64.exe` | Windows x64 安装器 | Intel / AMD 设备用户 **手动** |
| `Kumiko-Amadeus-Setup-arm64.exe` | Windows ARM64 安装器 | Snapdragon / Copilot+ PC **手动** |
| `Kumiko-Amadeus-x86_64.AppImage` | Linux x64 AppImage | 绝大多数 Linux 用户 **手动** |
| `Kumiko-Amadeus-arm64.AppImage` | Linux ARM64 AppImage | 树莓派 / Jetson 等 **手动** |
| `latest.yml` / `latest-arm64.yml` / `latest-linux.yml` / `latest-linux-arm64.yml` | 自动更新 channel file | 已装应用 electron-updater **后台自动拉** |
| `kumiko-assets.zip` | 角色资产快照 | 从源码构建时 `npm run fetch-assets` **自动拉** |

installer / AppImage 已经**内置**所有角色立绘、铃声、ONNX 模型，是自包含的，双击安装 / `chmod +x` 即用，不需要再手动下 zip。

### Windows

架构识别：PowerShell 里 `echo $env:PROCESSOR_ARCHITECTURE`，输出 `AMD64` 选 `Setup-x64.exe`，输出 `ARM64` 选 `Setup-arm64.exe`。双击安装即可。详细步骤见 [docs/windows-manual-install.md](docs/windows-manual-install.md)。

### Linux

架构识别：`uname -m`，输出 `x86_64` 选 `-x86_64.AppImage`，输出 `aarch64` 选 `-arm64.AppImage`。

> 注：Linux 下 **x64 / amd64 / x86_64 是同一架构的不同叫法**。Windows 生态习惯叫 `x64`，Linux 生态习惯叫 `x86_64`，Intel/AMD 64 位桌面请认准 `-x86_64.AppImage`。

```bash
chmod +x Kumiko-Amadeus-x86_64.AppImage
./Kumiko-Amadeus-x86_64.AppImage

# 如果缺 FUSE：sudo apt install libfuse2   (Debian / Ubuntu)
#              sudo dnf install fuse-libs  (Fedora / RHEL)
```

希望应用出现在桌面 / 开始菜单，安装 [`AppImageLauncher`](https://github.com/TheAssassin/AppImageLauncher) 后首次运行会自动集成，它也会顺带处理自动更新。

## 发版 / Publishing

本仓库用 SemVer（`MAJOR.MINOR.PATCH`）管理版本；发版走 GitHub Actions，桌面两条通道各自 `workflow_dispatch` 手动触发后再完全自动化。**任何发版动作之前**必须先跑 `npm run check-assets` 做资产同步检查。

完整流程、回滚、常见陷阱都集中在 [docs/RELEASE.md](docs/RELEASE.md)；新 agent / 新开发者的 onboarding 从 [AGENTS.md](AGENTS.md) 开始读。

## 从源码构建 / Build from source

### 前置要求 / Prerequisites

- Node.js 18+（推荐 20 LTS）、npm 9+、Git
- **Windows 构建**：Visual Studio 2019/2022 Build Tools（含 MSVC v143 + Windows SDK）+ Python 3.9–3.11（`node-gyp` 用）
- **Linux 构建**：`build-essential`、`python3`、`libfuse2`（运行 AppImage 时需要）
- **macOS**：未维护，如需自行尝试请准备 Xcode Command Line Tools

### 步骤 / Steps

1. **克隆仓库 / Clone**

   ```bash
   git clone https://github.com/OgalinLabM0/Kumiko-Amadeus.git
   cd Kumiko-Amadeus
   ```

2. **安装依赖 / Install**

   ```bash
   npm install
   ```

3. **拉取角色资源包 / Fetch character assets**

   ```bash
   npm run fetch-assets
   ```

   从 [GitHub Releases](https://github.com/OgalinLabM0/Kumiko-Amadeus/releases/latest) 下载 `kumiko-assets.zip`（约 135 MB）并解压到项目根目录。幂等：已有资源时自动跳过。换源：`ASSETS_URL=https://example.com/kumiko-assets.zip npm run fetch-assets`。

4. **补 ONNX 模型 / Add ONNX model**

   仓库里已带分词器文件：

   ```
   models/bge-m3-onnx/tokenizer.json
   models/bge-m3-onnx/tokenizer_config.json
   ```

   缺的是权重，下载到 `models/bge-m3-onnx/model_int8.onnx`：

   - 官方直链：<https://huggingface.co/Xenova/bge-m3/resolve/main/onnx/model_int8.onnx?download=true>
   - 国内镜像：<https://hugging-face.cn/Xenova/bge-m3/resolve/main/onnx/model_int8.onnx?download=true>

   或者用辅助脚本一条命令搞定：`node scripts/fetch-bge-model.cjs`。

   安装器（Setup.exe / AppImage）里已经内置这个模型，**只在从源码构建时**需要补。

5. **配置环境变量 / Configure environment**

   ```bash
   cp .env.example .env
   # 编辑 .env 填入 API Key（必需）+ 其他可选配置
   ```

6. **开发模式 / Dev mode**

   ```bash
   npm run desktop:dev
   ```

   同时启动 Vite 开发服务器 + Electron 窗口，带热重载。

7. **构建安装包 / Build installer**

   ```bash
   npm run desktop:build
   ```

   构建产物在 `release/` 下，Windows 主机产出两个 `Setup-<arch>.exe`，Linux 主机产出两个 `.AppImage`。**Linux AppImage 必须在 Linux 主机（或 WSL2 / CI）上构建**，`hnswlib-node` 无 Linux 预编译、必须本地 `node-gyp` 重编译，Windows 工具链不能跨编译到 Linux。

### 缺少资源包 / 模型时的行为

如果没跑 `fetch-assets`、没补 `model_int8.onnx`：

- 情绪立绘显示为文字占位符
- 铃声使用系统默认提示音
- 来电界面头像显示为「久」字
- 世界书为空（人格设定保留，但没有高中回忆）
- 剧情记忆为空
- RAG 检索无法启动（缺模型）

## 云端构建 / Cloud build (GitHub Actions)

没有本地 Linux / Windows 设备时，可以在 GitHub Actions 上跑云端构建。仓库内置两条 workflow：

| Workflow | 产物 |
| --- | --- |
| [`.github/workflows/linux-appimage.yml`](.github/workflows/linux-appimage.yml) | Linux x64 + ARM64 AppImage、`latest-linux*.yml`、`kumiko-assets.zip` |
| [`.github/workflows/windows-release.yml`](.github/workflows/windows-release.yml) | Windows x64 + ARM64 NSIS installer、`latest.yml` / `latest-arm64.yml` |

### 如何触发

1. 仓库页 → `Actions` → 左侧选对应 workflow → 右侧 `Run workflow`
2. 选择 `publish`：
   - `publish=false`（默认）：产物作为 workflow artifact 上传 + 跑 smoke test，**不动任何 GitHub Release**。用于首次编译验证。
   - `publish=true`：附加跑 `electron-builder --publish always`，把产物直接追加到 `package.json#version` 对应的 GitHub Release（`releaseType: release`，不存在则自动新建并直接以 non-draft 状态发布，GitHub 会把最高 semver 自动标记为 `latest`）。用于实际发版。

两条 workflow 都是 15–30 分钟完成；ARM64 因为要本地 `node-gyp`，比 x64 慢一些。

### `publish=true` 前需要的配置

| 选项 | 做什么 | 说明 |
| --- | --- | --- |
| 自建 PAT | Settings → Secrets → Actions → `GH_TOKEN` = 你的 classic PAT（勾 `repo` scope） | **推荐**，workflow 优先用 `GH_TOKEN` |
| 什么都不配 | 回退到 Actions 内置 `GITHUB_TOKEN` | 只能发布到**当前仓库**的 release，`permissions: contents: write` 已内置 |

### Artifact 命名

- `kumiko-amadeus-linux-x64.zip` / `kumiko-amadeus-linux-arm64.zip`
- `kumiko-amadeus-windows-x64.zip` / `kumiko-amadeus-windows-arm64.zip`

Artifact 默认保留 14 天。实际发版的权威产物在 GitHub Release 页。

## 其他说明

- API Key 在软件内设置页配置即可，本地加密存储
- 本地记忆数据库保存在 Electron 用户数据目录（Windows: `%APPDATA%/Kumiko-Amadeus`，Linux: `$XDG_DATA_HOME/Kumiko-Amadeus`）
- [`ping-server/`](ping-server/README.md) 是浏览器 Web Push 的本地测试工具，仅开发用途；不要把私钥提交进仓库
- 应用内有一本「**全知全能之书**」是完整系统档案，描述所有模块真实实现；README 讲"是什么 / 为什么"，那本书讲"具体怎么跑的"

---

## 版权声明 / Copyright & Legal Notice

本项目为非商业同人作品（Fan Work），基于武田绫乃原作小说《吹响吧！上低音号》
（响け！ユーフォニアム）及京都动画（Kyoto Animation）制作的同名动画系列。

This project is a non-commercial fan work based on the novel series
"Hibike! Euphonium" (Sound! Euphonium) by Ayano Takeda and the anime
series produced by Kyoto Animation Co., Ltd.

### 权利归属 / Attribution

- 原作小说 / Original Novel：© 武田绫乃 / 宝岛社 (Takarajimasha)
- 动画作品 / Anime Series：© 武田绫乃・宝岛社／『响け！』制作委员会
- 角色设计 / Character Design：© 京都アニメーション (Kyoto Animation)
- 本项目中使用的角色名称、剧情设定均为上述权利人所有。
  All character names and story settings used in this project belong to the above rights holders.

### 免责声明 / Disclaimer

- 本项目不以任何形式获取商业利益。
  This project does not generate any commercial profit in any form.
- 本项目不代表原作者或版权方的官方立场。
  This project does not represent the official position of the original authors or rights holders.
- 本项目中的角色行为、对话均为 AI 生成的同人创作，与原作无关。
  All character behaviors and dialogues in this project are AI-generated fan creations, unrelated to the original work.
- 如权利方提出异议，将立即配合处理。
  If the rights holders raise any objections, we will immediately comply and take appropriate action.
- 项目源码本身（不含角色资产）采用 MIT 许可证。
  The project source code itself (excluding character assets) is licensed under MIT.

### 角色资产声明 / Character Assets

本仓库的源代码不包含任何版权素材。角色立绘、语音铃声、剧情数据等资产文件通过独立的资源包分发，仅供个人学习交流使用，禁止商业用途。

All character-specific assets (artwork, voice ringtones, story data) are distributed separately and are NOT included in this repository's source code. They are provided solely for personal, non-commercial, educational use. Commercial use is strictly prohibited.
