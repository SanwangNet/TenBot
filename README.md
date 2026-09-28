# 小尘（TenBot）

TenBot 是 SanWang 内部使用的 QQ Bot，使用 TypeScript、Node.js 和 QQ 官方 Bot API。它提供本地 QQ 命令、群聊互动、Minecraft 状态查询和 AI 回复；AI 是 Bot 的一项能力，不是整个运行时。

## 功能

- **本地命令**：命令由 Node.js 在本地执行，不会进入 AI 对话。未知的斜杠命令也会收到本地提示。
- **Front / Reply Judge**：私聊和显式 @ 小尘在两种模式下都由 Runtime 本地判为 hard、跳过 Judge，主模型必须回复。`FRONT_MODE=legacy`（默认）使用本地 trigger / engagement 信号决定群聊 pass 或 soft，不依赖 Judge；`FRONT_MODE=judge` 将非 hard 群聊交给独立 Reply Judge，false 为 pass，true 为 soft，主模型仍可选择 NO_REPLY。Judge 只接受严格的 {"reply":true} 或 {"reply":false} JSON；它只判断是否启动新 Reply Cycle，已有 Cycle 中的后续消息直接更新上下文并按现有机制中断/重启，显式 hard trigger 仍可升级回复义务。
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

DEEPSEEK_BASE_URL 可选，默认值为 https://api.deepseek.com；DEEPSEEK_MODEL 和 DEEPSEEK_REASONING_EFFORT 可选，默认分别为 deepseek-flash 和 high。DeepSeek 当前没有输出详细度配置。未设置 AI_PROVIDER 时使用 GPT；运行时切换由用户在 TUI 显式确认，不会因请求失败自动切换 Provider。

Front 使用 `FRONT_MODE=legacy|judge` 配置，默认 `legacy`。只有显式选择 `judge` 时才需要配置独立的 Reply Judge Provider；切换 Front 模式会随 `.env` 热重载，judge 配置无效时保留上一份有效快照。`judge` 模式使用 OpenAI-compatible Chat Completions；仓库没有内置 Jev 地址或凭据：

    REPLY_JUDGE_PROVIDER=openai-compatible
    REPLY_JUDGE_MODEL=你的判定模型
    REPLY_JUDGE_BASE_URL=你的兼容 API 地址
    REPLY_JUDGE_API_KEY=你的判定模型密钥

其他可选设置：

| 变量 | 用途 |
| --- | --- |
| BOT_LOG_LEVEL | Console 日志等级：all、debug、info、warn 或 error；默认 info。仅控制终端 / systemd journal 输出量 |
| BOT_TIME_ZONE | 模型时间语境和聊天记录时间展示使用的 IANA 时区；默认 Asia/Shanghai |
| AUTOMATED_PEER_IDS | 逗号分隔的已登记自动化账号稳定成员 ID |
| BOT_LOOP_GUARD_MAX_CYCLES | 每个会话的连续自动账号 AI Cycle 上限，默认 4，必须是大于等于 1 的整数 |
| REPLY_JUDGE_TIMEOUT_MS | Reply Judge 独立超时，默认 5000 毫秒，接受 1000–30000 毫秒 |

也可以复制 [.env.example](.env.example) 作为配置模板。`.env` 仍是配置持久化来源，TUI 只通过 ConfigStore 修改公开的普通配置；secret 只用于判断“已配置”，不会显示原文或掩码。

不要把 .env 或真实凭据提交到 Git。AUTOMATED_PEER_IDS 使用 QQ 事件中的稳定成员 ID（member_openid），不使用昵称，也不会推测账号是否自动化。可在 TUI 的自动账号页查看稳定 ID；完整 ID 属于敏感信息，不要公开粘贴。

## 运行

Runtime 同时提供本机 Web Control API，默认地址为 `http://127.0.0.1:3000`。用 `WEB_HOST` 和 `WEB_PORT` 可调整监听地址；修改后需重启 Runtime。管理 WebUI 使用 GitHub OAuth 登录，只允许服务端 allowlist 中的 GitHub numeric user ID；未配置认证时管理 API 会 fail closed，不会退化为匿名访问。

### GitHub WebUI 登录

在 GitHub 创建 OAuth App：

1. 打开 `Settings` → `Developer settings` → `OAuth Apps` → `New OAuth App`。
2. Production Homepage URL 填写 `https://bot.tenqui.ink`。
3. Authorization callback URL 填写 `https://bot.tenqui.ink/api/auth/github/callback`。
4. 将 OAuth App 的 Client ID、Client Secret 配置到服务端 `.env`，并配置回调 URL 与允许登录的 numeric user IDs：

```dotenv
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=
GITHUB_OAUTH_CALLBACK_URL=https://bot.tenqui.ink/api/auth/github/callback
GITHUB_OAUTH_ALLOWED_USER_IDS=
```

`GITHUB_OAUTH_ALLOWED_USER_IDS` 使用英文逗号分隔的 GitHub numeric user ID，不是 GitHub 用户名或邮箱。Client Secret 只保存在服务端 `.env`，不要放入 WebUI 或提交到 Git。OAuth 设置是启动级配置，更新后需重启 Runtime。开发环境可将 callback URL 配置为本机 HTTP 地址进行测试。

TenBot 的 `WEB_HOST` 应保持 `127.0.0.1`。公网访问应使用可信反向代理：Internet → Cloudflare → VPS `:443` → Caddy → `127.0.0.1:3000`；不要直接公开 TenBot 管理端口。

普通日志模式：

    pnpm dev

WebUI 开发时，在另一个终端运行 Vite：

    pnpm web:dev

打开终端显示的本机开发地址。Vite 会将 `/api` 请求转发给 Runtime。

生产构建和启动：

    pnpm web:build
    pnpm dev

构建后，浏览器访问 `http://127.0.0.1:3000/` 即可打开 WebUI；Runtime 仍默认只监听本机。未登录时显示 GitHub 登录页，所有管理 API 和 SSE 均要求有效 TenBot Session。

WebUI 提供总览、模型、提示词、梗数据、对话、自动账号、实时日志和设置。提示词与 Meme 数据可在 Monaco 编辑器中保存并热重载；保存会检查文件版本，Meme JSON 会先验证。编辑 API 只允许 TenBot 的四个固定资源 ID，不接受任意服务器路径。自动账号与设置修改仍经由 TenBotControl 应用。

终端控制界面：

    pnpm tui

TUI 是中文全屏控制台，支持 PowerShell 和 WebStorm Terminal。进入后使用左侧导航和右侧主内容区；退出时会恢复普通终端、光标和鼠标模式。

进入“设置”页后可以编辑：

- 模型提供商：GPT 或 DeepSeek
- GPT / DeepSeek 模型名称
- GPT / DeepSeek 推理强度
- GPT 输出详细度
- 自动账号连续交互上限
- 自动账号的添加和删除

修改会先经过确认，再只更新 `.env` 中对应的变量；未知变量、secret、注释、空行和原有换行风格会保留。Provider、模型参数、连续交互上限和自动账号 ID 会立即热重载；进行中的模型 Attempt 保留启动时的模型和 Prompt 快照，新 Attempt 使用最新配置。当前不支持自动重启。QQ App ID 或密钥变化需要重启 QQ Runtime。

设置页使用 Provider 卡片浏览 GPT 与 DeepSeek 配置。左右方向键只切换正在查看的卡片；选择“设为当前模型提供商”并确认后才会保存和热切换运行 Provider。密钥和 Base URL 不会显示在 TUI。

TUI 快捷键：

| 按键 | 操作 |
| --- | --- |
| ↑ / ↓ | 移动侧栏、设置项或自动账号；日志和对话页中逐个视觉行查看 |
| ← / → | 设置页切换 Provider 卡片；对话页切换群聊或私聊 |
| Enter | 打开页面；在设置页修改配置；确认弹窗操作 |
| Esc | 从主区返回侧栏；关闭或返回弹窗 |
| Tab | 在侧栏和主内容区之间切换焦点 |
| A / Delete | 添加最近发现的自动账号 / 删除已登记账号 |
| P | 重载当前模型提供商的 Prompt |
| M | 重载 memes.json |
| R | 弹出确认后同时重载 Prompt 和 Meme 数据 |
| ? | 打开帮助 |
| PageUp / PageDown | 日志或对话页翻约一页 |
| Home / End | 对话页跳到最旧 / 最新；日志页跳到最早 / 最新 |
| Q 或 Ctrl+C | 打开退出确认；在确认框按 Enter 后优雅关闭 |

### 自动账号

自动账号使用 QQ 群消息中的稳定成员 ID 写入 `.env` 的 `AUTOMATED_PEER_IDS`，重启后仍会恢复登记状态；身份判断不依据昵称、消息内容或平台 Bot 标记。管理菜单可查看 Bot/普通账号状态、设为 Bot 或取消 Bot，以及全局互聊上限。最近发现的群成员资料只保存在内存中，最多保留 100 个，重启后清空；缺少昵称时已登记账号仍显示为“未知账号”和短 ID。平台 Bot 标记只作提示，必须由用户主动登记。修改后 Guard 对后续新消息立即使用新列表，不清空已有会话计数。

### 对话观察

对话页只读展示进入最近上下文的群聊和私聊消息、模型 Attempt 状态和成功发送的回复。消息与 TenBot 左右对齐；被中断的 Attempt 会保留。位于最新位置时新消息自动跟随；查看历史时会保持当前消息行锚点。↑↓ 按视觉行滚动，PageUp/PageDown 翻约一页，Home/End 定位到最旧/最新。所有弹窗在终端窗口中央显示。最多缓存最近 20 个会话，每个会话 100 条 UI 记录，进程重启后清空。左右键切换会话。TUI 不会通过此页发送 QQ 消息。

### 日志显示

TenBot 始终完整采集所有日志等级。Runtime 将日志发送给文件 sink、TUI/WebUI/SSE listeners，以及独立的 Console 输出。日志异步追加到 `logs/tenbot-YYYY-MM-DD.all.log`、`logs/tenbot-YYYY-MM-DD.info.log`、`logs/tenbot-YYYY-MM-DD.warn.log`，按本地日期每天一个文件；`all.log` 包含 ALL、DEBUG、INFO、WARN、ERROR，`info.log` 包含 INFO、WARN、ERROR，`warn.log` 只包含 WARN、ERROR。WebUI 等级筛选只影响当前浏览器的显示，不影响运行时采集或浏览器日志缓冲；首次默认选择“信息”，并持久化到浏览器 localStorage。日志缓存会将相邻且级别、正文完全相同的记录折叠为一行，并用结构化重复次数显示；TUI 与 WebUI 共用这份最多 5000 行的缓存。磁盘日志逐条保存每个 logger event，不折叠。

`BOT_LOG_LEVEL` 是纯部署环境变量，只在进程启动时读取，并且只控制终端 / systemd journal 的 Console 输出阈值，支持 `all`、`debug`、`info`、`warn`、`error`，默认 `info`。例如 `BOT_LOG_LEVEL=info` 时，journalctl 显示 INFO/WARN/ERROR；DEBUG 和 ALL 仍会完整进入日志系统、日志文件和 WebUI。`BOT_LOG_LEVEL=all` 会让 Console 同时显示完整诊断日志，可能非常详细。该变量不影响 WebUI、SSE 或日志文件。

`BOT_TIME_ZONE` 使用 IANA 时区名称，例如 `BOT_TIME_ZONE=Asia/Shanghai`，用于模型当前时间语境及 Recent Context 消息时间展示，默认 `Asia/Shanghai`。TenBot 在每次模型 Attempt 时读取服务器系统时钟并按此时区格式化，不会请求第三方时间服务。

WebUI 日志页的等级筛选与服务器完全独立，首次默认为“信息”，并通过浏览器 localStorage key `tenbot.logs.level-filter` 持久化。即使服务端设置 `BOT_LOG_LEVEL=warn`，浏览器选择“完整诊断”仍能查看 ALL、DEBUG、INFO、WARN、ERROR。

`all` 是单条完整诊断日志的等级类型，不是全局模式。ALL 可能包含聊天内容、业务身份标识、Prompt、模型请求/响应和 Tool 数据；日志文件与 WebUI 诊断内容不要公开上传。Secret / credentials 仍会脱敏，包括 API key、App Secret、Authorization、Bearer token、Cookie、access/refresh/OAuth/session token、签名和私钥。

### 运行时热重载

TUI 设置页可保存 AI_PROVIDER、GPT/DeepSeek 模型、推理强度、GPT 输出详细度、Reply Judge 模型与超时时间、BOT_LOOP_GUARD_MAX_CYCLES 和 AUTOMATED_PEER_IDS。修改会先经过确认，再只更新 `.env` 中对应的变量；未知变量、secret、注释、空行和原有换行风格会保留。Provider、模型参数、连续交互上限和自动账号 ID 会立即热重载；进行中的模型 Attempt 保留启动时的模型和 Prompt 快照，新 Attempt 使用最新配置。GPT、DeepSeek 与 Reply Judge Prompt 文件以及 `memes.json` 都会在文件保存后自动校验并替换快照；手动 P/M/R 重载仍可用。重载失败时保留旧快照并显示安全提示。QQ App ID 或密钥变化需要重启；TUI 不会自动重启进程。

API Key 与 Provider Base URL 仍只通过 `.env` 管理，不会暴露给 TUI。`BOT_LOG_LEVEL` 在进程启动时读取，修改后需重启 Runtime；`BOT_TIME_ZONE` 是仅供模型输入使用的内部部署环境配置，不会显示或通过 Web/TUI 修改，外部 `.env` 变更会经 ConfigStore 重建 Runtime 配置快照。

### 错误码

错误码采用 Zone:Class_Stage_Reason 格式，例如 B:A_OP_TPL。Reply Judge 输出不符合严格 JSON 协议时会记录 F:A_RJ_IPO，QQ 公共错误格式为 ERROR: F:A_RJ_IPO。

### 鼠标操作

键盘操作始终可用。支持左键点击侧栏页面、设置项、自动账号列表行、选择项和弹窗按钮；鼠标不可用时自动退回键盘操作。暂不支持右键、拖拽、文本选择或滚轮手势。

### 退出

正常运行时按 `Q` 或 `Ctrl+C` 会打开“退出 TenBot”确认框；按 Enter 才会优雅停止 QQ Runtime 并退出，Esc 取消。Runtime 启动失败或发生 fatal shutdown 时直接执行清理退出。

TUI 与 QQ Runtime 在同一进程运行，通过 TenBotControl 读取可序列化状态、订阅日志和 Runtime event，并执行配置保存、重载与关闭。HTTP API 也通过同一个 TenBotControl 提供只读状态和 SSE 实时事件。Prompt 和 Meme 文件仍由外部编辑器编辑，TUI 负责查看、校验和热加载。

如果当前 stdin 或 stdout 不是 TTY，`pnpm tui` 会显示中文提示并正常退出，请使用普通终端或运行 `pnpm dev`。

## QQ 命令

### 管理员命令

群聊管理员命令为 `@小尘 /启用` 和 `@小尘 /停用`。在真实 `.env` 中填写 WebUI「已知成员」页面显示的 8 位 opaque member ID：

```dotenv
BOT_ADMIN_IDS=<Known Members 中的 8 位 ID>
```

请把尖括号占位符替换成实际 ID；多个管理员 ID 用逗号分隔。

保存 `.env` 后，运行中的 TenBot 会通过环境文件 watcher 自动热加载并生效，无需重启。

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

已知群成员资料、运行状态和 WebUI Session 使用本地 SQLite，默认文件为 `data/bot.db`；新环境自动应用新增的 Web auth migration。WebUI Cookie 保存随机 Session token，数据库仅保存 SHA-256 hash；Session 默认 7 天有效，登出后立即失效。SQLite 不可用时管理 API 保持锁定。最近聊天上下文、活跃会话和自动账号循环限制状态保存在内存中，进程重启后清零。

API 密钥、QQ 凭据和 Authorization、Bearer token、Cookie、access/refresh token 会在 Console、UI 与三份磁盘日志中持续脱敏。ALL 日志仍可能包含聊天内容、member/group OpenID、Prompt、模型请求/响应和 Tool 参数及结果；它只适合本机临时诊断，排障后恢复 debug/info，并且不要上传公开 issue。日志文件保存在被 Git ignore 的 `logs/` 目录。

## 开发检查

    pnpm exec tsc --noEmit
    pnpm test

测试使用本地 fake 和 mock，不需要连接 QQ、GPT 或 DeepSeek 服务。

## 项目结构

    src/main.ts                    普通模式入口
    src/runtime.ts                 共享 Runtime 启动与关闭
    src/control/                   TenBotControl 与状态、日志 DTO
    src/control/web-server.ts      同进程 HTTP API 与 SSE
    src/config/                    AppConfig、PublicConfig 与 .env ConfigStore
    src/tui/                       Ink 终端控制界面
    src/qq/                        QQ 事件、上下文、触发和回复流程
    src/commands/                  本地命令路由
    src/skills/                    Minecraft、Meme 和 QQ 回复能力
    src/ai/                        统一模型接口及内置 Provider
    src/front/                     Wake Level 与 Reply Judge 前置准入
    prompts/                       独立 Reply Judge Prompt
    src/ai/plugins/gpt/             GPT 适配与独立 Prompt
    src/ai/plugins/deepseek/        DeepSeek 适配与独立 Prompt
    scripts/meme-update.ts          Meme 资料研究与更新工具
    src/skills/meme/data/memes.json  本地 Meme 知识数据
