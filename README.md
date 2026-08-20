<div align="center">
  <img width="100%" alt="Patchouli" src="assets/patchouli-banner-en.png">

  <h1>Patchouli</h1>
  <p>
    <strong>A local memory and knowledge hub for DeepSeek Harness.</strong>
    <br />
    Integrates heterogeneous Agent data augmentation while keeping data and algorithms decoupled.
  </p>

  **English** · [简体中文](README.zh-CN.md)

  [![Documentation](https://img.shields.io/badge/docs-read-75439a?logo=readthedocs&logoColor=white)](https://memorax-ai.github.io/dsh-patchouli/)
  [![CI](https://github.com/memorax-ai/dsh-patchouli/actions/workflows/ci.yml/badge.svg)](https://github.com/memorax-ai/dsh-patchouli/actions/workflows/ci.yml)
  [![License: MIT](https://img.shields.io/badge/license-MIT-2f6f4e.svg)](LICENSE)
  [![Node.js](https://img.shields.io/badge/Node.js-%5E22.19.0%20%7C%7C%20%3E%3D24-2f6f4e?logo=nodedotjs&logoColor=white)](https://memorax-ai.github.io/dsh-patchouli/installation)
  [![Rust](https://img.shields.io/badge/Rust-stable-b55b3d?logo=rust&logoColor=white)](https://memorax-ai.github.io/dsh-patchouli/installation)
</div>

## Overview

Patchouli exposes one `update` / `retrieve` / `subscribe` service inside
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Connectors
provide trusted runtime data, memory and knowledge plugins own their algorithms,
and an independent Rust backend provides durable transactional storage.

DeepSeek Harness is the first supported integration. The database backend
remains harness-neutral.

## Features

- Common Memory Service with provider filters, user routing policies, and provenance.
- Optional dedicated-model aggregation that keeps native plugin results intact.
- Agent Loop connector with configurable hooks and model tools.
- Pluggable local or remote memory and knowledge implementations.
- Managed image and workspace-file ingestion as typed Artifacts.
- Durable subscriptions and a transactional Rust backend with SQLite and remote providers.

## Plugin compatibility

`Official` means the upstream plugin registers the `patchouli` service directly.
`Patch` means GOOJFC adapts one exact plugin version through
[dsh-harmony](https://github.com/memorax-ai/dsh-harmony). The table distinguishes
upstream integrations from version-pinned patches.

| Plugin | Tested package | Compatibility | Patchouli DB |
| --- | --- | --- | --- |
| [MemoraX Code](https://github.com/memorax-ai/memorax-code) | `@memorax-code/dsh-adapter@0.1.2` (source) | Official | No — plugin-managed |
| [OpenViking](https://github.com/volcengine/OpenViking/tree/main/examples/dsh-memory-plugin) | `@openviking/dsh-memory-plugin@0.1.0` | Patch | No — plugin-managed |
| [Hindsight](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents) | `@vectorize-io/hindsight-coding-agents@0.3.4` | Patch | No — plugin-managed |
| [MemOS](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin) | `@memtensor/memos-local-plugin@2.0.16-beta.1` | Patch | No — plugin-managed |
| [Mneme](https://github.com/modusensus/dsh-mneme) | `@modusensus/dsh-mneme@0.3.7` | Patch | No — plugin-managed |
| [Mnemon](https://github.com/omdsh-dev/dsh-mnemon) | `dsh-mnemon@0.1.6` | Patch | No — plugin-managed |
| [Memory Gate](https://github.com/GIT121995/dsh-memory-gate) | `dsh-memory-gate@0.9.0` | Patch | No — plugin-managed |
| [Lingshu Memory](https://github.com/FuRongJun-1999/dsh-memory) | `@furongjun1999/dsh-memory@0.2.8` | Patch | No — plugin-managed |
| [Graph Memory](https://github.com/adoresever/graph-memory) | `graph-memory@1.5.8` | Patch | No — plugin-managed |
| [Engramory](https://github.com/tinqiao-oss/engramory/tree/master/adapters/dsh/plugin) | `dsh-engramory@0.2.0` | Patch | No — plugin-managed |
| [Memory Evolve](https://github.com/csyangwen/dsh-memory-evolve) | `dsh-memory-evolve@0.1.0` | Patch | No — plugin-managed |

> Building a DSH plugin or exploring compatibility with an existing one? Try
> [dsh-harmony](https://github.com/memorax-ai/dsh-harmony) to inspect and adapt
> plugin behavior without maintaining an upstream fork.

## Install and use

Requires Node.js `^22.19.0 || >=24`, pnpm 11, and a DeepSeek Harness runtime
compatible with `0.1.0-rc.6`. Install the database daemon first:

```bash
curl -fsSL https://raw.githubusercontent.com/memorax-ai/dsh-patchouli/main/scripts/install.sh | sh
dsh plugin --profile web add dsh-patchouli
dsh --profile web --dump-config
```

The installer downloads a checksum-verified daemon binary from the latest
GitHub release. The bundled DSH profile enables its storage client by default;
it connects to the local daemon and starts it when needed. The last command
should list `patchouli`, `patchouli-storage`, and the connector plugins.
Register at least one compatible memory or knowledge plugin to handle routed
`update`, `retrieve`, and `subscribe` calls.

See the [Getting started guide](https://memorax-ai.github.io/dsh-patchouli/getting-started)
for configuration and platform-specific details.

## What does the plugin's name mean???

The name refers directly to
[Patchouli Knowledge](https://en.touhouwiki.net/wiki/Patchouli_Knowledge), and
also pays tribute to the widely known Minecraft mod
[Patchouli](https://github.com/VazkiiMods/Patchouli).
