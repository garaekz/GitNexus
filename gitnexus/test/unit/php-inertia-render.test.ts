import Parser from 'tree-sitter';
import PHP from 'tree-sitter-php';
import { describe, expect, it } from 'vitest';
import { extractInertiaRenders } from '../../src/core/ingestion/languages/php/inertia-render.js';

const parser = new Parser();
parser.setLanguage(PHP.php_only);
const extract = (source: string) => {
  const tree = parser.parse(source);
  expect(tree.rootNode.hasError).toBe(false);
  return extractInertiaRenders(tree);
};
const controller = (imports: string, body: string) => String.raw`<?php
namespace App\Http\Controllers;
${imports}
class OrderController {
    public function show($page) {
        ${body}
    }
}`;

describe('Laravel Inertia render calls', () => {
  it('records the containing method and zero-based call site for literal page arguments', () => {
    const source = controller(
      String.raw`use Inertia\Inertia;`,
      `if ($page) {
            return Inertia::render("Orders/New", []);
        }
        return Inertia::render('Orders/Show', ['order' => $page]);`,
    );
    expect(extract(source)).toEqual([
      { methodName: 'show', callLine: 6, page: 'Orders/New' },
      { methodName: 'show', callLine: 8, page: 'Orders/Show' },
    ]);
  });

  it.each([
    '',
    String.raw`use Local\Inertia;`,
    String.raw`use Local\Renderer as Inertia;`,
    String.raw`use function Inertia\Inertia;`,
    String.raw`use /* class name is a function import */ function Inertia\Inertia;`,
    String.raw`use Inertia\Inertia as Renderer;`,
    String.raw`use Inertia\Inertia; use Acme\Page as Inertia;`,
  ])('requires an unambiguous canonical facade import (%s)', (imports) => {
    expect(extract(controller(imports, "return Inertia::render('Orders/Show');"))).toEqual([]);
  });

  it('rejects text, nested callables, receiver lookalikes and nonliteral first arguments', () => {
    expect(
      extract(
        controller(
          String.raw`use Inertia\Inertia;`,
          String.raw`
        // Inertia::render('Orders/Comment')
        $text = "Inertia::render('Orders/Text')";
        $later = fn () => Inertia::render('Orders/Arrow');
        $closure = function () { return Inertia::render('Orders/Closure'); };
        function nested() { return Inertia::render('Orders/Function'); }
        $obj = new class { function show() { return Inertia::render('Orders/Anonymous'); } };
        $renderer->render('Orders/Instance');
        Other::render('Orders/Other');
        Inertia::$method('Orders/VariableMethod');
        Inertia::render($page, 'Orders/Second');
        $callable = Inertia::render(...);
        Inertia::render(...['Orders/Unpacked']);
        Inertia::render('Orders/' . $page);
        Inertia::render("Orders/$page");
        Inertia::render('../outside');
        Inertia::render(props: 'Orders/Named');
    `,
        ),
      ),
    ).toEqual([]);
  });

  it('resets facade import evidence at namespace boundaries', () => {
    const source = String.raw`<?php
namespace One;
use Inertia\Inertia;
namespace Two;
class Controller { function show() { return Inertia::render('Private/Show'); } }`;
    expect(extract(source)).toEqual([]);
  });

  it.each([
    String.raw`use Other\Component as Inertia;`,
    String.raw`use Inertia\Inertia;`,
    'class inertia {}',
    'interface Inertia {}',
    'trait Inertia {}',
    'enum Inertia {}',
  ])('rejects a conflicting type binding declared after the handler (%s)', (later) => {
    const source = controller(
      String.raw`use Inertia\Inertia;`,
      "return Inertia::render('Orders/Show');",
    );
    expect(extract(`${source}\n${later}`)).toEqual([]);
  });

  it('requires the import to precede the handler declaration', () => {
    const source = controller('', "return Inertia::render('Orders/Show');");
    expect(extract(source + String.raw` use Inertia\Inertia;`)).toEqual([]);
  });
});
