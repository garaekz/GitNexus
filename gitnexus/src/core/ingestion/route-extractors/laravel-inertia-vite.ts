import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import type { ParsedFile } from 'gitnexus-shared';
import type Parser from 'tree-sitter';
import { inertiaEntryPaths } from './laravel-inertia-resolver.js';

type Node = Parser.SyntaxNode;
export const inertiaViteConfigPaths = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
] as const;
/** Runtime modules whose package identities the starter config relies on. */
const inertiaViteConfigModules = [
  'vite',
  'vite-plus',
  '@inertiajs/vite',
  'laravel-vite-plugin',
  'laravel-vite-plugin/fonts',
  '@vitejs/plugin-vue',
  '@tailwindcss/vite',
  '@laravel/vite-plugin-wayfinder',
] as const;

export type InertiaViteConfig = { entry: string; modules: readonly string[] };

/** An ignored or linked config can still be selected by Vite. Six metadata
 * lookups suffice and keep large repository roots off a full directory scan. */
export function isSoleInertiaViteConfig(repoPath: string, indexedConfig: string): boolean {
  try {
    if (!lstatSync(repoPath).isDirectory()) return false;
    return (
      inertiaViteConfigPaths.some((name) => name === indexedConfig) &&
      inertiaViteConfigPaths.every((name) => {
        const stat = lstatSync(path.join(repoPath, name), { throwIfNoEntry: false });
        return name === indexedConfig ? stat?.isFile() === true : stat === undefined;
      })
    );
  } catch {
    return false;
  }
}

const children = (node: Node) => node.namedChildren.filter((item) => item.type !== 'comment');

/** Accept only literal, uniquely named configuration properties. */
function properties(
  node: Node | undefined,
  allowed?: readonly string[],
): Map<string, Node> | undefined {
  if (node?.type !== 'object') return;
  const values = new Map<string, Node>();
  for (const pair of children(node)) {
    const key = pair.childForFieldName('key');
    const value = pair.childForFieldName('value');
    if (pair.type !== 'pair' || key?.type !== 'property_identifier' || !value) return;
    const name = key.text;
    if (
      name.includes('\\') ||
      name === '__proto__' ||
      values.has(name) ||
      (allowed && !allowed.includes(name))
    )
      return;
    values.set(name, value);
  }
  return values;
}

function literalData(node: Node): boolean {
  if (node.type === 'object') {
    const fields = properties(node);
    return !!fields && [...fields.values()].every(literalData);
  }
  if (node.type === 'array') return children(node).every(literalData);
  return ['string', 'number', 'true', 'false', 'null'].includes(node.type);
}

/** Match the actual value import; the accepted program has no local declarations. */
function importedCall(file: ParsedFile, node: Node | undefined) {
  if (
    node?.type !== 'call_expression' ||
    node.children.some((item) => item.type === 'optional_chain')
  )
    return;
  const fn = node.childForFieldName('function');
  const args = node.childForFieldName('arguments');
  if (fn?.type !== 'identifier' || !args) return;
  const bindings = file.parsedImports.filter(
    (binding) => 'localName' in binding && binding.localName === fn.text,
  );
  const imported = bindings[0];
  if (
    bindings.length !== 1 ||
    (imported.kind !== 'alias' && imported.kind !== 'named') ||
    imported.typeOnly
  )
    return;
  return { module: imported.targetRaw, member: imported.importedName, args: children(args) };
}

function laravelInput(file: ParsedFile, options: Node | undefined): string | undefined {
  const fields = properties(options, ['input', 'refresh', 'fonts']);
  if (!fields) return;
  const refresh = fields.get('refresh');
  if (refresh && !literalData(refresh)) return;
  const fonts = fields.get('fonts');
  if (
    fonts &&
    (fonts.type !== 'array' ||
      !children(fonts).every((font) => {
        const call = importedCall(file, font);
        return (
          call?.module === 'laravel-vite-plugin/fonts' &&
          call.member === 'bunny' &&
          call.args.every(literalData)
        );
      }))
  )
    return;
  const input = fields.get('input');
  if (!input) return;
  const inputs = input.type === 'array' ? children(input) : [input];
  let entry: string | undefined;
  for (const item of inputs) {
    if (item.type !== 'string') return;
    const value = item.text.slice(1, -1);
    if (/^resources\/[\w/-]+\.css$/.test(value)) continue;
    if (entry || !inertiaEntryPaths.includes(value)) return;
    entry = value;
  }
  return entry;
}

function pluginArray(file: ParsedFile, value: Node | undefined): Node | undefined {
  if (value?.type === 'array') return value;
  const lazy = importedCall(file, value);
  if (lazy?.module !== 'vite-plus' || lazy.member !== 'lazyPlugins' || lazy.args.length !== 1)
    return;
  const factory = lazy.args[0];
  const parameters = factory.childForFieldName('parameters');
  const body = factory.childForFieldName('body');
  if (
    factory.type === 'arrow_function' &&
    parameters &&
    children(parameters).length === 0 &&
    !factory.children.some((item) => item.type === 'async') &&
    body?.type === 'array'
  )
    return body;
}

function starterVueTemplate(options: Node): boolean {
  const template = properties(options, ['template'])?.get('template');
  const assetUrls = properties(template, ['transformAssetUrls'])?.get('transformAssetUrls');
  const settings = properties(assetUrls, ['base', 'includeAbsolute']);
  return (
    settings?.get('base')?.type === 'null' && settings.get('includeAbsolute')?.type === 'false'
  );
}

/** The starter registers inertia() and the browser input in the same plugin list. */
export function captureInertiaViteEntry(
  file: ParsedFile,
  tree: Parser.Tree,
): InertiaViteConfig | undefined {
  if (file.filePath !== 'vite.config.ts' && file.filePath !== 'vite.config.js') return;
  if (tree.rootNode.hasError) return;
  const body = children(tree.rootNode).filter((statement) => statement.type !== 'import_statement');
  if (
    body.length !== 1 ||
    body[0].type !== 'export_statement' ||
    !body[0].children.some((child) => child.type === 'default')
  )
    return;
  const config = importedCall(file, body[0].childForFieldName('value') ?? undefined);
  if (
    !config ||
    (config.module !== 'vite' && config.module !== 'vite-plus') ||
    config.member !== 'defineConfig' ||
    config.args.length !== 1
  )
    return;
  // Other top-level settings may replace Vite's root, aliases or build inputs.
  const options = properties(config.args[0], ['plugins', 'server', 'lint', 'fmt']);
  if (!options) return;
  for (const [name, value] of options) if (name !== 'plugins' && !literalData(value)) return;
  const plugins = pluginArray(file, options.get('plugins'));
  if (!plugins) return;
  let entry: string | undefined;
  let inertia = false;
  let vue = false;
  for (const element of children(plugins)) {
    const call = importedCall(file, element);
    if (!call) return;
    if (call.module === '@inertiajs/vite' && call.member === 'default') {
      if (inertia || call.args.length !== 0) return;
      inertia = true;
    } else if (call.module === 'laravel-vite-plugin' && call.member === 'default') {
      if (entry || call.args.length !== 1) return;
      entry = laravelInput(file, call.args[0]);
      if (!entry) return;
    } else if (call.module === '@vitejs/plugin-vue' && call.member === 'default') {
      if (vue || call.args.length > 1 || (call.args.length && !starterVueTemplate(call.args[0])))
        return;
      vue = true;
    } else if (call.module === '@tailwindcss/vite' && call.member === 'default') {
      if (call.args.length) return;
    } else if (call.module === '@laravel/vite-plugin-wayfinder' && call.member === 'wayfinder') {
      if (
        call.args.length > 1 ||
        (call.args.length &&
          (!properties(call.args[0], ['formVariants']) || !literalData(call.args[0])))
      )
        return;
    } else return;
  }
  if (inertia && vue && entry) {
    const modules = inertiaViteConfigModules.filter((id) =>
      file.parsedImports.some((binding) => binding.targetRaw === id),
    );
    return { entry, modules };
  }
}

/** Inertia Vue v3 tries pages/NAME.vue, then Pages/NAME.vue. An ignored first
 * choice still shadows the second one. Directory listings preserve on-disk
 * case even on Windows and are reused only during this analysis. */
export function createInertiaVitePageResolver(repoPath: string, paths: ReadonlySet<string>) {
  const listings = new Map<string, Map<string, Dirent> | null>();
  function definitelyAbsent(relative: string): boolean {
    let directory = repoPath;
    for (const segment of relative.split('/')) {
      let entries = listings.get(directory);
      if (entries === undefined) {
        try {
          entries = lstatSync(directory).isDirectory()
            ? new Map(
                readdirSync(directory, { withFileTypes: true }).map((item) => [item.name, item]),
              )
            : null;
        } catch {
          entries = null;
        }
        listings.set(directory, entries);
      }
      if (!entries) return false;
      const child = entries.get(segment);
      if (!child) return true;
      if (!child.isDirectory()) return false;
      directory = path.join(directory, segment);
    }
    return false;
  }
  return (entry: string, page: string): string | undefined => {
    if (!inertiaEntryPaths.includes(entry) || !/^[\w-]+(?:\/[\w-]+)*$/.test(page)) return;
    const base = path.posix.dirname(entry);
    const preferred = `${base}/pages/${page}.vue`;
    if (paths.has(preferred)) return preferred;
    const fallback = `${base}/Pages/${page}.vue`;
    if (paths.has(fallback) && definitelyAbsent(preferred)) return fallback;
  };
}

function gitInvisiblePaths(repoPath: string, candidates: Set<string>): Set<string> | undefined {
  // run-analyze only uses the Git clean-tree shortcut for a root with .git.
  if (!lstatSync(path.join(repoPath, '.git'), { throwIfNoEntry: false })) return new Set();
  const options = { cwd: repoPath, encoding: 'utf8' as const, windowsHide: true, timeout: 10_000 };
  const tracking = spawnSync('git', ['config', '--get', 'status.showUntrackedFiles'], options);
  if (
    tracking.error ||
    tracking.stderr ||
    (tracking.status !== 1 &&
      (tracking.status !== 0 || !['normal', 'all'].includes(tracking.stdout.trim().toLowerCase())))
  )
    return;
  const input = [...candidates].join('\0') + '\0';
  const result = spawnSync(
    'git',
    ['-c', 'core.fsmonitor=false', 'check-ignore', '--no-index', '-z', '--stdin'],
    {
      ...options,
      input,
      maxBuffer: Math.max(64 * 1024, Buffer.byteLength(input) + 1024),
    },
  );
  if (result.error || (result.status !== 0 && result.status !== 1) || result.stderr) return;
  return new Set(result.stdout.split('\0'));
}

/** A future *ignored* addition won't necessarily trigger an incremental run.
 * Only rely on absence for candidates that both Git and GitNexus can observe.
 * Ask Git once for the possible shadows of the PHP literals, irrespective of
 * whether the absent files currently have entries in the index. */
export async function prepareInertiaVitePageResolver(
  repoPath: string,
  paths: ReadonlySet<string>,
  indexedConfig: string,
  pages: Iterable<string>,
) {
  if (!isSoleInertiaViteConfig(repoPath, indexedConfig)) return;
  const alternateConfigs = inertiaViteConfigPaths.filter((name) => name !== indexedConfig);
  const candidates = new Set<string>(alternateConfigs);
  const lookup = createInertiaVitePageResolver(repoPath, paths);
  for (const page of pages) {
    // A fallback must already exist in the graph before an absent preferred
    // file could influence the result. Bound this set by referenced pages.
    if (lookup('resources/js/app.ts', page) === `resources/js/Pages/${page}.vue`) {
      candidates.add(`resources/js/pages/${page}.vue`);
    }
  }
  let blocked: Set<string> | undefined;
  try {
    blocked = gitInvisiblePaths(repoPath, candidates);
    if (!blocked) return;
    const [{ Glob }, { createIgnoreFilter }] = await Promise.all([
      import('glob'),
      import('../../../config/ignore-service.js'),
    ]);
    const filter = await createIgnoreFilter(repoPath, { strictRepoControlFiles: true });
    // Glob owns the same path-scurry objects used in the filesystem walker.
    const root = new Glob('**', { cwd: repoPath }).scurry.cwd;
    const checkedDirs = new Map<string, boolean>();
    for (const candidate of candidates) {
      if (blocked.has(candidate)) continue;
      let dir = root;
      for (const segment of candidate.split('/').slice(0, -1)) {
        dir = dir.resolve(segment);
        const key = dir.fullpath();
        let skip = checkedDirs.get(key);
        if (skip === undefined) {
          const stat = lstatSync(key, { throwIfNoEntry: false });
          skip = (!!stat && !stat.isDirectory()) || filter.childrenIgnored(dir);
          checkedDirs.set(key, skip);
        }
        if (skip) {
          blocked.add(candidate);
          break;
        }
      }
      if (!blocked.has(candidate) && filter.ignored(root.resolve(candidate)))
        blocked.add(candidate);
    }
  } catch {
    return;
  }
  if (alternateConfigs.some((name) => blocked.has(name))) return;
  return (entry: string, page: string) => {
    const resolved = lookup(entry, page);
    if (resolved === `resources/js/Pages/${page}.vue`) {
      const preferred = `resources/js/pages/${page}.vue`;
      if (!candidates.has(preferred) || blocked.has(preferred)) return;
    }
    return resolved;
  };
}
