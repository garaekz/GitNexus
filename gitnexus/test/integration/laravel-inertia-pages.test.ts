import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { cliAnalysisEnv, CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';
import { writeFixtureRepo } from '../helpers/resolution-graph.js';
import { initGitRepo } from '../helpers/temp-git-repo.js';
import { cleanupTempDirSync } from '../helpers/test-db.js';

const controller = 'app/Http/Controllers/OrderController.php';
const entry = 'resources/js/app.ts';
const resolver = (directory: string) =>
  [
    "import { createInertiaApp } from '@inertiajs/vue3';",
    "import { resolvePageComponent } from 'laravel-vite-plugin/inertia-helpers';",
    'createInertiaApp({',
    '  resolve: name => resolvePageComponent(',
    '    `./' + directory + '/${name}.vue`,',
    "    import.meta.glob('./" + directory + "/**/*.vue'),",
    '  ),',
    '});',
  ].join('\n');
const handler = (expression: string) => String.raw`<?php
namespace App\Http\Controllers;

use Inertia\Inertia;

class OrderController
{
    public function show() { return ${expression}; }
    public function dynamic($name) { return Inertia::render($name); }
    public function missing() { return Inertia::render('Orders/Absent'); }
    public function wrongCase() { return Inertia::render('orders/show'); }
    public function ignored() { return Inertia::render('Orders/Hidden'); }
    public function helper() { return Inertia::render('Orders/Show'); }
}`;

const route = "MATCH (r:Route {name: '/orders'})<-[h:CodeRelation]-(m:Method {name: 'show'})";
const usesPage = "u.type = 'USES' AND u.reason = 'laravel-inertia-render'";
const endpoints =
  `MATCH (m:Method)-[u:CodeRelation]->(p:File) WHERE ${usesPage} ` +
  'RETURN m.name AS handler, p.filePath AS page ORDER BY handler, page';

it('follows the route through its controller to the configured Vue file across reindexing', () => {
  const scratch = fileURLToPath(new URL('../../.tmp-test/', import.meta.url));
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'laravel-inertia-'));
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
    });
  const analyze = (...args: string[]) =>
    cli('analyze', '--index-only', '--skip-fts', '--workers', '1', ...args);
  const query = (statement: string): { row_count: number; markdown: string } =>
    JSON.parse(cli('cypher', statement, '--repo', repo));
  const expectPage = (file: string) => {
    const rows = query(endpoints);
    expect(rows.row_count, rows.markdown).toBe(1);
    expect(rows.markdown).toContain(`| show | ${file} |`);
    return rows.markdown;
  };
  const vue = '<template><main>Order</main></template>\n';
  try {
    writeFixtureRepo(repo, {
      '.gitignore': 'resources/js/Pages/Orders/Hidden.vue\nresources/js/ignored.ts\n',
      'routes/web.php': String.raw`<?php
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\OrderController;
Route::get('/orders', [OrderController::class, 'show']);
Route::get('/dynamic', [OrderController::class, 'dynamic']);
Route::get('/missing', [OrderController::class, 'missing']);
Route::get('/wrong-case', [OrderController::class, 'wrongCase']);
Route::get('/ignored', [OrderController::class, 'ignored']);`,
      [entry]: resolver('Pages'),
      'resources/js/ignored.ts': resolver('Screens'),
      [controller]: handler("Inertia::render('Orders/Show', ['order' => 1])"),
      'resources/js/Pages/Orders/Show.vue': vue,
      'resources/js/Pages/Orders/Hidden.vue': vue,
      'resources/js/Screens/Orders/Show.vue': vue,
      'resources/js/Screens/Orders/Edit.vue': vue,
      'resources/js/components/Orders/Absent.vue': vue,
    });
    initGitRepo(repo);
    analyze();
    const routeWhere = `h.type = 'HANDLES_ROUTE' AND m.filePath = '${controller}'`;
    const handlers = query(
      `MATCH (:Route)<-[h:CodeRelation]-(m:Method) WHERE ${routeWhere} ` +
        'RETURN m.name AS handler ORDER BY handler',
    );
    expect(handlers.row_count, handlers.markdown).toBe(5);
    for (const name of ['dynamic', 'ignored', 'missing', 'show', 'wrongCase']) {
      expect(handlers.markdown).toContain(`| ${name} |`);
    }
    const walk = query(
      `${route}-[u:CodeRelation]->(p:File) WHERE ${routeWhere} AND ${usesPage} ` +
        'RETURN r.name AS route, m.name AS handler, p.filePath AS page',
    );
    expect(walk.row_count, walk.markdown).toBe(1);
    expect(walk.markdown).toContain('| /orders | show | resources/js/Pages/Orders/Show.vue |');
    expectPage('resources/js/Pages/Orders/Show.vue');

    // Only the resolver changes. Both files still exist and the controller is untouched.
    fs.writeFileSync(path.join(repo, entry), resolver('Screens'));
    analyze();
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'index', 'gitnexus.json'), 'utf8'));
    expect(meta.graphCompaction.incrementalWrites).toBe(1);
    const retargeted = expectPage('resources/js/Screens/Orders/Show.vue');
    expect(analyze('--force')).toMatch(/reusing cached parser output for [1-9]\d* file\(s\)/);
    expect(query(endpoints).markdown).toBe(retargeted);
    analyze('--force', '--no-parse-cache');
    expect(query(endpoints).markdown).toBe(retargeted);

    const adminEntry = path.join(repo, 'resources/js/admin.ts');
    fs.writeFileSync(adminEntry, resolver('Pages'));
    analyze();
    expect(query(endpoints)).toMatchObject({ row_count: 0 });
    fs.unlinkSync(adminEntry);
    analyze();
    expectPage('resources/js/Screens/Orders/Show.vue');

    fs.writeFileSync(path.join(repo, controller), handler("Inertia::render('Orders/Edit')"));
    analyze();
    expectPage('resources/js/Screens/Orders/Edit.vue');
    fs.writeFileSync(path.join(repo, controller), handler('null'));
    analyze();
    expect(query(endpoints)).toMatchObject({ row_count: 0 });

    fs.writeFileSync(path.join(repo, controller), handler("Inertia::render('Orders/Show')"));
    const otherEntry = path.join(repo, 'resources/js/app.js');
    fs.writeFileSync(otherEntry, resolver('Pages'));
    analyze();
    expect(query(endpoints)).toMatchObject({ row_count: 0 });

    fs.unlinkSync(otherEntry);
    fs.writeFileSync(
      path.join(repo, entry),
      resolver('Screens').replace('resolve: name', 'other: name'),
    );
    analyze();
    expect(
      query("MATCH (f:File {filePath: 'resources/js/ignored.ts'}) RETURN f.name AS name").row_count,
    ).toBe(0);
    expect(query(endpoints)).toMatchObject({ row_count: 0 });
  } finally {
    cleanupTempDirSync(root);
  }
}, 300_000);
