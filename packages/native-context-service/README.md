# dsh-patchouli-native-context-service

Official Patchouli service for building and retrieving native local context
from DeepSeek Harness sessions, workspaces, and related sources. It is intended
for ordinary Sessions as well as integrations that add richer identity or
visibility semantics, such as Agent Fleet.

The service is organized as an `index -> algo -> retrieve` pipeline. It indexes
bounded Session history, visible Workspace and project files, stored Artifact
metadata/text, and policy-aware Git snapshots when a Git reader is available.
Those records are stored as Patchouli knowledge and exposed through bounded fast
retrieval. Standard retrieval uses the configured DSH model to plan a bounded
set of Fast queries and synthesize cited evidence. Deep retrieval remains an
optional runner and falls back to Standard or Fast when it is unavailable.

`memory_retrieve` receives a common `{ answer, references, truncated }` result at
every effort level. Fast retrieval formats its ranked evidence as numbered
citations and omits internal ranking details by default. Pass
`metadata.includeRawHits: true` when the complete ranked hit records are needed.

Artifact bytes remain in Patchouli's artifact store; native context records keep
only visible text, metadata, and source references. Git indexing is disabled
until the host provides a read-only, policy-aware reader.
