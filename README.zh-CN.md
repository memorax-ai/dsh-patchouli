<div align="center">
  <img width="100%" alt="Patchouli" src="assets/patchouli-banner-zh.png">

  <h1>Patchouli</h1>
  <p>
    <strong>面向 DeepSeek Harness 的本地记忆和知识中枢。</strong>
    <br />
    以数据、算法解耦的形式，对异构的 Agent 数据增强进行整合。
  </p>

  [English](README.md) · **简体中文**

  [![Documentation](https://img.shields.io/badge/docs-read-75439a?logo=readthedocs&logoColor=white)](https://memorax-agent.github.io/dsh-patchouli/)
  [![CI](https://github.com/memorax-agent/dsh-patchouli/actions/workflows/ci.yml/badge.svg)](https://github.com/memorax-agent/dsh-patchouli/actions/workflows/ci.yml)
  [![License: MIT](https://img.shields.io/badge/license-MIT-2f6f4e.svg)](LICENSE)
  [![Node.js](https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24-2f6f4e?logo=nodedotjs&logoColor=white)](https://memorax-agent.github.io/dsh-patchouli/installation)
  [![Rust](https://img.shields.io/badge/Rust-stable-b55b3d?logo=rust&logoColor=white)](https://memorax-agent.github.io/dsh-patchouli/installation)
</div>

## 概述

Patchouli 在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
内提供统一的 `update`、`retrieve`、`subscribe` 服务。连接器负责提供可信的运行时数据，
记忆和知识插件负责各自的算法，独立的 Rust 后端负责持久化事务存储。

DeepSeek Harness 是目前首个受支持的集成，数据库后端本身不依赖任何 Harness。

## 核心能力

- 提供由插件控制路由、聚合和来源标记的统一 Memory Service。
- 通过可配置 Hook 和模型 Tool 接入 Agent Loop。
- 支持本地或远程记忆与知识实现。
- 将图片和工作区文件摄取为类型化 Artifact。
- 提供持久化订阅，以及支持 SQLite 和远程 Provider 的事务化 Rust 后端。

<!-- AGENTS: Before installing, integrating, extending, reviewing, or debugging Patchouli, read the main-branch skill at https://github.com/memorax-agent/dsh-patchouli/blob/main/.agents/skills/use-dsh-patchouli/SKILL.md. -->
<details>
<summary><strong>AI Agent：请先读取仓库 Skill</strong></summary>

安装、接入 DSH、开发 MemoryPlugin、扩展存储或后端，以及排查问题前，请先加载 [`use-dsh-patchouli`](https://github.com/memorax-agent/dsh-patchouli/blob/main/.agents/skills/use-dsh-patchouli/SKILL.md)。

</details>

## 安装与使用

需要 Node.js `^22.19.0 || >=24`、pnpm 11，以及兼容 `0.1.0-rc.6` 的
DeepSeek Harness。首个打包版本发布前，请从当前源码分支安装：

```bash
git clone --branch main --single-branch https://github.com/memorax-agent/dsh-patchouli.git
cd dsh-patchouli
corepack enable
pnpm install
cargo install --locked --path crates/server
patchouli-db init --root "$HOME/.patchouli"
dsh plugin --profile web add \
  . \
  ./packages/agent-loop \
  ./packages/artifact-ingestor \
  ./packages/session-indexer \
  ./packages/workspace-indexer
dsh --profile web --dump-config
```

构建事务化数据库后端需要 Rust stable 和 C 工具链。随附的 DSH Profile
默认启用存储客户端，它会连接本地守护进程，并在需要时自动启动。最后一个
命令应列出 `patchouli`、`patchouli-storage` 及各连接器插件。Patchouli
需要至少注册一个兼容的记忆或知识插件，才能实际处理路由后的 `update`、
`retrieve` 和 `subscribe` 调用。默认情况下，Agent Loop 连接器会在每个
Agent Step 前检索信息、在 Turn 完成后写入信息，并向模型提供记忆存取工具。

这些 workspace 包路径只在源码 `link:` 安装时需要；正式发布包会随根包
自动安装对应依赖。

配置和各平台的详细说明参见
[快速开始](https://memorax-agent.github.io/dsh-patchouli/getting-started)。

## 这个插件的名字是什么意思？？？

名称直接来自 [Patchouli Knowledge](https://en.touhouwiki.net/wiki/Patchouli_Knowledge)，同时致敬广为人知的 Minecraft 模组 [Patchouli](https://github.com/VazkiiMods/Patchouli)。
