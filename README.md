# 小尘（TenBot）

TenBot 是 SanWang 内部使用的 QQ Bot，使用 TypeScript、Node.js 和 QQ 官方 Bot API。它提供本地 QQ 命令、群聊互动、Minecraft 状态查询和 AI 回复；AI 是 Bot 的一项能力，不是整个运行时。

## 功能

- **本地命令**：命令由 Node.js 在本地执行，不会进入 AI 对话。未知的斜杠命令也会收到本地提示。
- **群聊触发**：@ 小尘会触发回复；提到“小尘”或继续活跃会话属于软触发，模型可以选择不回复。私聊消息进入回复流程。
- **Reply Cycle**：每个会话同一时间最多运行一个 AI Attempt。新消息可以中断生成并用最新上下文重试；单个 Cycle 最多处理中断 3 次，之后到来的消息会排入后续 Cycle。普通 Attempt 超时为 30 秒，可在同一 Cycle 重试一次；实际开始网页搜索后，Cycle 总时限最多为 120 秒。
- **QQ 回复**：模型通过统一的 qq_reply 能力决定回复内容，支持 1～3 条消息、每条消息的引用偏好和已知群成员 @。引用消息 ID 和 QQ API payload 由 Runtime 管理，不会交给模型。
- **网络梗知识**：本地 memes.json 支持中文、别名、拼音和首字母模糊检索。自动检索最多提供 3 个候选，由模型结合聊天上下文判断是否使用；模型也可调用只读 meme_lookup 查询详情。
- **自动账号防循环**：可按稳定群成员 ID 登记自动化账号。每个会话连续由登记账号启动的 AI Cycle 默认最多 4 次；达到限制后暂停 AI 调用，收到未登记成员的消息后重置。
- **Minecraft 状态**：/mc 命令、状态卡刷新按钮和 AI 的 Minecraft 状态查询共用同一查询能力。
- **本地全屏 TUI**：以 alternate screen 接管终端，查看运行状态、模型、Prompt、Meme、对话、自动账号和日志；退出后恢复原来的终端内容。

## 安装与配置

需要 Node.js 22 或更新版本，以及 pnpm。仓库使用 pnpm 12.5.1。

    pnpm install

在项目根目录创建本地 .env。以下是 GPT 配置示例；将值替换为自己的凭据和 Responses API 兼容服务地址：

    QQBOT_APP_ID=你的 QQ Bot 应用 ID
    QQBOT_APP_SECRET=你的 QQ Bot 应用密钥
    AI_PROVIDER=gpt
    CODEX_API_KEY=你的 GPT 服务密钥
    CODEX_BASE_URL=你的 Responses API 兼容地址

GPT 可选设置 CODEX_MODEL、CODEX_REASONING_EFFORT 和 CODEX_VERBOSITY，默认分别为 gpt-6-sol、high、high。推理强度支持 none、low、medium、high、xhigh；输出详细度支持 low、medium、high。

使用 DeepSeek 时，将 AI_PROVIDER 设为 deepseek，并配置独立密钥：

    AI_PROVIDER=deepseek
    DEEPSEEK_API_KEY=你的 DeepSeek API 密钥

DEEPSEEK_BASE_URL 可选，默认值为 https://api.deepseek.com；DEEPSEEK_MODEL 和 DEEPSEEK_REASONING_EFFORT 可选，默认分别为 deepseek-flash 和 high。DeepSeek 当前没有输出详细度配置。GPT 和 DeepSeek 在进程启动时选择其一；未设置 AI_PROVIDER 时使用 GPT，不会在请求失败后自动切换 Provider。

其他可选设置：

| 变量 | 用途 |
| --- | --- |
| BOT_LOG_LEVEL | 日志级别：info、debug 或 error |
| AUTOMATED_PEER_IDS | 逗号分隔的已登记自动化账号稳定成员 ID |
| BOT_LOOP_GUARD_MAX_CYCLES | 每个会话的连续自动账号 AI Cycle 上限，默认 4，必须是大于等于 1 的整数 |

也可以复制 [.env.example](.env.example) 作为配置模板。`.env` 仍是配置持久化来源，TUI 只通过 ConfigStore 修改公开的普通配置；secret 只用于判断“已配置”，不会显示原文或掩码。

不要把 .env 或真实凭据提交到 Git。AUTOMATED_PEER_IDS 使用 QQ 事件中的稳定成员 ID（member_openid），不使用昵称，也不会推测账号是否自动化。可在 TUI 的自动账号页查看稳定 ID；完整 ID 属于敏感信息，不要公开粘贴。

## 运行

普通日志模式：

    pnpm dev

终端控制界面：

    pnpm tui

TUI 是中文全屏控制台，支持 PowerShell 和 WebStorm Terminal。进入后使用左侧导航和右侧主内容区；退出时会恢复普通终端、光标和鼠标模式。

进入“设置”页后可以编辑：

- 模型提供商：GPT 或 DeepSeek
- GPT / DeepSeek 模型名称
- GPT / DeepSeek 推理强度
- GPT 输出详细度
- 日志级别
- 自动账号连续交互上限
- 自动账号的添加和删除

修改会先经过确认，再只更新 `.env` 中对应的变量；未知变量、secret、注释、空行和原有换行风格会保留。模型、日志级别和连续交互上限需要重启 TenBot 后生效，当前不支持运行时 Provider 热切换或自动重启。保存后请按 `Q` 退出，再重新运行 `pnpm tui`。自动账号添加和删除会立即更新当前运行时的 ID allowlist，不会清空已有会话计数或改变正在执行的 Cycle。

TUI 快捷键：

| 按键 | 操作 |
| --- | --- |
| ↑ / ↓ | 移动侧栏、设置项或自动账号；日志页中逐行查看 |
| Enter | 打开页面；在设置页修改配置；确认弹窗操作 |
| Esc | 从主区返回侧栏；关闭或返回弹窗 |
| Tab | 在侧栏和主内容区之间切换焦点 |
| A / Delete | 添加最近发现的自动账号 / 删除已登记账号 |
| P | 重载当前模型提供商的 Prompt |
| M | 重载 memes.json |
| R | 弹出确认后同时重载 Prompt 和 Meme 数据 |
| ? | 打开帮助 |
| PageUp / PageDown | 日志翻页 |
| Home / End | 日志跳到最早 / 最新 |
| Q 或 Ctrl+C | 打开退出确认；在确认框按 Enter 后优雅关闭 |

### 自动账号

自动账号使用 QQ 群消息中的稳定成员 ID 登记，身份判断不依据昵称、消息内容或平台 Bot 标记。自动账号页展示已登记账号和最近出现的群成员；最近成员只保存在内存中，最多保留 100 个，重启后清空。选择最近成员后可以查看完整稳定 ID 并确认添加；已登记账号可确认删除。平台的 Bot 标记只作提示，必须由用户主动登记。添加或删除后，Guard 对后续新消息立即使用更新后的 ID 列表；已有会话计数保持不变。

### 鼠标操作

键盘操作始终可用。支持左键点击侧栏页面、设置项、自动账号列表行、选择项和弹窗按钮；鼠标不可用时自动退回键盘操作。暂不支持右键、拖拽、文本选择或滚轮手势。

### 退出

正常运行时按 `Q` 或 `Ctrl+C` 会打开“退出 TenBot”确认框；按 Enter 才会优雅停止 QQ Runtime 并退出，Esc 取消。Runtime 启动失败或发生 fatal shutdown 时直接执行清理退出。

TUI 与 QQ Runtime 在同一进程运行，通过 TenBotControl 读取可序列化状态、订阅日志和 Runtime event，并执行配置保存、重载与关闭。Prompt 和 Meme 仍由外部编辑器维护，TUI 负责查看、热加载和显示状态；当前不支持运行时切换 Provider。当前没有 HTTP API 或 WebSocket 服务。

如果当前 stdin 或 stdout 不是 TTY，`pnpm tui` 会显示中文提示并正常退出，请使用普通终端或运行 `pnpm dev`。

## QQ 命令

| 命令 | 说明 |
| --- | --- |
| /help | 查看可用命令 |
| /mc | 查询 Minecraft 服务器状态 |
| /members | 查看目前认识的群成员 |
| /at 昵称 | 测试 @ 已知群成员 |

群聊中可以在命令前 @ 小尘。命令和未知斜杠命令由本地路由处理，不会触发 AI。/members 显示 Bot 已见过的成员，不等于 QQ 群的完整成员列表。

## Meme 知识库

知识文件位于 src/skills/meme/data/memes.json。每条 Meme 包含：

- id、name、aliases
- summary、origin、meaning、usage
- examples
- 可选的 interactions（常见输入及接法）

Runtime 会校验 JSON、条目字段及重复 ID、名称和别名，再建立拼音模糊检索索引。索引仅保存在内存中。TUI 按 m 或 r 时会完整重新校验并重建索引；重载失败会保留上一个可用版本。正在运行的 AI Attempt 继续使用开始时取得的数据快照。

如需研究和更新知识文件，可运行独立脚本：

    pnpm meme:update --dry-run
    pnpm meme:update --dry-run --limit 5
    pnpm meme:update "要研究的梗"
    pnpm meme:update --dry-run "要研究的梗"

不指定主题时默认最多研究 8 条；--limit 可设为 1 到 10。指定主题时只研究该主题。脚本使用 CODEX_API_KEY 和 CODEX_BASE_URL 调用 GPT Responses API 与 web_search，因此即使 Bot 选择 DeepSeek，运行该脚本仍需配置 GPT 服务。写入后请检查 memes.json 的 Git diff 和资料来源；脚本不会替你提交 Git。

## 数据与隐私

已知群成员资料使用本地 SQLite，默认文件为 data/bot.db；数据库不可用时，本次运行会退回内存存储。最近聊天上下文、活跃会话和自动账号循环限制状态保存在内存中，进程重启后清零。

API 密钥、QQ 凭据、完整成员 ID 和消息引用 ID 不会放入 TUI 状态 DTO 或作为普通模型上下文传递。debug 日志可能显示用于登记自动化账号的完整成员 ID，请谨慎启用和保存。

## 开发检查

    pnpm exec tsc --noEmit
    pnpm test

测试使用本地 fake 和 mock，不需要连接 QQ、GPT 或 DeepSeek 服务。

## 项目结构

    src/main.ts                    普通模式入口
    src/runtime.ts                 共享 Runtime 启动与关闭
    src/control/                   TenBotControl 与状态、日志 DTO
    src/config/                    AppConfig、PublicConfig 与 .env ConfigStore
    src/tui/                       Ink 终端控制界面
    src/qq/                        QQ 事件、上下文、触发和回复流程
    src/commands/                  本地命令路由
    src/skills/                    Minecraft、Meme 和 QQ 回复能力
    src/ai/                        统一模型接口及内置 Provider
    src/ai/plugins/gpt/             GPT 适配与独立 Prompt
    src/ai/plugins/deepseek/        DeepSeek 适配与独立 Prompt
    scripts/meme-update.ts          Meme 资料研究与更新工具
    src/skills/meme/data/memes.json  本地 Meme 知识数据
