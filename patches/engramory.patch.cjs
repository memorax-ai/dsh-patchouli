const target = {
  package: 'dsh-engramory',
  version: '0.2.1',
  file: 'index.js',
}

/** @type {import('dsh-harmony').HarmonyPatch[]} */
module.exports = [{
  id: 'goojfc-engramory-order',
  target,
  select: 'VariableDeclaration[name.name="inject"]',
  expect: 1,
  apply({ node, edit, ts }) {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined) {
      throw new Error('Engramory inject declaration no longer has an initializer')
    }
    edit.overwrite(
      node.initializer.getStart(),
      node.initializer.getEnd(),
      '["tools", "patchouliGoojfc"]',
    )
  },
}, {
  id: 'goojfc-engramory-service',
  target,
  select: 'VariableDeclaration[name.name="settings"]',
  expect: 1,
  apply({ node, edit, ts }) {
    const statement = node.parent.parent
    if (!ts.isVariableStatement(statement)) {
      throw new Error('Engramory settings declaration is no longer a variable statement')
    }
    edit.appendRight(statement.getEnd(), String.raw`
  // Patchouli owns automatic recall in GOOJFC; keep Engramory's guard but skip its skill.
  config = { ...config, registerSkill: false };
  if (typeof config.memoryRoot === "string" && config.memoryRoot.trim()) {
    ctx.provide("goojfcEngramory", ctx.patchouliGoojfc.createEngramoryAdapter({
      memoryRoot: config.memoryRoot,
      indexName: settings.indexName,
      validateIndex: (content, path) => refuseOversizedIndex({
        name: "write",
        arguments: { file_path: path, content },
      }, settings),
    }));
  }`)
  },
}]
