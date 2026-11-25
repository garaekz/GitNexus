import type { ParsedFile, ParsedImport } from 'gitnexus-shared';
import type Parser from 'tree-sitter';
import { decodeStringLiteral } from '../utils/ecmascript-literals.js';

type SyntaxNode = Parser.SyntaxNode;

export const inertiaEntryPaths = ['resources/js/app.js', 'resources/js/app.ts'];
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
function hasTemplateRequire(file: ParsedFile, tree: Parser.Tree): boolean {
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
    if (callee?.text !== 'require' || call?.type !== 'call_expression') return false;
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
): string | null | undefined {
  if (hasTemplateRequire(file, tree)) return null;
  if (!inertiaEntryPaths.includes(file.filePath))
    return file.parsedImports.some(importsInertiaFactory) ? null : undefined;
  if (file.parsedImports.filter(importsInertiaFactory).length !== 1) return null;
  return inertiaPagesDirectory(tree) ?? null;
}

const isOptionalCall = (call: SyntaxNode): boolean =>
  call.children.some((node) => node.type === 'optional_chain' || node.type === '?.');

/** The named value import must be the binding used by a single direct call. */
function importedCall(
  identifiers: SyntaxNode[],
  name: string,
  module: string,
): SyntaxNode | undefined {
  const references = identifiers.filter((node) => node.text === name);
  if (references.length !== 2) return;

  const declaration = references.find((node) => node.parent?.type === 'import_specifier');
  const specifier = declaration?.parent;
  const statement = specifier?.closest('import_statement');
  if (
    specifier?.text !== name ||
    statement?.parent?.type !== 'program' ||
    statement.children.some((node) => node.type === 'type') ||
    statement.childForFieldName('source')?.text.slice(1, -1) !== module
  )
    return;

  const use = references.find((node) => node.id !== declaration.id);
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
function resolveOption(options: SyntaxNode): SyntaxNode | undefined {
  let resolve: SyntaxNode | undefined;
  for (const property of options.namedChildren) {
    if (property.type === 'comment') continue;
    const key =
      property.type === 'shorthand_property_identifier'
        ? property
        : (property.childForFieldName('key') ?? property.childForFieldName('name'));
    if (key?.type !== 'property_identifier' && key?.type !== 'shorthand_property_identifier')
      return;
    if (key.text !== 'resolve') continue;
    if (resolve || property.type !== 'pair') return;
    resolve = property.childForFieldName('value');
  }
  return resolve;
}

/** Prove the same relative Vue directory in the interpolated name and Vite's literal glob. */
function inertiaPagesDirectory(tree: Parser.Tree): string | undefined {
  if (tree.rootNode.hasError) return;
  const identifiers = tree.rootNode.descendantsOfType([
    'identifier',
    'property_identifier',
    'shorthand_property_identifier',
    'shorthand_property_identifier_pattern',
  ]);
  if (identifiers.some((node) => node.text.includes('\\'))) return;
  const app = importedCall(identifiers, 'createInertiaApp', vueAdapter);
  if (app?.parent?.type !== 'expression_statement' || app.parent.parent?.type !== 'program') return;
  const options = argumentsOf(app);
  if (options.length !== 1 || options[0].type !== 'object') return;

  const arrow = resolveOption(options[0]);
  const helper = importedCall(
    identifiers,
    'resolvePageComponent',
    'laravel-vite-plugin/inertia-helpers',
  );
  if (
    !helper ||
    arrow?.type !== 'arrow_function' ||
    arrow.childForFieldName('body')?.id !== helper.id
  )
    return;
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
