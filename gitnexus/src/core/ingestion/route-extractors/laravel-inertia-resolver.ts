import type { ParsedFile, ParsedImport } from 'gitnexus-shared';
import type Parser from 'tree-sitter';
import { hasOpaqueInertiaFactoryUse } from './laravel-inertia-clients.js';
import { decodeIdentifierEscapes, decodeStringLiteral } from '../utils/ecmascript-literals.js';
import {
  importBindingKey,
  TRANSPARENT_EXPRESSION_TYPES,
  transparentInner,
  type LexicalBindings,
} from './lexical-bindings.js';

type SyntaxNode = Parser.SyntaxNode;

export const inertiaEntryPaths = ['resources/js/app.js', 'resources/js/app.ts'];
export const inertiaServerEntryPaths = ['resources/js/ssr.js', 'resources/js/ssr.ts'];
export type InertiaBootstrap =
  | { kind: 'client' | 'server'; directory: string }
  | { kind: 'vite-client' };
const vueAdapter = '@inertiajs/vue3';

function importsInertiaFactory(binding: ParsedImport): boolean {
  const raw = binding.targetRaw;
  if (binding.kind === 'dynamic-unresolved') {
    return raw?.startsWith('`') === true && decodeStringLiteral(raw) === vueAdapter;
  }
  if (
    raw !== vueAdapter &&
    (!raw?.includes('\\') || decodeStringLiteral(`"${raw}"`) !== vueAdapter)
  )
    return false;
  // A literal import()/require() can call the factory through the module object.
  // An unbound require() is recorded as a side-effect import.
  if (binding.kind === 'dynamic-resolved' || binding.kind === 'side-effect') return true;
  return (
    (binding.kind === 'namespace' ||
      ((binding.kind === 'named' || binding.kind === 'alias') &&
        binding.importedName === 'createInertiaApp')) &&
    !binding.typeOnly
  );
}

// A template-literal require has a call site but no ParsedImport. Inspect only
// the captured calls, at their known positions, without traversing every JS tree.
function hasTemplateRequire(
  file: ParsedFile,
  tree: Parser.Tree,
  bindings: LexicalBindings,
): boolean {
  return file.referenceSites.some((site) => {
    if (
      site.name !== 'require' ||
      site.kind !== 'call' ||
      site.callForm !== 'free' ||
      site.arity !== 1
    )
      return false;
    const range = site.nameRange ?? site.atRange;
    const callee = tree.rootNode.namedDescendantForPosition({
      row: range.startLine - 1,
      column: range.startCol,
    });
    const call = callee?.parent;
    if (
      callee?.text !== 'require' ||
      call?.type !== 'call_expression' ||
      !bindings.isGlobal(callee, 'require')
    )
      return false;
    const argument = argumentsOf(call)[0];
    return (
      argument?.type === 'template_string' && decodeStringLiteral(argument.text) === vueAdapter
    );
  });
}

/** null marks a possible bootstrap without a proven page directory. */
export function captureInertiaBootstrap(
  file: ParsedFile,
  tree: Parser.Tree,
  bindings: LexicalBindings,
): InertiaBootstrap | null | undefined {
  if (hasTemplateRequire(file, tree, bindings) || hasOpaqueInertiaFactoryUse(file, tree, bindings))
    return null;
  const server = inertiaServerEntryPaths.includes(file.filePath);
  if (!server && !inertiaEntryPaths.includes(file.filePath)) {
    // Static ESM imports can be re-exported or unused. Project-wide resolution
    // checks their call sites. Retain a blocker for opaque, literal module loads.
    const opaque = file.parsedImports.some((binding) => {
      if (!importsInertiaFactory(binding)) return false;
      const range = binding.atRange;
      if (!range) return true;
      const node = tree.rootNode.namedDescendantForPosition({
        row: range.startLine - 1,
        column: range.startCol,
      });
      return node.type !== 'import_statement' && !node.closest('import_statement');
    });
    return opaque ? null : undefined;
  }
  if (tree.rootNode.hasError) return null;
  if (file.parsedImports.filter(importsInertiaFactory).length !== 1) return null;
  const identifiers = tree.rootNode.descendantsOfType([
    'identifier',
    'shorthand_property_identifier',
    'shorthand_property_identifier_pattern',
  ]);
  const findCall = (name: string, module: string, importedName = name, nodes = identifiers) =>
    importedCall(file, tree, bindings, nodes, name, module, importedName);
  const app = findCall('createInertiaApp', vueAdapter);
  if (!app) return null;
  const options = argumentsOf(app);
  if (options.length !== 1 || options[0].type !== 'object') return null;
  const resolver = resolveOption(options[0]);
  if (resolver === undefined) return null;

  if (server) {
    const start = findCall('createServer', '@inertiajs/vue3/server', 'default');
    if (!start || !isTopLevelExpression(start)) return null;
    const args = argumentsOf(start);
    const callback = args[0];
    if (
      args.length !== 1 ||
      callback.type !== 'arrow_function' ||
      callback.childForFieldName('body')?.id !== app.id
    )
      return null;
    const page = options[0].namedChildren.find(
      (property) => property.type === 'shorthand_property_identifier' && property.text === 'page',
    );
    const params =
      callback.childForFieldName('parameter') ?? callback.childForFieldName('parameters');
    if (!page || !/^(?:page|\(\s*page\s*\))$/.test(params?.text ?? '')) return null;
  } else if (!isTopLevelExpression(app)) {
    const prefix = app.parent;
    if (
      prefix?.type !== 'unary_expression' ||
      prefix.childForFieldName('operator')?.type !== 'void' ||
      !isTopLevelExpression(prefix) ||
      resolver !== null
    )
      return null;
    return isUniqueViteTarget(tree.rootNode, app) ? { kind: 'vite-client' } : null;
  }

  if (resolver?.type !== 'arrow_function') return null;
  const body = resolver.childForFieldName('body');
  const callee = body?.childForFieldName('function');
  if (
    !callee ||
    !findCall(
      'resolvePageComponent',
      'laravel-vite-plugin/inertia-helpers',
      'resolvePageComponent',
      [callee],
    )
  )
    return null;
  const directory = inertiaPagesDirectory(resolver, body);
  return directory ? { kind: server ? 'server' : 'client', directory } : null;
}

const isTopLevelExpression = (node: SyntaxNode): boolean =>
  node.parent?.type === 'expression_statement' && node.parent.parent?.type === 'program';

// @inertiajs/vite picks an adapter from static imports and searches calls by
// identifier spelling, including shadowed names that are unrelated at runtime.
function isUniqueViteTarget(root: SyntaxNode, app: SyntaxNode): boolean {
  for (const statement of root.namedChildren) {
    if (statement.type !== 'import_statement') continue;
    const adapter = decodeStringLiteral(statement.childForFieldName('source')?.text ?? '');
    if (adapter === '@inertiajs/react' || adapter === '@inertiajs/svelte') return false;
  }
  return !root.descendantsOfType('call_expression').some((call) => {
    if (call.id === app.id) return false;
    let callee = call.childForFieldName('function');
    while (callee && TRANSPARENT_EXPRESSION_TYPES.has(callee.type))
      callee = transparentInner(callee);
    return (
      callee?.type === 'identifier' && decodeIdentifierEscapes(callee.text) === 'createInertiaApp'
    );
  });
}

const isOptionalCall = (call: SyntaxNode): boolean =>
  call.children.some((node) => node.type === 'optional_chain' || node.type === '?.');

/** The named value import must be the binding used by a single direct call. */
function importedCall(
  file: ParsedFile,
  tree: Parser.Tree,
  bindings: LexicalBindings,
  identifiers: SyntaxNode[],
  name: string,
  module: string,
  importedName: string,
): SyntaxNode | undefined {
  const declarations = file.parsedImports.filter(
    (binding) =>
      'localName' in binding &&
      binding.localName === name &&
      (binding.declaredAtScope ?? file.moduleScope) === file.moduleScope,
  );
  const declaration = declarations[0];
  if (
    declarations.length !== 1 ||
    (declaration.kind !== 'named' && declaration.kind !== 'alias') ||
    declaration.targetRaw !== module ||
    declaration.importedName !== importedName ||
    declaration.typeOnly
  )
    return;
  const range = declaration.atRange;
  const statement =
    range &&
    tree.rootNode.namedDescendantForPosition({ row: range.startLine - 1, column: range.startCol });
  if (statement?.type !== 'import_statement' || statement.parent?.type !== 'program') return;
  const key = importBindingKey(file, declaration);
  if (bindings.ambiguous(key)) return;
  const references = identifiers.filter(
    (node) =>
      decodeIdentifierEscapes(node.text) === name &&
      !node.closest('import_statement') &&
      bindings.bindingId(node, name, true) === key,
  );
  if (references.length !== 1) return;
  const use = references[0];
  if (use.type !== 'identifier' || use.text !== name) return;
  const claim = bindings.ownership(use, name, true)?.claims;
  if (claim?.length !== 1 || claim[0].kind !== 'import') return;
  const call = use.parent;
  if (
    call?.type === 'call_expression' &&
    call.childForFieldName('function')?.id === use.id &&
    !isOptionalCall(call)
  )
    return call;
}

function argumentsOf(call: SyntaxNode): SyntaxNode[] {
  return (
    call.childForFieldName('arguments')?.namedChildren.filter((arg) => arg.type !== 'comment') ?? []
  );
}

/** Spreads, computed keys and duplicate resolve properties can override the resolver. */
function resolveOption(options: SyntaxNode): SyntaxNode | null | undefined {
  let resolve: SyntaxNode | null = null;
  const keys = new Set<string>();
  for (const property of options.namedChildren) {
    if (property.type === 'comment') continue;
    const key =
      property.type === 'shorthand_property_identifier'
        ? property
        : (property.childForFieldName('key') ?? property.childForFieldName('name'));
    if (key?.type !== 'property_identifier' && key?.type !== 'shorthand_property_identifier')
      return;
    if (
      key.text.includes('\\') ||
      key.text === '__proto__' ||
      key.text === 'pages' ||
      keys.has(key.text)
    )
      return;
    keys.add(key.text);
    if (key.text !== 'resolve') continue;
    if (resolve || property.type !== 'pair') return;
    resolve = property.childForFieldName('value');
  }
  return resolve;
}

/** Prove the same relative Vue directory in the interpolated name and Vite's literal glob. */
function inertiaPagesDirectory(arrow: SyntaxNode, helper: SyntaxNode): string | undefined {
  const args = argumentsOf(helper);
  if (args.length !== 2 || args[0].type !== 'template_string' || args[1].type !== 'call_expression')
    return;

  const template = /^`\.\/((?:[\w-]+\/)+)\$\{([A-Za-z_$][\w$]*)\}\.vue`$/.exec(args[0].text);
  if (!template) return;
  const parameter =
    arrow.childForFieldName('parameter')?.text ??
    /^\(\s*([A-Za-z_$][\w$]*)(?:\s*:\s*string)?\s*\)$/.exec(
      arrow.childForFieldName('parameters')?.text ?? '',
    )?.[1];
  if (parameter !== template[2]) return;

  const glob = args[1];
  if (glob.childForFieldName('function')?.text !== 'import.meta.glob' || isOptionalCall(glob))
    return;
  const patterns = argumentsOf(glob);
  if (
    patterns.length !== 1 ||
    patterns[0].type !== 'string' ||
    patterns[0].text.slice(1, -1) !== `./${template[1]}**/*.vue`
  )
    return;
  return `resources/js/${template[1].slice(0, -1)}`;
}
