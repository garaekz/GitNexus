import type { ParsedFile } from 'gitnexus-shared';
import type Parser from 'tree-sitter';
import { generateId } from '../../../lib/utils.js';
import { INERTIA_PAGE_REASON } from '../../graph/edge-reasons.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import type { SemanticModel } from '../model/semantic-model.js';
import { extractInertiaRenders } from '../languages/php/inertia-render.js';
import { inertiaEntryPaths } from './laravel-inertia-resolver.js';

type ControllerFacts = { inertiaRenders: ReturnType<typeof extractInertiaRenders> };

export function extractInertiaControllerFacts(
  tree: Parser.Tree,
  file: ParsedFile,
): ControllerFacts | undefined {
  if (!file.filePath.startsWith('app/Http/Controllers/') || !file.filePath.endsWith('.php')) return;
  const inertiaRenders = extractInertiaRenders(tree);
  return inertiaRenders.length ? { inertiaRenders } : undefined;
}

/** Join the worker's literal call, the admitted handler, and the bootstrap's
 * resolver to an indexed File. All paths are scanner-relative and case-sensitive. */
export function linkInertiaPages(
  graph: KnowledgeGraph,
  model: SemanticModel,
  paths: ReadonlySet<string>,
  files: readonly { filePath: string; facts: unknown }[],
  routeHandlers: ReadonlyMap<string, string>,
): void {
  if (routeHandlers.size === 0) return;
  const entries = inertiaEntryPaths.filter((entry) => paths.has(entry));
  if (entries.length !== 1) return;
  let directory: string | undefined;
  for (const { filePath, facts } of files) {
    if (!facts || typeof facts !== 'object' || !('inertiaPagesDirectory' in facts)) continue;
    if (filePath !== entries[0] || typeof facts.inertiaPagesDirectory !== 'string') return;
    directory = facts.inertiaPagesDirectory;
  }
  if (directory === undefined) return;

  const handlers = new Set(routeHandlers.values());
  for (const { filePath, facts } of files) {
    if (!facts || typeof facts !== 'object' || !('inertiaRenders' in facts)) continue;
    const { inertiaRenders } = facts as ControllerFacts;
    for (const { methodName, callLine, page } of inertiaRenders) {
      const pageId = generateId('File', `${directory}/${page}.vue`);
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
      if (!owner || !handlers.has(owner.id)) continue;
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
