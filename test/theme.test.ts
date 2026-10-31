import assert from 'node:assert/strict'
import { test } from 'node:test'

import { documentAttributes, normalizeFontFamily, ThemeConfig, themeSettings } from '../src/config/theme.ts'

/** The `ui-theme` row (issue #81): the twin of heddle-config's `theme` tests, so both builds serve the same document. */

test('no configuration is DSH\'s defaults on the document', () => {
  const settings = themeSettings(ThemeConfig({}))
  assert.deepEqual(settings, { preference: 'system', fontSizes: [14, 11, 13], fontFamilies: ['', '', ''] })
  assert.equal(
    documentAttributes(settings),
    ' data-theme="system" style="--heddle-content-font-size:14px;--heddle-code-font-size:11px;--heddle-terminal-font-size:13px;"',
  )
})

test('stored values reach the document with font lists normalized and escaped', () => {
  const settings = themeSettings(ThemeConfig({ preference: 'light', fontSize: 18, codeFontSize: 13, textFontFamily: " 'Inter' ,  system-ui,, <b>Fira\\ Sans " }))
  assert.equal(settings.preference, 'light')
  assert.deepEqual(settings.fontSizes, [18, 13, 13])
  assert.equal(settings.fontFamilies[0], '"Inter", system-ui, "bFira Sans"')
  assert.equal(
    documentAttributes(settings),
    ' data-theme="light" style="--heddle-content-font-size:18px;--heddle-code-font-size:13px;--heddle-terminal-font-size:13px;--heddle-font-family-text:&quot;Inter&quot;, system-ui, &quot;bFira Sans&quot;;"',
  )
  assert.equal(normalizeFontFamily(settings.fontFamilies[0]), settings.fontFamilies[0], 'normalizing a result returns it unchanged')
})

test('a value outside DSH\'s schema is refused', () => {
  assert.throws(() => ThemeConfig({ fontSize: 30 }))
  assert.throws(() => ThemeConfig({ fontSize: 14.5 }))
  assert.throws(() => ThemeConfig({ preference: 'sepia' as never }))
})
