import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTsParser } from '../../src/core/ingestion/languages/typescript/query.js';
import { typescriptProvider } from '../../src/core/ingestion/languages/typescript.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';
import { createFetchWrapperContext } from '../../src/core/ingestion/route-extractors/fetch-wrapper.js';
import { extractFrameworkRouteFacts } from '../../src/core/ingestion/route-extractors/framework-route-facts.js';
import {
  captureInertiaClientCalls,
  hasOpaqueInertiaFactoryUse,
  hasCompetingInertiaClient,
} from '../../src/core/ingestion/route-extractors/laravel-inertia-clients.js';

const factory = '@inertiajs/vue3';
const entry = 'resources/js/app.ts';
const app = `import { createInertiaApp } from '${factory}'; createInertiaApp({});`;
const facade = `export {createInertiaApp as launch} from '${factory}';`;

function competes(sources: Record<string, string>, overrides: Record<string, string[]> = {}) {
  const files = Object.entries({ [entry]: app, ...sources }).map(([filePath, source]) => {
    const tree = getTsParser().parse(source);
    const parsed = extractParsedFile(typescriptProvider, source, filePath, undefined, tree);
    if (!parsed) throw new Error(`Missing scope facts for ${filePath}`);
    const context = createFetchWrapperContext(tree, parsed);
    const facts = extractFrameworkRouteFacts(tree, parsed, 0, context.bindings);
    return {
      filePath,
      facts: { ...facts, inertiaClientCalls: captureInertiaClientCalls(facts, context, parsed) },
    };
  });
  return hasCompetingInertiaClient(files, new Set([entry]), (from, name) => {
    if (overrides[name]) return overrides[name];
    const relative = path.posix.join(path.posix.dirname(from), name) + '.ts';
    return files.some((f) => f.filePath === relative) ? [relative] : [];
  });
}

describe('Laravel Inertia client provenance', () => {
  it.each([
    ['run(launch)', true],
    ['let alias; alias = launch; alias({})', true],
    ['const alias = launch; run(alias)', true],
    ['launch.call(null, {})', true],
    ['const options = { launch }', true],
    ['const alias = launch; export {alias as start}', false],
    ['export default launch', false],
    ['void launch; function fork(launch: any){run(launch)}', false],
    ['launch({})', false],
  ])('recognizes opaque direct factory uses in %s', (body, opaque) => {
    const source = `import {createInertiaApp as launch} from '${factory}'; ${body}`;
    const tree = getTsParser().parse(source);
    const parsed = extractParsedFile(typescriptProvider, source, 'admin.ts', undefined, tree);
    if (!parsed) throw new Error('Missing scope facts for admin.ts');
    const { bindings } = createFetchWrapperContext(tree, parsed);
    expect(hasOpaqueInertiaFactoryUse(parsed, tree, bindings)).toBe(opaque);
  });
  it.each([
    'import {launch as boot} from "./bridge"; boot({});',
    'import {launch} from "./bridge"; const boot = launch; boot?.({});',
    'import * as adapter from "./bridge"; adapter.launch({});',
    'import * as adapter from "./bridge"; adapter["launch"]({});',
    'import * as adapter from "./bridge"; const boot = adapter["launch"]; boot({});',
    'import * as adapter from "./bridge"; const { launch: boot } = adapter; boot({});',
    'const { launch: boot } = await import("./bridge"); boot({});',
    'const adapter = await import("./bridge"); adapter.launch({});',
    '(await import("./bridge")).launch({});',
    'const { launch: boot } = require("./bridge"); boot({});',
  ])('follows invoked factory aliases and wildcard barrels: %s', (source) => {
    expect(
      competes({
        'facade.ts': facade,
        'bridge.ts': 'export * from "./facade"',
        'admin.ts': source,
      }),
    ).toBe(true);
  });

  it('follows default and namespace reexports using project module targets', () => {
    expect(
      competes(
        {
          'bridge.ts': `export * as adapter from '${factory}'`,
          'facade.ts': 'import {adapter} from "@bridge"; export default adapter.createInertiaApp;',
          'admin.ts': 'import boot from "./facade"; boot({});',
        },
        { '@bridge': ['bridge.ts'] },
      ),
    ).toBe(true);
  });

  it('counts two starts in one conventional entry', () => {
    expect(
      competes({
        'facade.ts': facade,
        [entry]: app + ' import {launch} from "../../facade"; launch({});',
      }),
    ).toBe(true);
  });

  it('follows quoted module export names through a local barrel', () => {
    expect(
      competes({
        'facade.ts': `export { "createInertiaApp" as "boot admin" } from '${factory}';`,
        'admin.ts': 'import { "boot admin" as launch } from "./facade"; launch({});',
      }),
    ).toBe(true);
  });

  it('follows a direct star reexport from the adapter', () => {
    expect(
      competes({
        'facade.ts': `export * from '${factory}';`,
        'admin.ts': 'import {createInertiaApp} from "./facade"; createInertiaApp({});',
      }),
    ).toBe(true);
  });

  it('requires the admitted client call to reach the external adapter', () => {
    expect(
      competes(
        { 'foreign.ts': 'export function createInertiaApp() {}' },
        {
          [factory]: ['foreign.ts'],
        },
      ),
    ).toBe(true);
  });

  it('resolves decoded escaped adapter specifiers', () => {
    expect(
      competes({
        'admin.ts': String.raw`import {createInertiaApp as start} from '@inertiajs/\x76ue3'; start({});`,
      }),
    ).toBe(true);
  });

  it.each([
    'import { launch } from "./facade";',
    'import * as adapter from "./facade"; void adapter.launch;',
    'import * as adapter from "./facade"; const boot = adapter["launch"];',
    'import * as adapter from "./facade"; const boot = adapter[key]; boot({});',
    'import * as adapter from "./facade"; function run(adapter: any) { const boot = adapter["launch"]; boot({}); }',
    'import { launch } from "./facade"; function run(launch: Function){ launch({}); }',
    'import type { launch } from "./facade";',
    `import { usePage } from '${factory}'; usePage();`,
  ])('keeps unused and unrelated imports and local shadow calls benign: %s', (source) => {
    expect(competes({ 'facade.ts': facade, 'admin.ts': source })).toBe(false);
  });

  it('honors explicit exports over stars and excludes default from star exports', () => {
    expect(
      competes({
        'facade.ts': facade + ' export default function boot() {}',
        'bridge.ts': 'export * from "./facade"; export function launch() {}',
        'admin.ts': 'import boot, {launch} from "./bridge"; boot({}); launch({});',
      }),
    ).toBe(false);
  });

  it('explores possible factory paths across ambiguous project targets and star cycles', () => {
    const sources = {
      'a.ts': 'export * from "./b";',
      'b.ts': 'export * from "./a"; export * from "@barrel";',
      'facade.ts': facade,
      'other.ts': 'export function launch() {}',
      'admin.ts': 'import { launch } from "./a"; launch({});',
    };
    expect(competes(sources, { '@barrel': ['other.ts', 'facade.ts'] })).toBe(true);
    expect(competes(sources, { '@barrel': ['other.ts'] })).toBe(false);
  });
});
