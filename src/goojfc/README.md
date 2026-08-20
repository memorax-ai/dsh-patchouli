# dsh-patchouli/goojfc

Get out of Jail Free Card is a temporary Cordis plugin for adapting existing
DeepSeek Harness memory and knowledge plugins to Patchouli.

It provides one installation and configuration boundary, while each supported
third-party plugin keeps an isolated, version-locked adapter. The target plugin
keeps its own database, retrieval algorithms, explicit tools, UI, and cleanup.

Automatic data flow has exactly one path:

```text
DSH hook -> Agent Loop connector -> Patchouli Core -> passive GOOJFC adapters
         <- one context message <- successful MemoryPluginOutcome[] <-+
```

The Agent Loop connector is the only owner of DSH Agent and Session memory
hooks. Core concurrently fans a call out to matching adapters, isolates provider
failures, and returns one outcome list without interpreting or ranking it. For a
retrieve hook, Agent Loop drops failures and `null` values, concatenates the
remaining provider values, and performs one context injection.

Compatibility is deliberately fail-closed:

- accept only explicitly tested target package versions;
- route each request to the target plugin's native service exactly once;
- never migrate, replace, or directly access the target plugin's database;
- keep target-specific request and result mapping isolated;
- disable the target's native automatic capture and recall path;
- invoke tested native high-level capabilities only when Core routes a call;
- preserve native databases, explicit tools, authorization, UI, and cleanup;
- accept direct calls and explicit Patchouli memory-tool calls where safe;
- reject unknown payload shapes instead of serializing observations into memory;
- remove an adapter when the target plugin supports Patchouli directly.

The passive automatic-point matrix is:

| Adapter | Store points | Retrieve points |
| --- | --- | --- |
| OpenViking | `agent/created`, `agent/disposed`, `session/turn-end` | `agent/session-start`, `agent/pre-step` |
| Hindsight | `session/turn-end` | `agent/pre-step` |
| MemOS | `agent/disposed`, `session/turn-end` | `agent/pre-step` |
| Mneme | `session/turn-end` | `agent/pre-step` |
| Mnemon | - | `agent/pre-step` |
| Memory Gate | `session/turn-end` | `agent/pre-step` |
| Lingshu | `session/turn-end` | `agent/pre-step` |
| Graph Memory | - | `agent/pre-step` |
| Engramory | - | `agent/pre-step` |
| Memory Evolve | - | `agent/pre-step` |

Unsupported automatic points are filtered before invocation. Memory Evolve also
rejects Patchouli's generic model-tool update because its native write path has
an approval workflow; its native explicit tool remains available.

The compatibility matrix pins these exact targets:

- `@openviking/dsh-memory-plugin@0.1.0`
- `@vectorize-io/hindsight-coding-agents@0.3.4`
- `@memtensor/memos-local-plugin@2.0.16-beta.1`
- `@modusensus/dsh-mneme@0.3.7`
- `dsh-mnemon@0.1.6`
- `dsh-memory-gate@0.9.0`
- `@furongjun1999/dsh-memory@0.2.8`
- `graph-memory@1.5.8`
- `dsh-engramory@0.2.0`
- `dsh-memory-evolve@0.1.0` at source commit
  `ce7f0faa0e0240f117c29795e9224c0d9ed18183`

`graph-memory` is published as an OpenClaw TypeScript plugin rather than a DSH
plugin. Its exact-version patch adds a DSH entry around the package's existing
graph node/edge upsert and recall implementation. It does not emulate the
OpenClaw-only conversation extractor. Engramory is a DSH guard and skill that
explicitly does not create its documented Markdown store; its adapter is only
registered when the user configures an explicit `memoryRoot`, and delegates
index-cap decisions back to the plugin's guard.

Routing remains a Core concern. A provider may declare its own synchronous
`filter`, a registering plugin may add another filter, and users may configure
a per-plugin policy on `dsh-patchouli`. Provider filters and user policy are
combined with AND semantics. User policies can constrain operations, source
types and IDs, scopes, and exact metadata attributes; an unconfigured plugin
receives every call allowed by its provider-owned semantic boundary.

## Verification and recall demo

The adapter tests verify request mapping, routing points, result shapes, and
exact Harmony seams. They do not prove that every third-party database already
contains searchable data. A real retrieval also depends on the native plugin
being configured and having stored or indexed something relevant.

Automatic turn capture can populate OpenViking, Hindsight, MemOS, Mneme,
Memory Gate, and Lingshu. Mnemon, Graph Memory, and Engramory need their native
or explicit update paths before automatic recall has data. Memory Evolve keeps
writes behind its own approval-aware tool. A single explicit record is enough
for some plugins; summarizers and threshold-based extractors may need several
turns before they emit a memory.

Run the deterministic multi-source demo with:

```bash
pnpm demo:recall
```

It downloads the programming-focused LoCoMo `conv-47` sample, feeds 80 turn
records through Patchouli Core and the real Mneme, Memory Gate, and Lingshu
GOOJFC adapters, then triggers the real Agent Loop `agent/pre-step` recall. No
other memory plugin is registered. DeepSeek V4 Flash first produces a dedicated
aggregated memory, then answers the same multi-part question four times in
isolation: once from each native recall and once from the aggregated memory.
The JSON record and two-column browser report are written to
`artifacts/demo/multi-source-recall.json` and
`artifacts/demo/multi-source-recall.html`.

The demo uses in-memory implementations of the three plugins' public native
interfaces so their results are repeatable without third-party database
credentials. The full comparison command requires a configured DeepSeek
provider. It verifies the Patchouli routing and Agent Loop aggregation path;
testing a third-party package's own database, model calls, or cloud service
still requires installing and configuring that package.
