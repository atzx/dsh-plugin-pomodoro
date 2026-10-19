/**
 * Source-hygiene guards for the hand-written client bundle.
 *
 * The bundle inlines every `src/` module into one factory scope, so an
 * accidental reference to a namespace that only exists in another module (or a
 * ref that was never declared) fails at render time — after the code shipped.
 * These cheap checks keep that class of mistake out of the build.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { en } from '../src/locales.js'

const boardUi = readFileSync(new URL('../src/board-ui.js', import.meta.url), 'utf8')

test('board-ui only uses the BoardReact namespace (never the foreign React one)', () => {
  const leftovers = [...boardUi.matchAll(/(?<!Board)React\./g)]
  assert.equal(leftovers.length, 0, `unexpected React.* references: ${leftovers.length}`)
})

test('every focus-trap and element ref used by a component is declared', () => {
  const declared = new Set([...boardUi.matchAll(/const\s+(\w+)\s*=\s*BoardReact\.useRef\(/g)].map(match => match[1]))
  const used = new Set()
  // Skip the hook's own definition line (`function useFocusTrap(ref, active)`).
  for (const line of boardUi.split('\n')) {
    if (/^\s*function\s+useFocusTrap\b/.test(line)) continue
    for (const match of line.matchAll(/useFocusTrap\((\w+),/g)) used.add(match[1])
    for (const match of line.matchAll(/\bref:\s*(\w+Ref)\b/g)) used.add(match[1])
    for (const match of line.matchAll(/\bref=\{\s*(\w+Ref)\s*\}/g)) used.add(match[1])
  }
  const missing = [...used].filter(name => !declared.has(name))
  assert.deepEqual(missing, [], `refs used without a declaration: ${missing.join(', ')}`)
})

test('every literal locale key used by the board exists in the English dictionary', () => {
  const missing = new Set()
  for (const match of boardUi.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) {
    if (en[match[1]] === undefined) missing.add(match[1])
  }
  assert.deepEqual([...missing], [], `missing English locale keys: ${[...missing].join(', ')}`)
})
