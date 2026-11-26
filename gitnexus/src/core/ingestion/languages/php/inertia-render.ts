import type Parser from 'tree-sitter';
import { normalizeQualifiedName } from '../../utils/qualified-name.js';
import { splitNamespaceUseDeclaration } from './import-decomposer.js';

interface InertiaRender {
  controllerQualifiedName: string;
  methodName: string;
  /** Zero-based row, matching the Method nodes produced by ingestion. */
  callLine: number;
  page: string;
}

const typeDeclarations = new Set([
  'class_declaration',
  'interface_declaration',
  'trait_declaration',
  'enum_declaration',
]);

function literalPage(call: Parser.SyntaxNode): string | undefined {
  const scope = call.childForFieldName('scope');
  const name = call.childForFieldName('name');
  if (
    scope?.type !== 'name' ||
    scope.text !== 'Inertia' ||
    name?.type !== 'name' ||
    name.text !== 'render'
  ) {
    return;
  }
  const arg = call
    .childForFieldName('arguments')
    ?.namedChildren.find((child) => child.type === 'argument');
  const literal = arg?.firstNamedChild;
  // Named arguments, concatenation, interpolation and escapes require other evidence.
  if (
    arg?.namedChildCount !== 1 ||
    (literal?.type !== 'string' && literal?.type !== 'encapsed_string')
  ) {
    return;
  }
  return /^(["'])([\w-]+(?:\/[\w-]+)*)\1$/.exec(literal.text)?.[2];
}

function enclosingMethod(call: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  for (let node = call.parent; node; node = node.parent) {
    if (node.type === 'method_declaration') return node;
    if (
      node.type === 'anonymous_function' ||
      node.type === 'arrow_function' ||
      node.type === 'function_definition'
    ) {
      return;
    }
  }
}

/** Recognize the canonical facade import and statically named pages in top-level classes. */
export function extractInertiaRenders(tree: Parser.Tree): InertiaRender[] {
  if (tree.rootNode.hasError) return [];
  const statements = tree.rootNode.namedChildren;
  const namespaces = statements.filter((statement) => statement.type === 'namespace_definition');
  // Controller files conventionally have one unbracketed namespace or no namespace.
  if (namespaces.length > 1 || namespaces[0]?.childForFieldName('body')) return [];
  const namespaceStart = namespaces[0]?.endIndex ?? 0;
  const namespace = namespaces[0]?.childForFieldName('name')?.text;
  const renders: InertiaRender[] = [];
  let facadeImported = false;
  for (const statement of statements) {
    if (statement.startIndex < namespaceStart) continue;
    if (
      typeDeclarations.has(statement.type) &&
      statement.childForFieldName('name')?.text.toLowerCase() === 'inertia'
    ) {
      return [];
    }
    if (statement.type === 'namespace_use_declaration') {
      const bindsFacadeName = splitNamespaceUseDeclaration(statement).some(
        (binding) =>
          binding['@import.symbol-kind']?.text === 'type' &&
          binding['@import.name']?.text.toLowerCase() === 'inertia',
      );
      if (bindsFacadeName) {
        // A conflicting binding invalidates earlier candidates in this namespace, too.
        if (facadeImported || !/^use\s+Inertia\\Inertia\s*;$/.test(statement.text)) return [];
        facadeImported = true;
      }
    } else if (statement.type === 'class_declaration' && facadeImported) {
      const className = statement.childForFieldName('name')?.text;
      if (!className) continue;
      const controllerQualifiedName = namespace
        ? normalizeQualifiedName(`${namespace}\\${className}`)
        : className;
      for (const call of statement.descendantsOfType('scoped_call_expression')) {
        const page = literalPage(call);
        if (page === undefined) continue;
        const method = enclosingMethod(call);
        if (method?.parent?.parent?.id !== statement.id) continue;
        const methodName = method.childForFieldName('name')?.text;
        if (methodName) {
          renders.push({
            controllerQualifiedName,
            methodName,
            callLine: call.startPosition.row,
            page,
          });
        }
      }
    }
  }
  return renders;
}
