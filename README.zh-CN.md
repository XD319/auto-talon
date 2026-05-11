# AutoTalon v0.1.0

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/XD319/auto-talon/actions/workflows/ci.yml/badge.svg)](https://github.com/XD319/auto-talon/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.13.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.11.0-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

面向日常执行的个人助理工作区。

AutoTalon 面向希望长期运行个人助理、同时保留可检查性、本地控制权和成本意识的知识工作者。`talon tui`
是日常工作的默认入口：today、inbox、threads、memory review 和受治理的任务执行都集中在同一个工作区中。CLI
负责自动化、诊断和维护；Feishu/Lark 与 webhook gateway 则提供接入同一运行时的正式外部聊天入口。

## 主要入口

- `talon tui`
  用于对话、处理 inbox、跟进线程以及进行带记忆能力执行的日常工作区。
- `talon gateway serve-feishu`
  Feishu/Lark 的外部即时通讯入口，适合把助理放进聊天工作流。
- `talon run` / `talon continue`
  面向自动化、批处理和精确排查的终端脚本化入口。

## 能力概览

- 通过 `talon tui` 打开围绕 today / inbox / thread 的个人助理工作区。
- 通过 Feishu/Lark 和本地 webhook adapter 提供正式聊天接入。
- 在本地 SQLite 工作区中记录任务状态、trace 事件、tool call、approval 和 audit log。
- 通过策略和显式审批治理高风险工具调用。
- 在 TUI 和 CLI 中提供 memory review，包括 used-memory 反馈和 inbox 驱动的建议。
- 提供分层记忆模型：`profile` / `project` / `working` + `experience_ref` / `skill_ref`。
- 通过 `talon ops` 和 CLI 检查命令保留运行时观测能力。
- 在源码仓库中支持 replay、smoke tests、eval reports 和维护者 release checks。

## 演示

```text
$ talon init --yes
Initialized .auto-talon workspace files.

$ talon tui
# 打开日常工作区。
# 启动或继续线程、处理 inbox 项、查看 memory 建议。

$ talon task list
$ talon trace <task_id> --summary
$ talon audit <task_id> --summary
# 需要精确检查或自动化时再切回 CLI。
```

## 快速开始

环境要求：

- Node.js `>=22.13.0`
- 从源码安装时启用 Corepack

安装发布包：

```bash
npm install -g auto-talon
talon init --yes
talon tui
```

可选聊天平台入口：

```bash
talon gateway serve-feishu --cwd .
```

源码运行：

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm dev init --yes
corepack pnpm dev tui
```

## 典型流程

在 TUI 中完成日常工作：

```bash
talon tui
talon ops
```

把助理接入聊天平台：

```bash
talon gateway serve-feishu --cwd .
talon gateway list-adapters
```

通过 CLI 自动化或排查：

```bash
talon run "review the changed files"
talon continue --last
talon task list
talon trace <task_id> --summary
talon audit <task_id> --summary
```

本地 API / SDK 集成：

```bash
talon gateway serve-webhook --port 7070
```

验证 provider：

```bash
talon provider list
talon provider test
```

## 适用场景

- 你想要一个以 TUI 为中心、同时具备可审计执行历史的个人助理工作区。
- 你希望 today / inbox / thread 操作贴近终端工作流，但不想让产品退化成一次性 prompt 执行器。
- 你希望助理可以在 TUI、CLI 和聊天平台入口之间切换，并共享同一套 governed runtime、memory、approvals 和 audit trail。
- 你需要在文件或 shell 操作前具备策略与审批行为。
- 你想围绕持续性知识工作使用 durable memory、skill recall、replay 和 eval 工具，而不只是一次性问答。

## 产品定位

AutoTalon 是一个面向个人操作者和知识工作者的本地优先个人助理产品，背后是可检查的运行时，而不是托管黑盒。面向用户的承诺是一个低成本、可长期使用的助理：以 TUI 工作区为主入口，辅以 CLI 自动化与诊断，并通过 Feishu/Lark 等 adapter 提供正式外部聊天入口。核心包保持轻量，相关集成只在对应 gateway 命令运行时加载。运行时观测通过 `talon ops` 提供，`talon dashboard` 作为兼容别名保留。

## 文档

用户文档：

- `docs/user/install.md`
- `docs/user/quickstart.md`
- `docs/user/commands.md`
- `docs/user/replay-and-eval.md`
- `docs/user/approvals.md`
- `docs/user/skills.md`
- `docs/user/gateway.md`
- `docs/user/mcp.md`
- `docs/user/config-reference.md`

开发者文档：

- `docs/dev/architecture.md`
- `docs/dev/module-boundaries.md`
- `docs/dev/plugin-development.md`
- `docs/dev/testing.md`

故障排查：

- `docs/troubleshooting/provider.md`
- `docs/troubleshooting/sandbox.md`
- `docs/troubleshooting/gateway.md`
- `docs/troubleshooting/memory.md`

## 发布校验

```bash
corepack pnpm check
corepack pnpm dev release check
```

`talon eval run`、`talon smoke run` 和 `talon release check` 是源码仓库中的维护者诊断命令。安装发布包后的普通用户应使用 `talon doctor` 和 `talon provider test` 检查工作区健康状态。
