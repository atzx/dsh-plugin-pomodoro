#!/usr/bin/env node
/**
 * Build the browser half of the plugin.
 *
 * DSH client plugins ship as a single pre-built script that registers a factory
 * with `window.__ModuleLoader__.load`. We have no bundler in the install path
 * (the app consumes `lib/client.js` straight from the package), so this script
 * performs the one mechanical transform we actually need: inline the pure ESM
 * source modules into the factory scope inside that registration wrapper.
 *
 * The transform is deliberately tiny and explicit instead of a general bundler:
 *
 *   - local imports (`./timer-core.js`, `./locales.js`) disappear because the
 *     modules are concatenated in dependency order;
 *   - package imports (`react`, `@deepseek-ai/...`) become `require()` calls,
 *     which is the exact contract the client module loader hands to a factory;
 *   - `export` keywords are stripped, and the plugin entry points are attached
 *     to `module.exports` at the end.
 *
 * The generated file is committed, so installing the plugin never runs this.
 *
 * Usage: node scripts/build.mjs [--check]
 *   --check  fail if lib/client.js is not what a fresh build would produce.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCES = [
  'src/timer-core.js',
  'src/locales.js',
  'src/tasks-core.js',
  'src/board-store.js',
  'src/board-styles.js',
  'src/board-ui.js',
  'src/client.js',
]
const OUTPUT = join(ROOT, 'lib/client.js')
const PKG_NAME = 'dsh-plugin-pomodoro'

/**
 * Rewrite one source module into factory-scope statements.
 *
 * Import statements are matched over the whole text (multi-line named imports
 * are legal and used), then local imports are dropped and package imports
 * become `require`. Everything else is copied verbatim except for the
 * `export` keyword on declarations.
 */
function inline(file) {
  const source = readFileSync(join(ROOT, file), 'utf8')

  const withRequires = source.replace(
    /^import\s+(?:\*\s+as\s+(\w+)|(?:\{([\s\S]*?)\})|(\w+))\s+from\s+['"]([^'"]+)['"];?/gm,
    (_match, namespace, named, fallback, specifier) => {
      if (specifier.startsWith('.')) return ''
      const call = `require(${JSON.stringify(specifier)})`
      if (namespace) return `const ${namespace} = ${call}`
      if (named) {
        const specifiers = named.split(',').map(part => part.trim()).filter(Boolean).join(', ')
        return `const { ${specifiers} } = ${call}`
      }
      throw new Error(`${file}: default import of '${specifier}' (${fallback}) is unsupported; use a namespace import`)
    },
  )

  const out = []
  for (const line of withRequires.split('\n')) {
    if (/^\s*import\s/.test(line)) {
      throw new Error(`${file}: unsupported import form: ${line.trim()}`)
    }
    // `export const X` / `export function f` / `export class C` become plain declarations.
    out.push(line.replace(/^(\s*)export\s+(?=(const|let|var|function|class)\b)/, '$1'))
  }
  return `// ─── ${file} ─────────────────────────────────────────────\n${out.join('\n').trim()}\n`
}

function build() {
  const banner = `/**
 * GENERATED FILE — do not edit. Source: src/*.js, build: scripts/build.mjs.
 * DSH browser bundle for ${PKG_NAME}.
 */
`
  const body = SOURCES.map(inline).join('\n')
  const wrapper = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PKG_NAME)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

${body}
    // ─── plugin exports ──────────────────────────────────────────
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
`
  return `${banner}${wrapper}`
}

const expected = build()
const check = process.argv.includes('--check')

if (check) {
  if (!existsSync(OUTPUT)) {
    console.error('lib/client.js is missing; run `node scripts/build.mjs`')
    process.exit(1)
  }
  const actual = readFileSync(OUTPUT, 'utf8')
  if (actual !== expected) {
    console.error('lib/client.js is stale; run `node scripts/build.mjs`')
    process.exit(1)
  }
  console.log('lib/client.js is up to date')
} else {
  writeFileSync(OUTPUT, expected)
  console.log(`wrote ${OUTPUT} (${expected.length} bytes)`)
}
