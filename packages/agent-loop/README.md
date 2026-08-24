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
```

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
then the completed turn is read back through `ctx.sessionPersistence` starting
at its `turn/start` sequence. `data.events` therefore contains the exact durable
turn slice without replaying cumulative Session history. Other observations
include the Session header but omit `session.events` unless a hook explicitly
supplies a bounded event slice. The connector requires the official
`sessionPersistence` service for this boundary.

The `memory_retrieve` Tool accepts an optional open JSON `metadata` object and
forwards it unchanged as `data.metadata` for plugin-defined filtering.

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
