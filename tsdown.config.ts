/**
 * tsdown preset — two bundles:
 *  - lib/index.js  (node half, imported by the host Loader)
 *  - lib/client.js (browser half, handed to window.__ModuleLoader__)
 *
 * The browser bundle must not carry cross-plugin *value* imports: collaboration happens
 * through cordis services, so every platform module stays external and anything else is
 * inlined. The purity plugin below turns a violation into a build error instead of a
 * runtime surprise.
 */
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-any-deepseek'

/** Package root, used to keep CSS virtual ids relative (no build-machine paths in output). */
const PKG_ROOT = dirname(fileURLToPath(import.meta.url))

/** Modules the web shell already provides; never bundled. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-locale',
] as const

const isExternal = (source: string): boolean => PLATFORM_MODULES.includes(source as never)

const CSS_VIRTUAL_PREFIX = '\0ad-css:'

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    external: [...PLATFORM_MODULES],
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    noExternal: (id: string) => (isExternal(id) ? undefined : true),
    plugins: [
      {
        name: 'ad-client-bundle-purity',
        resolveId(source: string) {
          if (!source.startsWith('@deepseek-ai/')) return null
          if (isExternal(source)) return null
          throw new Error(
            `client bundle purity: "${source}" is not a platform module — `
            + 'cross-plugin value imports are forbidden; collaborate through cordis services',
          )
        },
      },
      {
        name: 'ad-css-inline',
        resolveId(source: string, importer: string | undefined) {
          if (!source.endsWith('.css')) return null
          if (!importer) throw new Error(`css-inline: cannot resolve "${source}" without an importer`)
          const abs = resolvePath(dirname(importer), source)
          // Relative virtual id: an absolute one leaks the build machine's directory layout
          // into the `//#region` comments of the published bundle.
          return CSS_VIRTUAL_PREFIX + relative(PKG_ROOT, abs).replace(/\.css$/, '')
        },
        load(virtualId: string) {
          if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
          const rel = virtualId.slice(CSS_VIRTUAL_PREFIX.length)
          const file = resolvePath(PKG_ROOT, rel + '.css')
          this.addWatchFile(file)
          const css = readFileSync(file, 'utf-8')
          const id = rel.split(/[\\/]/).pop()?.replace(/\.css$/, '') ?? 'ad'
          const marker = `style[data-ad-css="${id}"]`
          return [
            `const css = ${JSON.stringify(css)};`,
            `if (typeof document !== 'undefined' && document.querySelector(${JSON.stringify(marker)}) === null) {`,
            `  const tag = document.createElement('style');`,
            `  tag.setAttribute('data-ad-css', ${JSON.stringify(id)});`,
            `  tag.textContent = css;`,
            `  document.head.appendChild(tag);`,
            `}`,
            `export default css;`,
          ].join('\n')
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
