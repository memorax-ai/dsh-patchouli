# dsh-patchouli-agent-loop

Cordis plugin adapting the official DeepSeek Harness Agent Loop to the
in-process `ctx.patchouli` service. It owns the model tools and Agent Loop
hooks; it does not implement memory storage, indexing, extraction, or prompt
generation. Hook payloads are lossless JSON snapshots interpreted by registered
MemoryPlugins.

The default Patchouli DSH bundle loads this package automatically.

```yaml
retrieve:
  sessionStart: false
  preStep: true
  turnStopping: false
  toolPostExecute: false
store:
  agentCreated: false
  agentDisposed: false
  requestError: false
  agentError: false
  turnEnd: true
  toolResult: false
modelTools:
  retrieve: true
  update: true
aggregation:
  enabled: false
  provider: ''
  model: ''
  maxTokens: 800
```

When aggregation is enabled, `provider` and `model` are required. The connector
sends the retrieval context and successful raw plugin results to one independent
LLM call with a dedicated memory-aggregation system prompt. Its compact output,
source IDs, complementarity, and conflicts are injected into the main Agent;
Patchouli Core and the plugin results remain unchanged. The connector accepts
only normally completed JSON whose excerpts occur verbatim in every named
source. If the auxiliary call fails or returns invalid evidence, the connector
logs the failure and injects the original result list.

| Direction | Data point | Delivery |
| --- | --- | --- |
| retrieve | `agent/session-start` | Best-effort `agent.inject()` because the official event is not awaited |
| retrieve | `agent/pre-step` | Awaited; recall JSON is appended to accepted step messages |
| retrieve | `agent/turn-stopping` | Awaited; recall JSON is passed to `agent.inject()` |
| retrieve | `tools/post-execute` | Awaited; recall JSON is appended to `additionalContexts` |
| update | `agent/created` | Per-Session update queue |
| update | `agent/disposed` | Per-Session update queue |
| update | `agent/request-error` | Per-Session update queue, without changing retry policy |
| update | `agent/error` | Per-Session update queue |
| update | `session/turn-end` | Complete durable turn event slice; enabled by default |
| update | `tools/result` | Frozen final Tool execution and result |

All calls use `{ meta, data }`. `meta.attributes.point` identifies the row,
while `data` contains only facts visible at that point. Updates are serialized
per Session, and the adapter extends `session/flush` to wait for admitted update
work.

`session/turn-end` is deferred until `ctx.sessions.flush(session)` completes,
then read back through `ctx.sessionPersistence`. Both `data.session.events` and
`data.events` therefore come from the durable Session Event Log rather than the
live in-memory Session. The connector requires the official
`sessionPersistence` service for this boundary.

The `memory_update` Tool accepts optional `messages` and `resources`; at least
one must be present. A resource is a JSON request for a workspace file, not its
bytes:

```json
{
  "resources": [{
    "kind": "workspace-file",
    "path": "docs/design.pdf",
    "mediaType": "application/pdf",
    "role": "source"
  }]
}
```

The Agent Loop adapter never reads that path. The separate Artifact Ingestor
validates it against the Session workspace through `ctx.fs` and transfers its
bytes through the default Patchouli storage service. Image content blocks
already carry durable DSH attachment references and need no model-supplied
resource.
