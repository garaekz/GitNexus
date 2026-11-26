import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { typescriptProvider } from '../../src/core/ingestion/languages/typescript.js';
import { getTsParser } from '../../src/core/ingestion/languages/typescript/query.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import {
  captureInertiaViteEntry,
  createInertiaVitePageResolver,
  isSoleInertiaViteConfig,
  prepareInertiaVitePageResolver,
} from '../../src/core/ingestion/route-extractors/laravel-inertia-vite.js';

const entry = 'resources/js/app.ts';
function tempRepo() {
  const scratch = fileURLToPath(new URL('../../.tmp-test/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(path.join(scratch, 'inertia-vite-'));
}
const imports = `import inertia from '@inertiajs/vite';
import laravel from 'laravel-vite-plugin';
import vue from '@vitejs/plugin-vue';
import { defineConfig, lazyPlugins } from 'vite-plus';`;
const plugins = `[laravel({input: ['resources/css/app.css', '${entry}'], refresh: true}), inertia(), vue()]`;
const config = `${imports}\nexport default defineConfig({ plugins: lazyPlugins(() => ${plugins}) });`;
function capture(source: string, filePath = 'vite.config.ts') {
  const tree = getTsParser().parse(source);
  const file = extractParsedFile(typescriptProvider, source, filePath, undefined, tree);
  if (!file) throw new Error('Missing ParsedFile');
  return captureInertiaViteEntry(file, tree)?.entry;
}

describe('Inertia v3 Vite plugin and browser input', () => {
  it('rejects a physically present competing Vite config excluded from the graph', () => {
    const root = tempRepo();
    try {
      writeFileSync(path.join(root, 'vite.config.ts'), '');
      expect(isSoleInertiaViteConfig(root, 'vite.config.ts')).toBe(true);
      writeFileSync(path.join(root, 'vite.config.js'), '');
      expect(isSoleInertiaViteConfig(root, 'vite.config.ts')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('accepts lazyPlugins from vite-plus and a direct Vite plugin array', () => {
    expect(capture(config)).toBe(entry);
    const direct = config
      .replace('defineConfig, lazyPlugins', 'defineConfig')
      .replace("'vite-plus'", "'vite'")
      .replace(`lazyPlugins(() => ${plugins})`, plugins);
    expect(capture(direct)).toBe(entry);
  });

  it('preserves the official starter template, fonts and companion plugins', () => {
    const helpers = `import { bunny } from 'laravel-vite-plugin/fonts';
import tailwindcss from '@tailwindcss/vite';
import { wayfinder } from '@laravel/vite-plugin-wayfinder';`;
    const source = config
      .replace(
        'refresh: true',
        "fonts: [bunny('Instrument Sans', { weights: [400] })], refresh: true",
      )
      .replace(
        'vue()',
        'vue({template: {transformAssetUrls: {base: null, includeAbsolute: false}}}), tailwindcss(), wayfinder({formVariants: true})',
      );
    expect(capture(helpers + '\n' + source)).toBe(entry);
  });

  it.each([
    ['non-root config', config, 'demo/vite.config.ts'],
    ['different plugin', config.replace('@inertiajs/vite', './inertia')],
    ['type-only plugin', config.replace('import inertia', 'import type inertia')],
    ['wrong configuration factory', config.replace('vite-plus', './local')],
    ['missing plugin', config.replace(' inertia(),', '')],
    ['missing Vue transform', config.replace(', vue()', '')],
    ['two Vue transforms', config.replace('vue()', 'vue(), vue()')],
    ['duplicated plugin', config.replace('inertia(),', 'inertia(), inertia(),')],
    ['plugin options override', config.replace('inertia()', 'inertia({frameworks: adapters})')],
    ['another browser input', config.replace(entry, 'resources/js/admin.ts')],
    ['two browser inputs', config.replace(entry, "resources/js/app.js', 'resources/js/app.ts")],
    ['spread input', config.replace('refresh: true', '...overrides')],
    ['duplicate input', config.replace('refresh: true', 'input: other')],
    [
      'custom build input',
      config.replace(
        'plugins: lazyPlugins',
        'build: {rollupOptions: {input: other}}, plugins: lazyPlugins',
      ),
    ],
    [
      'root override',
      config.replace('plugins: lazyPlugins', "root: 'other', plugins: lazyPlugins"),
    ],
    ['unproven plugin', config.replace('vue()', 'myPlugin()')],
    ['filtered Vue transforms', config.replace('vue()', "vue({exclude: ['**/*.vue']})")],
    ['unproven Vue template override', config.replace('vue()', 'vue({template: {compiler: {}}})')],
    ['computed key', config.replace('plugins: lazyPlugins', '[key]: x, plugins: lazyPlugins')],
    ['shadowed import', config.replace('() => [laravel', '(inertia) => [laravel')],
    ['non-default export', config.replace('export default', 'export const test =')],
  ])('abstains for %s', (_description, source, filePath) => {
    expect(capture(source, filePath)).toBeUndefined();
  });
});

describe('Vue default lookup in @inertiajs/vite v3', () => {
  const preferred = 'resources/js/pages/Orders/Show.vue';
  const fallback = 'resources/js/Pages/Orders/Show.vue';

  it('checks only exact .vue keys in upstream order, even when both are indexed', () => {
    const resolve = createInertiaVitePageResolver('.', new Set([fallback, preferred]));
    expect(resolve(entry, 'Orders/Show')).toBe(preferred);
    expect(resolve(entry, 'Show')).toBeUndefined();
    expect(resolve(entry, 'Orders/show')).toBeUndefined();
  });

  it('falls back only when the preferred case-sensitive path is absent on disk', () => {
    const root = tempRepo();
    try {
      mkdirSync(path.join(root, 'resources/js/Pages/Orders'), { recursive: true });
      writeFileSync(path.join(root, fallback), '');
      const indexed = new Set([fallback]);
      expect(createInertiaVitePageResolver(root, indexed)(entry, 'Orders/Show')).toBe(fallback);
      // Simulate an excluded preferred file. No uppercase directory is needed
      // physically to test whether an already indexed fallback may be emitted.
      rmSync(path.join(root, 'resources/js/Pages'), { recursive: true });
      mkdirSync(path.join(root, 'resources/js/pages/Orders'), { recursive: true });
      writeFileSync(path.join(root, preferred), '');
      expect(createInertiaVitePageResolver(root, indexed)(entry, 'Orders/Show')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps symlinked preferred directories unresolved', () => {
    const root = tempRepo();
    try {
      mkdirSync(path.join(root, 'resources/js'), { recursive: true });
      mkdirSync(path.join(root, 'external'));
      symlinkSync(path.join(root, 'external'), path.join(root, 'resources/js/pages'), 'junction');
      expect(
        createInertiaVitePageResolver(root, new Set([fallback]))(entry, 'Orders/Show'),
      ).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['.gitignore', '.gitnexusignore'])(
    'keeps an absent preferred file ignored by %s unresolved',
    async (rules) => {
      const root = tempRepo();
      try {
        execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
        writeFileSync(path.join(root, 'vite.config.ts'), '');
        writeFileSync(path.join(root, rules), preferred + '\n');
        const lookup = await prepareInertiaVitePageResolver(
          root,
          new Set([fallback]),
          'vite.config.ts',
          ['Orders/Show'],
        );
        expect(lookup).toBeTypeOf('function');
        expect(lookup?.(entry, 'Orders/Show')).toBeUndefined();
        writeFileSync(path.join(root, rules), 'vite.config.js\n');
        expect(
          await prepareInertiaVitePageResolver(root, new Set([fallback]), 'vite.config.ts', [
            'Orders/Show',
          ]),
        ).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('supports a plain directory and abstains in a Git repository that hides untracked files', async () => {
    const root = tempRepo();
    try {
      writeFileSync(path.join(root, 'vite.config.ts'), '');
      const lookup = () =>
        prepareInertiaVitePageResolver(root, new Set([preferred]), 'vite.config.ts', [
          'Orders/Show',
        ]);
      expect((await lookup())?.(entry, 'Orders/Show')).toBe(preferred);
      execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
      execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], {
        cwd: root,
        windowsHide: true,
      });
      expect(await lookup()).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
