# dsh-patchouli-fleet

Optional Fleet adapter for Patchouli. It activates only when both the
`patchouli` and `fleetRuns` Cordis services are present.

The adapter provides the `sessionArchive` capability consumed by Fleet Core.
Fleet members keep one stable logical identity while completed native DSH
Sessions become pageable cold segments. Native Session persistence remains the
source of truth; the adapter stores only the logical segment timeline and its
retention policy.

Rotation is evaluated by Fleet at an idle lifecycle boundary. If Patchouli or
Fleet is absent, this package does not start and Fleet keeps its native Session
behavior.
