---
name: use-dsh-patchouli
description: Install and operate Patchouli for DeepSeek Harness, call its common update/retrieve/subscribe service, build and register memory or knowledge plugins and connectors, use the storage client or JSON-RPC protocol, configure the Rust backend and providers, and troubleshoot profile, daemon, routing, subscription, or consistency failures. Use when an agent is asked to install Patchouli, integrate it with DSH, implement a MemoryPlugin, add a connector or indexer, call storage CRUD, configure scope or consistency, or contribute to dsh-patchouli.
---

# Use Patchouli

Keep the three boundaries separate: DSH callers use the common Memory Service, capability plugins own memory semantics, and the harness-neutral Rust backend owns durable storage policy.

## Choose the boundary

| Need | Use |
| --- | --- |
| Submit or retrieve application data inside DSH | `ctx.patchouliMemory.update/retrieve/subscribe` |
| Implement memory or knowledge behavior | A `MemoryPlugin` registered with `ctx.patchouliMemory.register` |
| Observe Agent Loop, sessions, or workspaces | A connector plugin that calls the common service |
| Perform entity CRUD, artifact transfer, or change-stream work | The optional `ctx.patchouli` storage service |
| Integrate another Harness or process | `@memorax-agent/patchouli-protocol` over the daemon protocol |
| Change physical storage or consistency policy | Provider configuration or the Rust backend, never a DSH plugin |

Do not expose storage CRUD through the common Memory Service and do not make callers select plugin IDs. Registration filters own routing; aggregate outcomes retain plugin provenance and isolate failures.

## Install from source

Read `package.json` first; its engine and peer dependency ranges are authoritative. The current source release requires Node.js, pnpm 11, Rust stable, a C toolchain, and a compatible DSH runtime.

```sh
git clone --branch main --single-branch https://github.com/memorax-agent/dsh-patchouli.git
cd dsh-patchouli
corepack enable
pnpm install
cargo install --locked --path crates/server
patchouli-db init --root ~/.patchouli
dsh plugin --profile web add \
  . \
  ./packages/agent-loop \
  ./packages/artifact-ingestor \
  ./packages/session-indexer \
  ./packages/workspace-indexer
dsh --profile web --dump-config
```

The bundle enables the storage client and auto-starts `patchouli-db` when needed. Verify that the selected profile contains `patchouli`, `patchouli-storage`, and the intended connectors. Register at least one MemoryPlugin; connectors alone do not implement memory semantics.

## Call the common service

Pass trusted caller identity and routing facts in `meta`; pass the source-owned, lossless JSON payload in `data`:

```ts
const outcomes = await ctx.patchouliMemory.retrieve({
  meta: {
    source: { type: 'plugin', id: 'my-connector' },
    scope: workspaceId,
    attributes: { point: 'agent/pre-step' },
  },
  data: { query },
})
```

Treat every result as a per-plugin outcome. Do not assume that one failure cancels other plugins. Use Artifact references for managed binary data; use the Artifact ingestor for DSH images and workspace files.

## Develop a MemoryPlugin

Create an ordinary Cordis plugin and depend on `patchouliMemory`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryPlugin } from 'dsh-patchouli'

export const name = 'my-patchouli-memory'
export const inject = ['patchouliMemory'] as const

export function apply(ctx: Context): () => void {
  const plugin: MemoryPlugin = {
    id: name,
    async update({ data }) {
      return data
    },
    async retrieve({ data }) {
      return data
    },
  }
  return ctx.patchouliMemory.register(plugin, {
    filter: ({ meta }) => meta.source.type === 'agent-loop',
  })
}
```

Keep filters synchronous and side-effect free. Preserve JSON data unless the plugin intentionally defines a transformation. If implementing `subscribe`, keep cursors opaque, deliver changes at least once, and classify retryable or reset-required failures explicitly.

Connectors should capture real source data, not embed retrieval prompts. They call the common service with stable `source`, `scope`, and attributes that capability plugins can filter.

## Develop against storage

Use `dsh-patchouli/storage` and `ctx.patchouli` only when the plugin needs direct durable entities, artifacts, transactions, or change subscriptions. Use `runWorkUnit` for configuration-defined cross-call atomic publication; do not invent a client-side transaction protocol.

For non-DSH clients, treat `packages/protocol/openrpc.json` and `packages/protocol/SPEC.md` as normative. Keep method business fields in `data`; configured identity, scope, causal, idempotency, and conflict fields stay in `meta`. Tokens, versions, and cursors are opaque.

Backend work stays in Rust. Put schema, scope routing, consistency, conflict, and provider selection in configuration rather than hard-coding them into CRUD or plugin APIs.

## Validate changes

```sh
pnpm check
cargo test --workspace
pnpm test:e2e
```

For installation failures, confirm the DSH profile and dumped bundle first, then check the daemon endpoint and `patchouli-db config check`. For routing failures, inspect registration filters and per-plugin outcomes before debugging storage.

Use the current [documentation](https://memorax-agent.github.io/dsh-patchouli/), [protocol](https://github.com/memorax-agent/dsh-patchouli/tree/main/packages/protocol), and repository configuration as the authority for details.
