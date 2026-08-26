const target = {
  package: '@deepseek-ai/dsh-client-ui-settings-general',
  version: '>=0.1.1-rc.1 <0.1.2-0',
  file: 'lib/client.js',
}

/** @type {import('dsh-harmony').HarmonyPatch[]} */
module.exports = [{
  id: 'patchouli-settings-nav-icon',
  target,
  select: 'FunctionDeclaration[name.name="navIcon"] Block',
  expect: 1,
  apply({ node, sourceFile, edit }) {
    const source = sourceFile.getFullText()
    const runtime = /let\s+([A-Za-z_$][\w$]*)\s*=\s*require\("react\/jsx-runtime"\)/.exec(source)?.[1]
    if (runtime === undefined) throw new Error('Patchouli could not locate the settings JSX runtime')
    edit.appendLeft(
      node.getStart(sourceFile) + 1,
      `\n\t\t\tif (id === "patchouli") return (0, ${runtime}.jsx)("span", { className: "dsh-patchouli-settings-nav-mark", "aria-hidden": "true" });`,
    )
  },
}]
