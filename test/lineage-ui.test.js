'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../media/main.js'), 'utf8');
// Exercise the canvas functions with graph fixtures, without a VS Code host.
function canvas(edges, upstreamDepth = null, downstreamDepth = null) {
  const ids = new Set(['root', 'unrelated', ...edges.flat()]);
  const element = () => ({ hidden: false, style: {}, classList: { toggle() {} } });
  const ctx = {
    view: { edges: edges.map(([from, to]) => ({ from, to })), nodes: [...ids].map((id, i) => ({ id, x: i * 3000, y: i * 900 })) },
    upstreamDepth, downstreamDepth, selected: 'root', hideUnrelated: true, overlayActive: false,
    query: '', activeId: null, visibleIds: null, rearrangeOnUpdate: true, layoutKey: null, layoutApplied: false,
    edgeLayer: { setAttribute() {} }, MAX_GLOW_EDGES: 400,
    window: { NodeVizLayout: require('../src/layout') }, updateEdges() {}, fit() {},
    pos: new Map([...ids].map((id, i) => [id, { x: i * 300, y: 0 }])),
    nodeEls: new Map([...ids].map(id => [id, element()])),
    edgeEls: edges.map(([from, to]) => ({ e: { from, to }, g: element() })),
    $: () => ({}), updateDeleteButton() {}, drawMinimap() {}, persist() {}, W: 220, H: 60,
  };
  vm.createContext(ctx);
  const start = source.indexOf('  function lineage(id)');
  const end = source.indexOf('  // ------------------------------------------------------------------ menus', start);
  vm.runInContext(source.slice(start, end), ctx);
  return ctx;
}
const sorted = set => [...set].sort();
test('independent upstream and downstream limits, including zero and unlimited', () => {
  const c = canvas([['a', 'b'], ['b', 'root'], ['root', 'c'], ['c', 'd']], 1, 2);
  assert.deepEqual(sorted(c.lineage('root').up), ['b']);
  assert.deepEqual(sorted(c.lineage('root').down), ['c', 'd']);
  c.upstreamDepth = 0;
  c.downstreamDepth = null;
  c.applyHighlight();
  assert.deepEqual(sorted(c.visibleIds), ['c', 'd', 'root']);
  assert.equal(c.nodeEls.get('unrelated').hidden, true);
  assert.equal(c.edgeEls[1].g.style.display, 'none');
  assert.equal(c.edgeEls[2].g.style.display, '');
});
test('shortest paths through diamonds and cycles respect the depth boundary', () => {
  const c = canvas([['root', 'a'], ['a', 'b'], ['root', 'b'], ['b', 'c'], ['c', 'root']], 0, 2);
  assert.deepEqual(sorted(c.lineage('root').down), ['a', 'b', 'c']);
  c.downstreamDepth = null;
  assert.deepEqual(sorted(c.lineage('root').down), ['a', 'b', 'c']);
});
test('clearing selection, disabling filter, and overlays restore all nodes and edges', () => {
  for (const change of [c => c.selected = null, c => c.hideUnrelated = false, c => c.overlayActive = true]) {
    const c = canvas([['a', 'root'], ['unrelated', 'other']], 0, 0);
    c.applyHighlight();
    assert.deepEqual(sorted(c.visibleIds), ['root']);
    change(c);
    c.applyHighlight();
    assert.equal(c.visibleIds, null);
    assert.ok([...c.nodeEls.values()].every(n => !n.hidden));
    assert.ok(c.edgeEls.every(e => e.g.style.display === ''));
  }
});
test('selection changes and removed selections cannot leave a blank canvas', () => {
  const c = canvas([['a', 'root'], ['unrelated', 'other']], 1, 0);
  c.applyHighlight();
  c.selected = 'other';
  c.applyHighlight();
  assert.deepEqual(sorted(c.visibleIds), ['other', 'unrelated']);
  c.pos.delete('other');
  c.applyHighlight();
  assert.equal(c.selected, null);
  assert.equal(c.visibleIds, null);
});

test('filtered layout ignores hidden nodes and their edges in both directions', () => {
  for (const direction of ['LR', 'TB']) {
    const c = canvas([['a', 'root'], ['root', 'b'], ['unrelated', 'a']], 1, 1);
    c.view.direction = direction;
    c.applyHighlight();
    const expected = require('../src/layout').layeredLayout(['root', 'a', 'b'],
      [{ from: 'a', to: 'root' }, { from: 'root', to: 'b' }], undefined, undefined, direction);
    for (const id of ['root', 'a', 'b']) assert.deepEqual(c.pos.get(id), expected[id]);
    assert.equal(c.nodeEls.get('unrelated').hidden, true);
    assert.equal(c.view.nodes.find(n => n.id === 'a').x, 6000);
    c.rearrangeOnUpdate = false;
    c.applyHighlight();
    for (const n of c.view.nodes) {
      assert.equal(c.pos.get(n.id).x, n.x);
      assert.equal(c.pos.get(n.id).y, n.y);
    }
  }
});
test('depth changes rearrange but search typing preserves positions', () => {
  const c = canvas([['a', 'root'], ['root', 'b']], 1, 1);
  c.applyHighlight();
  c.pos.set('root', { x: 123, y: 456 });
  c.query = 'root';
  c.applyHighlight();
  assert.equal(c.pos.get('root').x, 123);
  c.upstreamDepth = 0;
  c.applyHighlight();
  assert.equal(c.pos.get('root').x, 0);
});
