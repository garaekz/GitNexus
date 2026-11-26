import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { cliAnalysisEnv, CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';
import { gitCommitAll } from '../helpers/incremental-test-repo.js';
import { writeFixtureRepo } from '../helpers/resolution-graph.js';
import { initGitRepo } from '../helpers/temp-git-repo.js';
import { cleanupTempDirSync } from '../helpers/test-db.js';

const js = 'resources/js/';
const app = js + 'app.ts';
const ssr = js + 'ssr.js';
const show = 'Orders/Show.vue';
const vue = '<template><main>Order details</main></template>';
const factory = "import { createInertiaApp } from '@inertiajs/vue3';";
const helper = "import { resolvePageComponent } from 'laravel-vite-plugin/inertia-helpers';";
const resolvePage = (dir: string) =>
  'resolve: (name) => resolvePageComponent(`./' +
  dir +
  '/${name}.vue`, import.meta.glob("./' +
  dir +
  '/**/*.vue"))';
const client = (dir: string) => `${factory}
${helper}
createInertiaApp({ ${resolvePage(dir)} });`;
const breezeServer = (dir: string) => `${factory}
${helper}
import createServer from '@inertiajs/vue3/server';
import { renderToString } from '@vue/server-renderer';
import { createSSRApp, h } from 'vue';
createServer((page) => createInertiaApp({
  page,
  render: renderToString,
  ${resolvePage(dir)},
  setup({ App, props, plugin }) {
    return createSSRApp({ render: () => h(App, props) }).use(plugin);
  },
}));`;

const routePage = `MATCH (r:Route {name: '/orders'})<-[h:CodeRelation]-(m:Method)-[u:CodeRelation]->(f:File)
  WHERE h.type = 'HANDLES_ROUTE' AND u.type = 'USES' AND u.reason = 'laravel-inertia-render'
  RETURN f.filePath AS page`;

function createFixture(files: Record<string, string>) {
  const scratch = fileURLToPath(new URL('../../.tmp-test/', import.meta.url));
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'laravel-inertia-'));
  onTestFinished(() => cleanupTempDirSync(root));
  const repo = path.join(root, 'app');
  const env = cliAnalysisEnv({
    GITNEXUS_HOME: path.join(root, 'home'),
    GITNEXUS_STORAGE_PATH: path.join(root, 'index'),
    GITNEXUS_SHARED_STORE: 'off',
    GITNEXUS_LBUG_EXTENSION_INSTALL: 'load-only',
  });
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, [...CLI_SPAWN_PREFIX, ...args], {
      cwd: repo,
      env,
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      stdio: 'pipe',
    });
  writeFixtureRepo(repo, {
    'routes/web.php': String.raw`<?php
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\OrderController;
Route::get('/orders', [OrderController::class, 'show']);`,
    'app/Http/Controllers/OrderController.php': String.raw`<?php
namespace App\Http\Controllers;
use Inertia\Inertia;
class OrderController
{
    public function show() { return Inertia::render('Orders/Show'); }
}`,
    ...files,
  });
  initGitRepo(repo);
  gitCommitAll(repo, 'Fixture baseline');
  return {
    write: (files: Record<string, string>) => writeFixtureRepo(repo, files),
    incrementalWrites: () =>
      JSON.parse(fs.readFileSync(path.join(root, 'index', 'gitnexus.json'), 'utf8')).graphCompaction
        .incrementalWrites,
    remove: (file: string) => fs.unlinkSync(path.join(repo, file)),
    move: (from: string, to: string) => fs.renameSync(path.join(repo, from), path.join(repo, to)),
    check: (expected: string | null, ...flags: string[]) => {
      const log = cli('analyze', '--index-only', '--skip-fts', '--workers', '1', ...flags);
      const result = JSON.parse(cli('cypher', routePage, '--repo', repo));
      expect(result.row_count, result.markdown).toBe(expected === null ? 0 : 1);
      if (expected !== null) expect(result.markdown).toContain(`| ${js}${expected}/${show} |`);
      return log;
    },
  };
}

const explicitClient = {
  [app]: client('Pages'),
  [js + 'Pages/' + show]: vue,
  [js + 'Screens/' + show]: vue,
};

it('keeps a shared Breeze SSR page map and drops the edge when SSR disagrees', () => {
  const project = createFixture(explicitClient);
  project.check('Pages');
  project.write({ [ssr]: breezeServer('Pages') });
  project.check('Pages');
  expect(project.incrementalWrites()).toBe(1);
  expect(project.check('Pages', '--force')).toMatch(
    /reusing cached parser output for [1-9]\d* file\(s\)/,
  );
  project.write({ [ssr]: breezeServer('Screens') });
  project.check(null);
  project.remove(ssr);
  project.check('Pages');
  project.check('Pages', '--force', '--no-parse-cache');
}, 300_000);

it('recognizes a competing app behind explicit and wildcard factory reexports', () => {
  const barrel = js + 'bridge.ts';
  const consumer = js + 'admin.ts';
  const project = createFixture({
    ...explicitClient,
    [barrel]: "export { createInertiaApp as boot } from '@inertiajs/vue3';",
    [consumer]: `import { boot } from './bridge';\n${helper}\nboot({ ${resolvePage('Screens')} });`,
  });
  project.check(null);
  project.write({
    [barrel]: "export * from '@inertiajs/vue3';",
    [consumer]: `import { createInertiaApp as boot } from './bridge';\n${helper}\nboot({ ${resolvePage('Screens')} });`,
  });
  project.check(null);
  project.check(null, '--force', '--no-parse-cache');
  project.write({
    [consumer]: "import { Link } from './bridge';\nexport const component = Link;",
  });
  project.check('Pages');
}, 300_000);

it('uses the imported helper binding despite an unrelated property, until a local module shadows it', () => {
  const project = createFixture({
    ...explicitClient,
    [app]: client('Pages') + '\nconst labels = { resolvePageComponent: "order page" };\n',
  });
  project.check('Pages');
  project.write({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        baseUrl: '.',
        paths: { 'laravel-vite-plugin/inertia-helpers': ['./resources/js/local-helper.ts'] },
      },
    }),
    [js + 'local-helper.ts']: 'export function resolvePageComponent() { return null; }',
  });
  project.check(null);
}, 120_000);

const v3Entry = `${factory}
import AppLayout from './layouts/AppLayout.vue';
void createInertiaApp({
  title: (title) => title || 'Orders',
  layout: (name) => name.startsWith('auth/') ? null : AppLayout,
  withApp: (app) => { app.directive('focus', { mounted(el) { el.focus(); } }); },
  progress: { color: '#4b5563' },
});`;

const vite = `import inertia from '@inertiajs/vite';
import laravel from 'laravel-vite-plugin';
import vue from '@vitejs/plugin-vue';
import { defineConfig, lazyPlugins } from 'vite-plus';
export default defineConfig({
  plugins: lazyPlugins(() => [
    laravel({ input: ['resources/css/app.css', 'resources/js/app.ts'], refresh: true }),
    inertia(),
    vue(),
  ]),
});`;

it('indexes the Vue 3 starter only while its Vite plugin and default page map apply', () => {
  const config = 'vite.config.ts';
  const project = createFixture({
    [app]: v3Entry,
    [config]: vite,
    'package.json': JSON.stringify({
      type: 'module',
      dependencies: {
        '@inertiajs/vite': '^3.0.0',
        '@inertiajs/vue3': '^3.0.0',
        vue: '^3.5.13',
        'laravel-vite-plugin': '^3.0.0',
      },
    }),
    [js + 'pages/' + show]: vue,
    [js + 'components/' + show]: vue,
    [js + 'layouts/AppLayout.vue']: '<template><main><slot /></main></template>',
  });
  project.check('pages');
  project.write({ [config]: vite.replace('inertia(),', '') });
  project.check(null);
  expect(project.incrementalWrites()).toBe(1);
  project.write({ [config]: vite.replace("'resources/js/app.ts'", "'resources/js/admin.ts'") });
  project.check(null);
  project.write({ [config]: vite.replace('vue(),', "vue({ exclude: ['**/*.vue'] }),") });
  project.check(null);
  project.write({ [config]: vite.replace('inertia(),', 'inertia({ frameworks: custom }),') });
  project.check(null);
  project.write({
    [config]: vite,
    [app]: v3Entry.replace('title:', "pages: { path: './components', transform: rename }, title:"),
  });
  project.check(null);
  project.write({ [app]: v3Entry });
  project.check('pages');
  // The intermediate name also exercises the case-sensitive directory change on Windows.
  project.move(js + 'pages', js + 'unused');
  project.check(null);
  project.move(js + 'unused', js + 'Pages');
  project.check('Pages');
  project.check('Pages', '--force', '--no-parse-cache');
}, 300_000);
