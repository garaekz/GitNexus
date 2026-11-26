import { describe, expect, it } from 'vitest';
import { getJsParser } from '../../src/core/ingestion/languages/javascript/query.js';
import { getTsParser } from '../../src/core/ingestion/languages/typescript/query.js';
import {
  javascriptProvider,
  typescriptProvider,
} from '../../src/core/ingestion/languages/typescript.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { captureInertiaBootstrap } from '../../src/core/ingestion/route-extractors/laravel-inertia-resolver.js';
import { createLexicalBindings } from '../../src/core/ingestion/route-extractors/lexical-bindings.js';

const imports = `import { createInertiaApp } from '@inertiajs/vue3';
import { resolvePageComponent } from 'laravel-vite-plugin/inertia-helpers';`;
const resolver =
  'name => resolvePageComponent(`./screens/Shop/${name}.vue`, import.meta.glob("./screens/Shop/**/*.vue"))';
const bootstrap = `createInertiaApp({ resolve: ${resolver}, setup({ el }) { mount(el); } });`;
const source = `${imports}\n${bootstrap}`;
const client = { kind: 'client', directory: 'resources/js/screens/Shop' };
const serverSource = `${imports}
import createServer from '@inertiajs/vue3/server';
import { renderToString } from '@vue/server-renderer';
createServer((page) => createInertiaApp({ page, render: renderToString, resolve: ${resolver} }));`;

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
  return captureInertiaBootstrap(file, tree, createLexicalBindings(file, 0, tree.rootNode));
}

describe('Laravel Inertia Vue resolver', () => {
  it('distinguishes an unsupported conventional bootstrap from an unrelated file', () => {
    expect(capture(source, 'resources/js/app.js')).toEqual(client);
    expect(capture('startCustomApp();', 'resources/js/app.js')).toBeNull();
    expect(capture('startCustomApp();', 'resources/js/other.js')).toBeUndefined();
  });

  it.each([
    ["import { createInertiaApp } from '@inertiajs/vue3'", undefined],
    ["import { createInertiaApp as start } from '@inertiajs/vue3'", undefined],
    ["import * as inertia from '@inertiajs/vue3'", undefined],
    ["const secondary = await import('@inertiajs/\\x76ue3');", null],
    ['const secondary = await import(`@inertiajs/vue3`);', null],
    ['const secondary = require(`@inertiajs/vue3`);', null],
    ['const helper = require(`./helpers`);', undefined],
    ['function local(require) { return require(`@inertiajs/vue3`); }', undefined],
    ["import { Head, usePage } from '@inertiajs/vue3'", undefined],
    ["import type { createInertiaApp as Factory } from '@inertiajs/vue3'", undefined],
    ["import { type createInertiaApp, Head } from '@inertiajs/vue3'", undefined],
    ["import type * as inertia from '@inertiajs/vue3'", undefined],
    ["import { createInertiaApp } from './custom'", undefined],
  ] as const)('classifies a possible competing bootstrap from %s', (statement, expected) => {
    expect(capture(statement, 'resources/js/admin.ts')).toBe(expected);
  });

  it('uses the bootstrap-relative directory configured by the matching helper and glob', () => {
    expect(capture(source)).toEqual(client);
    const typed = source
      .replace('name =>', '(name: string) =>')
      .replace('glob(', 'glob<DefineComponent>(');
    expect(capture(typed, 'resources/js/app.ts')).toEqual(client);
    // Other modules' static calls are checked by project-wide factory resolution.
    expect(capture(source, 'examples/resources/js/app.js')).toBeUndefined();
  });

  it('uses the helper binding even when unrelated scopes and properties use the same name', () => {
    expect(
      capture(
        source +
          '\nconst unrelated = { resolvePageComponent: true }; function other(resolvePageComponent) { return resolvePageComponent(); }',
      ),
    ).toEqual(client);
    expect(
      capture(
        source + '\nconst unrelated = { createInertiaApp: true }; unrelated.createInertiaApp;',
      ),
    ).toEqual(client);
  });

  it('recognizes the Laravel Breeze SSR adapter callback and its own page directory', () => {
    expect(capture(serverSource, 'resources/js/ssr.js')).toEqual({ ...client, kind: 'server' });
    expect(
      capture(serverSource.replace('@inertiajs/vue3/server', './server'), 'resources/js/ssr.js'),
    ).toBeNull();
    expect(
      capture(serverSource.replace('(page) =>', '(createInertiaApp) =>'), 'resources/js/ssr.js'),
    ).toBeNull();
    expect(capture(source, 'resources/js/ssr.ts')).toBeNull();
    expect(capture(serverSource, 'resources/js/app.js')).toBeNull();
  });

  it('admits the v3 starter for Vite resolution only when its plain options omit resolver overrides', () => {
    const starter = `import { createInertiaApp } from '@inertiajs/vue3'; void createInertiaApp({ layout: name => name, progress: { color: '#123456' } });`;
    expect(capture(starter, 'resources/js/app.ts')).toEqual({ kind: 'vite-client' });
    const homonym =
      'function other(createInertiaApp) { return (createInertia\\u0041pp)({ pages: "./Other" }); }';
    expect(capture(`${homonym}\n${starter}`, 'resources/js/app.ts')).toBeNull();
    expect(capture(`${homonym}\n${source}`, 'resources/js/app.ts')).toEqual(client);
    for (const override of [
      'resolve: custom',
      'pages: "./elsewhere"',
      '[key]: custom',
      '...custom',
      'get resolve() { return custom; }',
      '__proto__: custom',
    ]) {
      expect(
        capture(starter.replace('layout: name => name', override), 'resources/js/app.ts'),
      ).toBeNull();
    }
    expect(capture(starter.replace('void createInertiaApp', 'createInertiaApp'))).toBeNull();
    expect(capture(`import { Link } from '@inertiajs/react';\n${starter}`)).toBeNull();
    expect(capture(`import { Link } from '@inertiajs/\\x72eact';\n${starter}`)).toBeNull();
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
    [
      'conflicting module binding',
      `${imports}\nconst resolvePageComponent = custom;\n${bootstrap}`,
    ],
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
