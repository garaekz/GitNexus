import type { ParsedFile } from 'gitnexus-shared';
import type Parser from 'tree-sitter';
import { generateId } from '../../../lib/utils.js';
import { INERTIA_PAGE_REASON } from '../../graph/edge-reasons.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import type { SemanticModel } from '../model/semantic-model.js';
import { extractInertiaRenders } from '../languages/php/inertia-render.js';
import type { ExtractedDecoratorRoute } from '../workers/parse-worker.js';
import type { FrameworkImportResolver } from './framework-route-types.js';
import type { ExtractedRoute } from './laravel.js';
import { hasCompetingInertiaClient } from './laravel-inertia-clients.js';
import {
  inertiaEntryPaths,
  inertiaServerEntryPaths,
  type InertiaBootstrap,
} from './laravel-inertia-resolver.js';
import {
  prepareInertiaVitePageResolver,
  inertiaViteConfigPaths,
  type InertiaViteConfig,
} from './laravel-inertia-vite.js';
import { normalizeExtractedRoutePath, normalizeRouteMethod, routeNodeKey } from './route-path.js';

type ControllerFacts = { inertiaRenders: ReturnType<typeof extractInertiaRenders> };
type RouteFile = { filePath: string; facts: unknown };
type LinkContext = {
  selectedRoutes: ReadonlySet<ExtractedRoute | ExtractedDecoratorRoute>;
  resolveImportTargets: FrameworkImportResolver;
  repoPath: string;
};

export function extractInertiaControllerFacts(
  tree: Parser.Tree,
  file: ParsedFile,
): ControllerFacts | undefined {
  if (!file.filePath.startsWith('app/Http/Controllers/') || !file.filePath.endsWith('.php')) return;
  const inertiaRenders = extractInertiaRenders(tree);
  return inertiaRenders.length ? { inertiaRenders } : undefined;
}

/** Select one client. A certified server may repeat the client's explicit map. */
async function projectPageResolver(
  paths: ReadonlySet<string>,
  files: readonly RouteFile[],
  context: LinkContext,
  pages: ReadonlySet<string>,
) {
  const entries = inertiaEntryPaths.filter((entry) => paths.has(entry));
  const servers = inertiaServerEntryPaths.filter((entry) => paths.has(entry));
  if (entries.length !== 1 || servers.length > 1) return;
  const entry = entries[0];
  const server = servers[0];
  const accepted = new Set(entries.concat(servers));
  let clientMap: InertiaBootstrap | undefined;
  let serverMap: InertiaBootstrap | undefined;
  let viteConfig: InertiaViteConfig | undefined;
  for (const { filePath, facts } of files) {
    if (!facts || typeof facts !== 'object') continue;
    if ('inertiaViteConfig' in facts) viteConfig = facts.inertiaViteConfig as InertiaViteConfig;
    if (!('inertiaBootstrap' in facts)) continue;
    const bootstrap = facts.inertiaBootstrap as InertiaBootstrap | null;
    if (!bootstrap || !accepted.has(filePath)) return;
    if (filePath === entry) clientMap = bootstrap;
    else serverMap = bootstrap;
  }
  if (!clientMap || clientMap.kind === 'server') return;
  if (
    server &&
    (serverMap?.kind !== 'server' ||
      clientMap.kind !== 'client' ||
      serverMap.directory !== clientMap.directory)
  )
    return;
  // A package-looking import may be redirected to a local file by tsconfig.
  for (const filePath of accepted) {
    if (context.resolveImportTargets(filePath, '@inertiajs/vue3').length) return;
    if (
      clientMap.kind === 'client' &&
      context.resolveImportTargets(filePath, 'laravel-vite-plugin/inertia-helpers').length
    )
      return;
  }
  if (server && context.resolveImportTargets(server, '@inertiajs/vue3/server').length) return;
  if (hasCompetingInertiaClient(files, accepted, context.resolveImportTargets)) return;
  if (clientMap.kind === 'client') {
    const directory = clientMap.directory;
    return (page: string) => `${directory}/${page}.vue`;
  }
  const configs = inertiaViteConfigPaths.filter((filePath) => paths.has(filePath));
  if (viteConfig?.entry !== entry || configs.length !== 1) return;
  const config = configs[0];
  if (viteConfig.modules.some((module) => context.resolveImportTargets(config, module).length))
    return;
  const resolve = await prepareInertiaVitePageResolver(context.repoPath, paths, config, pages);
  if (resolve) return (page: string) => resolve(entry, page);
}

/** Join the worker's literal call, the admitted handler, and the bootstrap's
 * resolver to an indexed File. All paths are scanner-relative and case-sensitive. */
export async function linkInertiaPages(
  graph: KnowledgeGraph,
  model: SemanticModel,
  paths: ReadonlySet<string>,
  files: readonly RouteFile[],
  routeHandlers: ReadonlyMap<string, string>,
  context: LinkContext,
): Promise<void> {
  if (!routeHandlers.size) return;
  const controllers = files.filter(
    (file): file is { filePath: string; facts: ControllerFacts } =>
      !!file.facts && typeof file.facts === 'object' && 'inertiaRenders' in file.facts,
  );
  if (!controllers.length) return;
  const pages = new Set<string>();
  for (const { facts } of controllers) {
    for (const render of facts.inertiaRenders) pages.add(render.page);
  }
  const resolvePage = await projectPageResolver(paths, files, context, pages);
  if (!resolvePage) return;

  // Controller lookup can fall back to a unique short name. A method-level
  // page edge is reachable from every route stamped with its ID, so all such
  // controller references must agree on the declaring class.
  const controllersByHandler = new Map<string, string | null>();
  for (const route of context.selectedRoutes) {
    if (!('controllerName' in route) || !route.controllerName || !route.routePath) continue;
    const url = normalizeExtractedRoutePath(route.routePath, route.prefix ?? null);
    const handlerId = routeHandlers.get(routeNodeKey(normalizeRouteMethod(route.httpMethod), url));
    if (!handlerId) continue;
    const controller = route.controllerQualifiedName ?? null;
    const previous = controllersByHandler.get(handlerId);
    controllersByHandler.set(
      handlerId,
      previous === undefined || previous === controller ? controller : null,
    );
  }
  for (const { filePath, facts } of controllers) {
    for (const { controllerQualifiedName, methodName, callLine, page } of facts.inertiaRenders) {
      const pagePath = resolvePage(page);
      if (!pagePath) continue;
      const pageId = generateId('File', pagePath);
      if (!graph.getNode(pageId)) continue;
      const owners = model.symbols
        .lookupExactAll(filePath, methodName)
        .map((def) => graph.getNode(def.nodeId))
        .filter(
          (node) =>
            node?.label === 'Method' &&
            node.properties.startLine !== undefined &&
            node.properties.startLine <= callLine &&
            node.properties.endLine !== undefined &&
            node.properties.endLine >= callLine,
        );
      const owner = owners.length === 1 ? owners[0] : undefined;
      if (
        !owner ||
        !controllerQualifiedName ||
        controllersByHandler.get(owner.id) !== controllerQualifiedName
      )
        continue;
      graph.addRelationship({
        id: generateId('USES', `${owner.id}:${INERTIA_PAGE_REASON}->${pageId}`),
        type: 'USES',
        sourceId: owner.id,
        targetId: pageId,
        reason: INERTIA_PAGE_REASON,
        confidence: 1,
      });
    }
  }
}
