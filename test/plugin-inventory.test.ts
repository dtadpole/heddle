import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { boot } from '../src/boot.ts'
import { declaredModuleNames, readPluginInventory } from '../src/config/plugin-inventory.ts'

/**
 * The plugin inventory (DSH's `pluginInventory/list`) over a real boot: one entry per non-group loader entry in
 * loader order, the module name the layer wrote, effective enablement, and the fiber's phase, `null` where there
 * is no live fiber.
 */

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-plugin-inventory-'))
  writeFileSync(join(dir, 'alpha.mjs'), "export const name = 'alpha'\nexport function apply() {}\n")
  writeFileSync(join(dir, 'beta.mjs'), "export const name = 'beta'\nexport function apply() {}\n")
  writeFileSync(join(dir, 'broken.mjs'), "export const name = 'broken'\nexport function apply() { throw new Error('this row refuses to start') }\n")
  writeFileSync(
    join(dir, 'cordis.yml'),
    [
      '- insert:',
      '    - id: alpha',
      '      name: ./alpha.mjs',
      '    - id: beta',
      '      name: ./beta.mjs',
      '      disabled: true',
      '    - id: broken',
      '      name: ./broken.mjs',
      '',
    ].join('\n'),
  )
  return dir
}

test('the inventory lists each row as declared, with its enablement and the phase the loader holds now', async () => {
  const dir = fixture()
  const app = await boot({ base: join(dir, 'cordis.yml'), includeProjectPatch: false, configDir: dir, logLevel: 0 })
  try {
    const snapshot = readPluginInventory(app.loader, declaredModuleNames(app))
    assert.deepEqual(snapshot, {
      entries: [
        { entryId: 'alpha', moduleName: './alpha.mjs', enabled: true, fiberPhase: 'active' },
        { entryId: 'beta', moduleName: './beta.mjs', enabled: false, fiberPhase: null },
        { entryId: 'broken', moduleName: './broken.mjs', enabled: true, fiberPhase: 'failed' },
      ],
    })
    assert.equal('managementAvailable' in snapshot, false, 'nothing here can change the profile, so the key is absent')

    const unpaired = readPluginInventory(app.loader)
    assert.ok(
      unpaired.entries.every((entry) => entry.moduleName.startsWith('file://')),
      'the loader itself holds the resolved URL, which is why the declared names are paired back in',
    )
  } finally {
    await app.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a disposed fiber has no phase, a group entry is left out, and no loader is no entries', () => {
  const loader = {
    entries: () => [
      { id: 'kept', options: { name: 'kept' }, disabled: false, fiber: { state: 4 } },
      { id: 'bundle', options: { name: 'bundle', group: true }, disabled: false, fiber: { state: 2 } },
      { id: 'bundle/child', options: { name: './child.mjs' }, disabled: true, fiber: undefined },
      { id: 'stopping', options: { name: 'stopping' }, disabled: false, fiber: { state: 5 } },
    ],
  }
  assert.deepEqual(readPluginInventory(loader).entries, [
    { entryId: 'kept', moduleName: 'kept', enabled: true, fiberPhase: null },
    { entryId: 'bundle/child', moduleName: './child.mjs', enabled: false, fiberPhase: null },
    { entryId: 'stopping', moduleName: 'stopping', enabled: true, fiberPhase: 'unloading' },
  ])
  assert.deepEqual(readPluginInventory(undefined), { entries: [] })
})
