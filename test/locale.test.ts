import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { acceptedLanguages, documentLanguage, LOCALE_LABELS, LocaleConfig, negotiateLocale } from '../src/config/locale.ts'
import LocaleService from '../src/plugins/locale.ts'

/** The interface language (issue #80): DSH's dsh-client-locale selection rule, and the `locale` row's setting. */

test('Accept-Language is read most wanted first; q=0 and * name nothing', () => {
  assert.deepEqual(acceptedLanguages('zh-CN,zh;q=0.9,en;q=0.8'), ['zh-CN', 'zh', 'en'])
  assert.deepEqual(acceptedLanguages('en;q=0.5, zh-TW'), ['zh-TW', 'en'])
  assert.deepEqual(acceptedLanguages('fr;q=0, *;q=0.1'), [])
  assert.deepEqual(acceptedLanguages(undefined), [])
})

test('a stored preference wins; otherwise the first supported request by full tag, then primary subtag; else English', () => {
  assert.equal(negotiateLocale('zh', ['en']), 'zh')
  assert.equal(negotiateLocale(undefined, ['zh-CN', 'en']), 'zh', 'zh-CN matches zh by its primary subtag')
  assert.equal(negotiateLocale(undefined, ['fr', 'en-GB', 'zh']), 'en', 'the first supported request wins, not the last')
  assert.equal(negotiateLocale(undefined, ['fr', 'de']), 'en')
  assert.equal(negotiateLocale('xx', ['zh']), 'zh', 'an unknown stored value falls through to the browser')
})

test('the locale row takes en or zh, keeps an absent preference absent, and answers per request', () => {
  assert.deepEqual(LocaleConfig({}), {})
  assert.throws(() => LocaleConfig({ preference: 'fr' } as unknown as Parameters<typeof LocaleConfig>[0]), /expected "en" \| "zh"/)
  const ctx = new Context()
  const following = new LocaleService(ctx, LocaleConfig({}))
  assert.equal(following.preference, undefined)
  assert.equal(following.forRequest('zh-CN,zh;q=0.9'), 'zh')
  assert.equal(following.forRequest(undefined), 'en')
  const chosen = new LocaleService(new Context(), LocaleConfig({ preference: 'en' }))
  assert.equal(chosen.forRequest('zh-CN'), 'en', 'the stored choice beats the browser')
})

test('the document tag and labels are DSH\'s: zh is zh-CN, labelled 中文', () => {
  assert.equal(documentLanguage('zh'), 'zh-CN')
  assert.equal(documentLanguage('en'), 'en')
  assert.deepEqual(LOCALE_LABELS, { en: 'English', zh: '中文' })
})
