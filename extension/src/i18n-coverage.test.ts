import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ensureEnglishTranslations, hasEnglishTranslation } from '../../src/shared/i18n'

beforeAll(() => ensureEnglishTranslations())

// src/shared/i18n/index.test.ts only walks src/, so Float's own literals need
// the same check here or a new panel string silently stays Chinese in English.
function panelSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return panelSources(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

function staticTranslationKeys(source: string): string[] {
  return [
    ...source.matchAll(/\bt\(\s*'((?:\\.|[^'\\])*)'/g),
    ...source.matchAll(/\bt\(\s*"((?:\\.|[^"\\])*)"/g),
  ].map((match) => match[1].replace(/\\(['"\\])/g, '$1'))
}

describe('Float translations', () => {
  it('has an English translation for every direct Chinese panel string', () => {
    const missing = [...new Set(panelSources(join('extension', 'src'))
      .flatMap((filename) => staticTranslationKeys(readFileSync(filename, 'utf8'))
        .filter((key) => !hasEnglishTranslation(key))
        .map((key) => `${filename}: ${key}`)))]
      .sort()

    expect(missing).toEqual([])
  })
})
