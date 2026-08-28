# Packages and DSH plugins

Patchouli is a multi-package repository. A package is independently versioned and publishable; only packages that declare both `dsh.plugin` and `dsh.bundle` are DeepSeek Harness plugins.

## Current packages

| Package | Kind | DSH bundle | Release tag |
| --- | --- | --- | --- |
| `dsh-patchouli` | host knowledge-service plugin | `patchouli` | `dsh-patchouli@<version>` |
| `dsh-patchouli-memory-ui` | web UI plugin | `patchouli-memory-ui` | `memory-ui/v<version>` |
| `dsh-patchouli-protocol` | harness-neutral library | none | `v<version>` |

Versions are independent. Repository-wide tags such as `v0.1.0` are not used because they become ambiguous as more plugins are added.

## Plugin package contract

Each DSH plugin package owns all of the following:

- a publishable `package.json` with localized `dsh.plugin` discovery metadata;
- a `dsh.bundle.patch` pointing to its own `cordis.patch.yml`;
- a unique Cordis row id prefixed with `patchouli-`, except the original root row `patchouli`;
- a host entry exported from `.`;
- when it has a Web client, its own `./client` export, module-loader bundle, and `dsh.client` dependencies;
- independent `build`, `typecheck`, `test`, `check`, and `prepare` scripts;
- package-local README and license files;
- repository metadata whose `directory` identifies the workspace package.

Shared code packages do not declare `dsh` metadata and are not inserted into a Harness profile.

## Installation model

Every plugin is a direct dependency of the target DSH profile. The root plugin does not act as a meta-package and does not insert sibling plugins.

Published packages:

```bash
dsh plugin --profile web add @ch4acko3/dsh-ui-container
dsh plugin --profile web add @ch4acko3/dsh-ui-workspace
dsh plugin --profile web add dsh-patchouli-memory-ui
dsh plugin --profile web add dsh-patchouli
```

Local checkout:

```bash
dsh plugin --profile web add github:CH4ACKO3/dsh-ui-container
dsh plugin --profile web add github:CH4ACKO3/dsh-ui-workspace
dsh plugin --profile web add ./packages/memory-ui
dsh plugin --profile web add .
```

A GitHub dependency resolves the repository root package only. It cannot select `packages/memory-ui`, so workspace plugins must be published, installed from a local directory or tarball, or moved to their own repository.

## Adding a plugin

1. Add a workspace package under `packages/<name>` that satisfies the plugin package contract.
2. Give its Cordis row and browser module-loader factory globally unique ids.
3. Add package-level contract and bundle boot tests.
4. Add the package to the delivery job so CI uploads its tarball.
5. Document its direct profile dependencies and add it to the table above.
6. Release only that package and create the package-qualified Git tag.
