import type Parser from 'tree-sitter';
import type { ParsedFile } from 'gitnexus-shared';
import {
  canonicalModuleExportName,
  decodeIdentifierEscapes,
  decodeStringLiteral,
} from '../utils/ecmascript-literals.js';
import { plainString } from './data-route-table.js';
import type { FetchWrapperContext } from './fetch-wrapper.js';
import { staticMemberName } from './framework-route-facts.js';
import type {
  FrameworkExpression,
  FrameworkImportResolver,
  FrameworkRouteFacts,
} from './framework-route-types.js';
import {
  importBindingKey,
  type LexicalBindings,
  TRANSPARENT_EXPRESSION_TYPES,
  transparentInner,
} from './lexical-bindings.js';

/** Existing per-file binding index, or a literal module source, followed by its called members. */
type ClientCall = [bindingIndexOrModule: number | string, ...members: string[]];
type ClientFacts = FrameworkRouteFacts & { inertiaClientCalls?: ClientCall[] };

/** An actual use of the external factory that our call/forwarding facts cannot
 * follow (for example a callback argument) prevents certifying a unique app.
 * Only modules importing that value or its namespace pay for this check. */
export function hasOpaqueInertiaFactoryUse(
  file: ParsedFile,
  tree: Parser.Tree,
  bindings: LexicalBindings,
): boolean {
  const tracked = new Map<string, 'factory' | 'namespace'>();
  for (const imported of file.parsedImports) {
    if (!('localName' in imported) || !('importedName' in imported) || imported.typeOnly) continue;
    const source = imported.targetRaw.includes('\\')
      ? decodeStringLiteral(`"${imported.targetRaw}"`)
      : imported.targetRaw;
    if (source !== '@inertiajs/vue3') continue;
    if (imported.kind === 'namespace') tracked.set(importBindingKey(file, imported), 'namespace');
    else if (
      (imported.kind === 'named' || imported.kind === 'alias') &&
      imported.importedName === 'createInertiaApp'
    )
      tracked.set(importBindingKey(file, imported), 'factory');
  }
  if (!tracked.size) return false;
  for (const name of tree.rootNode.descendantsOfType([
    'identifier',
    'shorthand_property_identifier',
  ])) {
    if (name.closest('import_statement') || name.closest('export_specifier')) continue;
    if (
      name.parent?.type === 'variable_declarator' &&
      name.parent.childForFieldName('name')?.id === name.id
    )
      continue;
    let kind = tracked.get(bindings.bindingId(name, decodeIdentifierEscapes(name.text), true));
    if (!kind) continue;
    let value = name;
    while (value.parent && TRANSPARENT_EXPRESSION_TYPES.has(value.parent.type))
      value = value.parent;
    if (kind === 'namespace' && value.parent?.childForFieldName('object')?.id === value.id) {
      const member = staticMemberName(value.parent);
      if (member === null) return true;
      if (member !== 'createInertiaApp') continue;
      value = value.parent;
      kind = 'factory';
    }
    while (value.parent && TRANSPARENT_EXPRESSION_TYPES.has(value.parent.type))
      value = value.parent;
    const parent = value.parent;
    if (
      kind === 'factory' &&
      parent?.type === 'call_expression' &&
      parent.childForFieldName('function')?.id === value.id
    )
      continue;
    if (parent?.type === 'export_statement' && parent.childForFieldName('value')?.id === value.id)
      continue;
    if (
      parent?.type === 'type_query' ||
      (parent?.type === 'unary_expression' &&
        ['void', 'typeof'].includes(parent.childForFieldName('operator')?.type ?? ''))
    )
      continue;
    const alias =
      parent?.type === 'variable_declarator' && parent.childForFieldName('value')?.id === value.id
        ? parent.childForFieldName('name')
        : null;
    if (alias?.type === 'identifier') {
      const id = bindings.bindingId(alias, decodeIdentifierEscapes(alias.text));
      if (id) {
        tracked.set(id, kind);
        continue;
      }
    }
    return true;
  }
  return false;
}

/** Reuse the worker's existing AST call inventory and lexical binding identities.
 * Only retain calls whose root could be an import or one of its local aliases. */
export function captureInertiaClientCalls(
  facts: FrameworkRouteFacts,
  context: Pick<FetchWrapperContext, 'bindings' | 'callNodes'>,
  file: ParsedFile,
): ClientCall[] {
  if (!file.parsedImports.length) return [];
  const candidates = new Map<string, ClientCall>();
  for (const [index, { id, value }] of facts.bindings.entries())
    if (value.kind === 'import' || value.kind === 'binding' || value.kind === 'member')
      candidates.set(id, [index]);
  // Awaited literal imports already carry the namespace/destructured binding
  // at the import() range. A promise from a bare import() has no such binding.
  const dynamic = new Set(
    file.parsedImports
      .filter((i) => i.kind === 'dynamic-resolved')
      .map((i) => `${i.atRange.startLine}:${i.atRange.startCol}`),
  );
  if (dynamic.size)
    for (const imported of file.parsedImports) {
      if (
        !('importedName' in imported) ||
        !('localName' in imported) ||
        !dynamic.has(`${imported.atRange.startLine}:${imported.atRange.startCol}`)
      )
        continue;
      candidates.set(
        importBindingKey(file, imported),
        imported.kind === 'namespace'
          ? [imported.targetRaw]
          : [imported.targetRaw, imported.importedName],
      );
    }
  const calls: ClientCall[] = [];
  const counts = new Map<string, number>();
  // Two starts already disqualify one entry; repeated utility calls need no further rows.
  const record = (call: ClientCall) => {
    const key = JSON.stringify(call);
    const count = counts.get(key) ?? 0;
    if (count < 2) {
      counts.set(key, count + 1);
      calls.push(call);
    }
  };
  for (const call of context.callNodes) {
    let node: Parser.SyntaxNode | null = call.childForFieldName('function');
    const members: string[] = [];
    while (node && node.type !== 'identifier') {
      if (TRANSPARENT_EXPRESSION_TYPES.has(node.type)) {
        node = transparentInner(node);
        continue;
      }
      const load = node.type === 'await_expression' ? node.firstNamedChild : node;
      if (load?.type === 'call_expression') {
        const callee = load.childForFieldName('function');
        if (
          (node.type === 'await_expression' && callee?.type === 'import') ||
          (callee?.text === 'require' && context.bindings.isGlobal(callee, 'require'))
        ) {
          const args = load
            .childForFieldName('arguments')
            ?.namedChildren.filter((n) => n.type !== 'comment');
          const source = args?.length === 1 && plainString(args[0]);
          if (source && members.length) record([source, ...members.reverse()]);
        }
        break;
      }
      const member = staticMemberName(node);
      if (!member) break;
      members.push(member);
      node = node.childForFieldName('object');
    }
    if (node?.type !== 'identifier') continue;
    const id = context.bindings.bindingId(node, decodeIdentifierEscapes(node.text), true);
    const root = candidates.get(id);
    if (root) {
      const [binding, ...prefix] = root;
      record([binding, ...prefix, ...members.reverse()]);
    }
  }
  return calls;
}

function groupValues<T extends { value: FrameworkExpression }>(
  items: readonly T[],
  key: (item: T) => string,
) {
  const grouped = new Map<string, FrameworkExpression[]>();
  for (const item of items) {
    const name = key(item);
    const values = grouped.get(name);
    if (values) values.push(item.value);
    else grouped.set(name, [item.value]);
  }
  return grouped;
}

/** A barrel alone is harmless. Follow the imports of actual calls, honoring
 * explicit exports before stars and using the project's own module resolver.
 * If any branch can reach the factory the client is a possible competitor. */
export function hasCompetingInertiaClient(
  records: readonly { filePath: string; facts: unknown }[],
  acceptedEntries: ReadonlySet<string>,
  resolveImportTargets: FrameworkImportResolver,
): boolean {
  const files = new Map<string, ClientFacts>();
  for (const { filePath, facts } of records) {
    if (facts && typeof facts === 'object' && 'starExports' in facts)
      files.set(filePath, facts as ClientFacts);
  }
  const indexes = new Map<
    string,
    {
      bindings: Map<string, FrameworkExpression[]>;
      exports: Map<string, FrameworkExpression[]>;
    }
  >();
  const index = (file: ClientFacts) => {
    let result = indexes.get(file.filePath);
    if (!result) {
      result = {
        bindings: groupValues(file.bindings, (b) => b.id),
        exports: groupValues(file.exports, (e) => canonicalModuleExportName(e.name) ?? e.name),
      };
      indexes.set(file.filePath, result);
    }
    return result;
  };
  const targets = new Map<string, readonly string[]>();
  const isFactory = (caller: ClientFacts, [root, ...members]: ClientCall): boolean => {
    type Step = { file: ClientFacts; value: FrameworkExpression; members: string[] };
    const value: FrameworkExpression =
      typeof root === 'number'
        ? { kind: 'binding', id: caller.bindings[root].id }
        : { kind: 'import', source: root, name: '*' };
    const pending: Step[] = [{ file: caller, value, members }];
    const seen = new Set<string>();
    for (let step = pending.pop(); step; step = pending.pop()) {
      // Exhaustion with unresolved candidates cannot certify a unique client.
      const { file, value, members } = step;
      if (seen.size > 10_000 || members.length > 128) return true;
      if (value.kind === 'member') {
        pending.push({ file, value: value.object, members: [value.name, ...members] });
      } else if (value.kind === 'binding') {
        const key = JSON.stringify([file.filePath, 'binding', value.id, ...members]);
        if (seen.has(key)) continue;
        seen.add(key);
        for (const next of index(file).bindings.get(value.id) ?? [])
          pending.push({ file, value: next, members });
      } else if (value.kind === 'import') {
        const names =
          value.name === '*' || value.name === 'require'
            ? members
            : [canonicalModuleExportName(value.name) ?? value.name, ...members];
        if (!names.length) continue;
        const [name, ...rest] = names;
        const key = JSON.stringify([file.filePath, 'import', value.source, ...names]);
        if (seen.has(key)) continue;
        seen.add(key);
        const source = value.source.includes('\\')
          ? (decodeStringLiteral(`"${value.source}"`) ?? value.source)
          : value.source;
        const moduleKey = `${file.filePath}\0${source}`;
        let resolved = targets.get(moduleKey);
        if (!resolved) {
          resolved = resolveImportTargets(file.filePath, source);
          targets.set(moduleKey, resolved);
        }
        if (
          !resolved.length &&
          source === '@inertiajs/vue3' &&
          name === 'createInertiaApp' &&
          !rest.length
        )
          return true;
        for (const targetPath of resolved) {
          const target = files.get(targetPath);
          if (!target) continue;
          const direct = index(target).exports.get(name);
          if (direct) {
            for (const next of direct) pending.push({ file: target, value: next, members: rest });
          } else if (name !== 'default') {
            for (const source of target.starExports)
              pending.push({
                file: target,
                value: { kind: 'import', source, name },
                members: rest,
              });
          }
        }
      }
    }
    return false;
  };
  for (const file of files.values()) {
    let remaining = acceptedEntries.has(file.filePath) ? 1 : 0;
    const matches = new Map<string, boolean>();
    for (const call of file.inertiaClientCalls ?? []) {
      const key = JSON.stringify(call);
      if (!matches.has(key)) matches.set(key, isFactory(file, call));
      if (matches.get(key) && --remaining < 0) return true;
    }
    if (remaining > 0) return true;
  }
  return false;
}
