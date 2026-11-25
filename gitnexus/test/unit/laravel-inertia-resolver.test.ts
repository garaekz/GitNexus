import { describe, expect, it } from 'vitest';
import { getJsParser } from '../../src/core/ingestion/languages/javascript/query.js';
import { getTsParser } from '../../src/core/ingestion/languages/typescript/query.js';
import {
  javascriptProvider,
  typescriptProvider,
} from '../../src/core/ingestion/languages/typescript.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { captureInertiaBootstrap } from '../../src/core/ingestion/route-extractors/laravel-inertia-resolver.js';

const imports = `import { createInertiaApp } from '@inertiajs/vue3';
import { resolvePageComponent } from 'laravel-vite-plugin/inertia-helpers';`;
const resolver =
  'name => resolvePageComponent(`./screens/Shop/${name}.vue`, import.meta.glob("./screens/Shop/**/*.vue"))';
const bootstrap = `createInertiaApp({ resolve: ${resolver}, setup({ el }) { mount(el); } });`;
const source = `${imports}\n${bootstrap}`;

function capture(text: string, filePath = 'resources/js/app.js') {
  const ts = filePath.endsWith('.ts');
  const tree = (ts ? getTsParser() : getJsParser()).parse(text);
  const file = extractParsedFile(
    ts ? typescriptProvider : javascriptProvider,
    text,
    filePath,
    undefined,
    tree,
  );
  if (!file) throw new Error(`Missing scope facts for ${filePath}`);
  return captureInertiaBootstrap(file, tree);
}

describe('Laravel Inertia Vue resolver', () => {
  it('distinguishes an unsupported conventional bootstrap from an unrelated file', () => {
    expect(capture(source, 'resources/js/app.js')).toBe('resources/js/screens/Shop');
    expect(capture('startCustomApp();', 'resources/js/app.js')).toBeNull();
    expect(capture('startCustomApp();', 'resources/js/other.js')).toBeUndefined();
  });

  it.each([
    ["import { createInertiaApp } from '@inertiajs/vue3'", null],
    ["import { createInertiaApp as start } from '@inertiajs/vue3'", null],
    ["import * as inertia from '@inertiajs/vue3'", null],
    ["const secondary = await import('@inertiajs/\\x76ue3');", null],
    ['const secondary = await import(`@inertiajs/vue3`);', null],
    ['const secondary = require(`@inertiajs/vue3`);', null],
    ['const helper = require(`./helpers`);', undefined],
    ["import { Head, usePage } from '@inertiajs/vue3'", undefined],
    ["import type { createInertiaApp as Factory } from '@inertiajs/vue3'", undefined],
    ["import { type createInertiaApp, Head } from '@inertiajs/vue3'", undefined],
    ["import type * as inertia from '@inertiajs/vue3'", undefined],
    ["import { createInertiaApp } from './custom'", undefined],
  ] as const)('classifies a possible competing bootstrap from %s', (statement, expected) => {
    expect(capture(statement, 'resources/js/admin.ts')).toBe(expected);
  });

  it('uses the bootstrap-relative directory configured by the matching helper and glob', () => {
    expect(capture(source)).toBe('resources/js/screens/Shop');
    const typed = source
      .replace('name =>', '(name: string) =>')
      .replace('glob(', 'glob<DefineComponent>(');
    expect(capture(typed, 'resources/js/app.ts')).toBe('resources/js/screens/Shop');
    expect(capture(source, 'examples/resources/js/app.js')).toBeNull();
  });

  it.each([
    ['other adapter', source.replace('@inertiajs/vue3', '@inertiajs/react')],
    ['other helper', source.replace('laravel-vite-plugin/inertia-helpers', './helpers')],
    [
      'type-only import',
      source.replace('import { resolvePageComponent', 'import type { resolvePageComponent'),
    ],
    [
      'unproven alias',
      source.replace('import { resolvePageComponent', 'import { other as resolvePageComponent'),
    ],
    ['shadowed bootstrap', `${imports}\nfunction setup(createInertiaApp) { ${bootstrap} }`],
    ['shadowed helper', source.replaceAll('name', 'resolvePageComponent')],
    ['commented invocation', `${imports}\n/* ${bootstrap} */`],
    ['duplicate app', `${source}\ncreateInertiaApp({ resolve: custom });`],
    [
      'literal template require',
      source +
        "\nconst app = require(`@inertiajs/vue3`); app['createInertiaApp']({ resolve: custom });",
    ],
    ['escaped duplicate app', `${source}\ncreateInertia\\u0041pp({ resolve: custom });`],
    [
      'dynamic adapter load',
      `${source}\nconst secondary = await import('@inertiajs/vue3'); secondary['createInertiaApp']({ resolve: custom });`,
    ],
    [
      'CommonJS adapter load',
      `${source}\nrequire('@inertiajs/\\x76ue3')['createInertiaApp']({ resolve: custom });`,
    ],
    [
      'quoted alias of factory',
      source.replace('{ createInertiaApp }', '{ createInertiaApp, "createInertiaApp" as admin }') +
        '\nadmin({ resolve: custom });',
    ],
    [
      'second namespaced app',
      `${source}\nimport * as inertia from '@inertiajs/vue3'; inertia['createInertiaApp']({ resolve: custom });`,
    ],
    ['duplicate resolver', source.replace('setup({', 'resolve: custom, setup({')],
    ['escaped duplicate key', source.replace('setup({', 're\\u0073olve: custom, setup({')],
    ['out-of-scope imports', `declare module 'other' { ${imports} }\n${bootstrap}`],
    ['computed override', source.replace('setup({', '[key]: custom, setup({')],
    ['spread override', source.replace('setup({', '...options, setup({')],
    ['another glob directory', source.replace('Shop/**', 'Admin/**')],
    ['another template parameter', source.replace('${name}', '${other}')],
    ['dynamic path mapping', source.replace('${name}', '${name.toLowerCase()}')],
    ['conditional return', source.replace('name =>', 'name => other ? custom :')],
    ['glob options', source.replace('**/*.vue")', '**/*.vue", { query: "?raw" })')],
    ['optional glob call', source.replace('meta.glob(', 'meta.glob?.(')],
    ['path traversal', source.replaceAll('./screens/', '../screens/')],
  ])('abstains for %s', (_description, text) => {
    expect(capture(text, 'resources/js/app.ts')).toBeNull();
  });
});
