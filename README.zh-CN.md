<div align="center">
  <img width="100%" alt="Patchouli" src="assets/patchouli-banner-zh.png">

  <h1>Patchouli</h1>
  <p>
    <strong>面向 DeepSeek Harness 的本地记忆和知识中枢。</strong>
    <br />
    以数据、算法解耦的形式，对异构的 Agent 数据增强进行整合。
  </p>

  [English](README.md) · **简体中文**

  [![Powered by Harmony](https://memorax-ai.github.io/dsh-harmony/harmony-powered.svg)](https://memorax-ai.github.io/dsh-harmony/)
  [![Documentation](https://img.shields.io/badge/docs-read-75439a?logo=readthedocs&logoColor=white)](https://memorax-ai.github.io/dsh-patchouli/)
  [![CI](https://github.com/memorax-ai/dsh-patchouli/actions/workflows/ci.yml/badge.svg)](https://github.com/memorax-ai/dsh-patchouli/actions/workflows/ci.yml)
  [![License: MIT](https://img.shields.io/badge/license-MIT-2f6f4e.svg)](LICENSE)
  [![Node.js](https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24-2f6f4e?logo=nodedotjs&logoColor=white)](https://memorax-ai.github.io/dsh-patchouli/installation)
  [![Rust](https://img.shields.io/badge/Rust-stable-b55b3d?logo=rust&logoColor=white)](https://memorax-ai.github.io/dsh-patchouli/installation)
</div>

## 概述

Patchouli 在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
内提供统一的 `update`、`retrieve`、`subscribe` 服务。连接器负责提供可信的运行时数据，
记忆和知识插件负责各自的算法，独立的 Rust 后端负责持久化事务存储。

DeepSeek Harness 是目前首个受支持的集成，数据库后端本身不依赖任何 Harness。

## 核心能力

- 提供插件过滤器、用户路由策略和来源标记统一的 Memory Service。
- 在消费端完成聚合，保留各知识插件的原生结果。
- 支持带背压的增量检索流，并以最终 `complete` 汇总结束。
- 通过可配置 Hook 和模型 Tool 接入 Agent Loop。
- 支持本地或远程记忆与知识实现。
- 将图片和工作区文件摄取为类型化 Artifact。
- 提供持久化订阅，以及支持 SQLite 和远程 Provider 的事务化 Rust 后端。

## 插件兼容情况

`Official`（官方兼容）表示上游插件直接注册 `patchouli` service；`Patch`
（补丁兼容）表示 GOOJFC 通过
[dsh-harmony](https://github.com/memorax-ai/dsh-harmony) 适配一个精确版本。
下表区分上游直接集成与绑定特定版本的补丁兼容。

| 插件 | 已验证包 | 兼容方式 | Patchouli DB |
| --- | --- | --- | --- |
| [MemoraX Code](https://github.com/memorax-ai/memorax-code) | `@memorax-code/dsh-adapter@0.1.2`（源码） | Official | 否（插件自管） |
| [OpenViking](https://github.com/volcengine/OpenViking/tree/main/examples/dsh-memory-plugin) | `@openviking/dsh-memory-plugin@0.1.0` | Patch | 否（插件自管） |
| [Hindsight](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents) | `@vectorize-io/hindsight-coding-agents@0.3.4` | Patch | 否（插件自管） |
| [MemOS](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin) | `@memtensor/memos-local-plugin@2.0.16-beta.1` | Patch | 否（插件自管） |
| [Mneme](https://github.com/modusensus/dsh-mneme) | `@modusensus/dsh-mneme@0.3.7` | Patch | 否（插件自管） |
| [Mnemon](https://github.com/omdsh-dev/dsh-mnemon) | `dsh-mnemon@0.1.6` | Patch | 否（插件自管） |
| [Memory Gate](https://github.com/GIT121995/dsh-memory-gate) | `dsh-memory-gate@0.9.0` | Patch | 否（插件自管） |
| [灵枢记忆](https://github.com/FuRongJun-1999/dsh-memory) | `@furongjun1999/dsh-memory@0.2.8` | Patch | 否（插件自管） |
| [Graph Memory](https://github.com/adoresever/graph-memory) | `graph-memory@1.5.8` | Patch | 否（插件自管） |
| [Engramory](https://github.com/tinqiao-oss/engramory/tree/master/adapters/dsh/plugin) | `dsh-engramory@0.2.1` | Patch | 否（插件自管） |
| [Memory Evolve](https://github.com/csyangwen/dsh-memory-evolve) | `dsh-memory-evolve@0.1.0` | Patch | 否（插件自管） |

> 正在开发 DSH 插件，或想探索现有插件的兼容方式？欢迎尝试
> [dsh-harmony](https://github.com/memorax-ai/dsh-harmony)，无需长期维护上游
> fork，也能检查并适配插件行为。

Engramory 兼容补丁会保留其索引保护，同时设置上游公开的
`registerSkill: false` 选项。适配器启用时，Patchouli 是唯一的自动召回路径。

## 安装与使用

需要 Node.js `^22.19.0 || >=24`、pnpm 11，以及兼容 `0.1.0-rc.6` 的
DeepSeek Harness：

```bash
dsh plugin --profile web add dsh-patchouli
dsh --profile web --dump-config
```

插件依赖独立的 `patchouli-db` npm 包。首次使用时，它会从同版本的 GitHub
Release 下载并校验当前平台的守护进程二进制，同时初始化默认的本地数据库目录。
随附的 DSH Profile 默认启用存储客户端，它会连接本地守护进程，并在需要时自动启动。
最后一个命令应列出 `patchouli`、`patchouli-storage` 及各连接器插件。
Patchouli 需要至少注册一个兼容的记忆或知识插件，才能实际处理路由后的
`update`、`retrieve` 和 `subscribe` 调用。

配置和各平台的详细说明参见
[快速开始](https://memorax-ai.github.io/dsh-patchouli/getting-started)。

## 这个插件的名字是什么意思？？？

名称直接来自 [Patchouli Knowledge](https://en.touhouwiki.net/wiki/Patchouli_Knowledge)，同时致敬广为人知的 Minecraft 模组 [Patchouli](https://github.com/VazkiiMods/Patchouli)。
