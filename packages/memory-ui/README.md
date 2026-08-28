# dsh-patchouli-memory-ui

Patchouli Memory UI 是独立的 DeepSeek Harness Web 插件。它把知识浏览、检索、变更记录和记忆库 Agent 工作区挂载为 Harness 的“知识”会话视图。

该包只负责浏览器界面，不内嵌 Patchouli 数据库或知识服务。文档容器与工作区组件已经内置，不依赖额外 UI 基础包。

## 安装

发布到 npm 后，在同一个 profile 中安装：

```bash
dsh plugin --profile web add dsh-patchouli-memory-ui
```

从 monorepo checkout 本地开发时：

```bash
dsh plugin --profile web add ./packages/memory-ui
```

GitHub 仓库 URL 只能安装仓库根 package，不能定位 workspace 子包；因此不能用 `github:memorax-ai/dsh-patchouli` 安装本插件。

## 开发

```bash
pnpm --filter dsh-patchouli-memory-ui check
pnpm --dir packages/memory-ui pack
```

插件的 host entry、client bundle、Cordis patch 和 DSH discovery metadata 都由本 package 自己维护。版本与根插件独立，发布标签格式为 `memory-ui/v<version>`。

## License

[MIT](LICENSE)
