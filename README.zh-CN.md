# AutoTalon v0.1.0

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/XD319/auto-talon/actions/workflows/ci.yml/badge.svg)](https://github.com/XD319/auto-talon/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.11.0-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**AutoTalon 是一个本地优先、带治理和记忆能力的个人 agent。**

它不是一次性 prompt runner，也不是托管式助理。AutoTalon 给单个操作者一个可长期运行的 agent：可以对话、调用工具、记住工作、运行计划任务、从聊天 gateway 进入，并留下可检查的执行痕迹。主要交互面是 `talon tui`；CLI 负责自动化和诊断；飞书/Lark 与本地 webhook gateway 把外部会话接入同一个受治理的运行时。

## 为什么是 AutoTalon

- **长期运行的操作者 agent**：`talon tui` 把对话、session、inbox、todo、记忆复查、审批和运行时状态放在同一个终端交互面里。
- **默认受治理的工具调用**：shell、process、network、file 工具经过 sandbox policy、approval rule、trace event、audit log 和 rollback artifact。
- **可积累的记忆**：profile、project、working、experience、skill 分层记忆跨任务可用，同时保留 recall 来源。
- **Provider 自由度**：通过统一 provider catalog 配置 OpenAI-compatible、Anthropic-compatible、Ollama、OpenRouter、GLM、Moonshot、Qwen、xAI、Gemini、MiniMax、讯飞、mock 或自定义兼容 endpoint。
- **多个入口，共用同一运行时**：TUI、CLI、飞书/Lark、本地 webhook 和 MCP surfaces 共享 session、记忆和治理规则。
- **维护者级诊断能力**：源码仓库内置 replay、smoke fixture、eval report、beta readiness、release check 和 npm pack dry-run。

## 安装

要求：

- Node.js `>=22.13.0`
- 真实助理运行需要 provider API key
- 从源码运行时需要 Corepack

安装发布包：

```bash
npm install -g auto-talon
talon init --yes
talon provider setup openai --api-key "$OPENAI_API_KEY"
talon provider test
talon tui
```

从源码运行：

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev provider setup openai --api-key "$OPENAI_API_KEY"
corepack pnpm dev provider test
corepack pnpm dev tui
```

## 工作流

日常 agent 入口：

```bash
talon tui
talon ops
```

可脚本化的终端执行：

```bash
talon run "review the changed files"
talon continue --last
talon task list
talon trace <task_id> --summary
talon audit <task_id> --summary
```

Provider 运维：

```bash
talon provider list
talon provider setup openai --api-key "$OPENAI_API_KEY"
talon provider use ollama
talon provider status
talon provider test
talon provider route "large coding task"
```

外部入口：

```bash
talon gateway serve-webhook --port 7070
talon gateway serve-feishu --cwd .
talon gateway list-adapters
```

自动化与连续性：

```bash
talon schedule create "Review my inbox and summarize blockers" --name "Daily inbox review" --every 1d
talon inbox list
talon commitments list
talon next list
talon memory review-queue list
```

## v0.1.0 能力

| 领域 | 已包含能力 |
| --- | --- |
| Agent 体验 | TUI chat、session 浏览、transcript view、status line、approval、memory、todo、operations panel |
| CLI 执行 | `run`、`continue`、task/session 检查、trace/audit view、workspace map、rollback、doctor |
| 治理 | Policy engine、sandbox scope、approval prompt、持久 allow rule、audit log、rollback snapshot |
| 记忆 | Profile/project/working memory、experience ref、skill ref、recall explanation、review queue、snapshot |
| 调度 | One-shot、interval、cron、自然语言 timing、execution mode、run queue、inbox/origin/webhook delivery |
| Provider | Provider catalog、setup/use/promote、health check、smoke test、route diagnostic、usage statistics |
| Gateway | 本地 webhook 与飞书/Lark adapter，共享 runtime、identity mapping 和 session commands |
| MCP 与 Skills | MCP client/server surfaces、skill registry、skill assets、draft、promotion、enable/disable override |
| 诊断 | Smoke suite、eval report、beta readiness、replay、release checklist、npm pack contents validation |

## 安全模型

AutoTalon 面向需要真实工具权限、但也需要可见护栏的本地操作者。

- 本地状态存放在 `.auto-talon/`，包括 SQLite 数据、日志、artifact、config、approval rule 和 rollback snapshot。
- 高风险工具可以在执行前要求显式审批。审批决策会生成 fingerprint，并可通过持久规则限定作用范围。
- Shell 和文件系统访问会在执行前经过 sandbox policy 和项目边界检查。
- Tool call、provider event、approval、policy decision、file write 和 rollback artifact 都会记录，便于事后检查。
- 飞书/Lark 与 webhook 输入通过 gateway adapter 进入，因此会共享同一套 runtime policy，而不是绕过本地治理层。

在暴露 gateway 或处理敏感项目目录前，请阅读 [SECURITY.md](SECURITY.md)。

## 范围和限制

- 不支持 Node.js 20。AutoTalon 要求 Node.js `>=22.13.0`，因为运行时存储依赖内置 `node:sqlite` 模块。
- AutoTalon 是本地优先、面向单个操作者的 agent，不是托管 SaaS、团队控制平面或多租户 agent 服务。
- 真实 provider 运行需要用户自行提供凭据。Mock 和 scripted smoke provider 只用于测试和诊断。
- v0.1.0 包含飞书/Lark 与本地 webhook gateway adapter；Slack、Telegram、Discord、语音、浏览器自动化、图像生成、桌面/移动 companion app 不在本次发布范围内。
- `talon release check`、`talon eval run`、`talon smoke run` 是源码仓库维护者诊断命令。已安装包用户应从 `talon doctor` 和 `talon provider test` 开始。

## 按目标阅读文档

| 目标 | 入口 |
| --- | --- |
| 安装和首次运行 | [安装](docs/user/install.md)、[快速开始](docs/user/quickstart.md) |
| 学习 CLI/TUI 命令 | [命令](docs/user/commands.md) |
| 配置 provider 和运行时 | [配置参考](docs/user/config-reference.md)、[Provider 排查](docs/troubleshooting/provider.md) |
| 理解审批和 sandbox | [审批](docs/user/approvals.md)、[Sandbox 排查](docs/troubleshooting/sandbox.md) |
| 接入外部入口 | [Gateway](docs/user/gateway.md)、[Gateway 排查](docs/troubleshooting/gateway.md) |
| 使用记忆和 skills | [Skills](docs/user/skills.md)、[Memory 排查](docs/troubleshooting/memory.md) |
| 集成 MCP | [MCP](docs/user/mcp.md) |
| 验证发布 | [Replay 与 eval](docs/user/replay-and-eval.md)、[兼容矩阵](docs/compatibility-matrix.md) |
| 开发 AutoTalon | [架构](docs/dev/architecture.md)、[模块边界](docs/dev/module-boundaries.md)、[测试](docs/dev/testing.md) |

## 发布验证

在打 tag 或发布 v0.1.0 前运行：

```bash
corepack pnpm check
npm run release:check
npm pack --dry-run --json
```

安装或更新本地项目后运行：

```bash
talon doctor
talon provider test
```

Release checklist 覆盖 lint、tests、build、smoke/eval 阈值、beta readiness、schema baseline、Node version policy、npm metadata、lockfile policy、setup scripts 和 package contents。

## License

MIT. See [LICENSE](LICENSE).
