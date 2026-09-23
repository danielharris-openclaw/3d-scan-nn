const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1])
  .filter(script => script.includes('// ---- Calculator') || script.includes('function ymGoal'));
assert.equal(scripts.length, 2, 'Load the real calculator and quote-to-form scripts');

function calculator(mode = 'interior', values = {}) {
  // DOM fixture only: all pricing and form-transfer logic comes from index.html.
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, textContent: '', innerHTML: '', listeners: {},
      classList: { toggle() {} }, style: {},
      addEventListener(type, listener) { this.listeners[type] = listener; }
    });
    return elements.get(id);
  };
  const defaults = {
    area: 100, interiorService: 'scanColor', lod: 1, vat: 0, distance: 0, discount: 0,
    facadeArea: 1, facadeScan: 20, facadeDrawing: 0, facadeModel: 0,
    hectares: 1, topoMethod: 'slam', topoResult: 20000, topoLocation: 0,
    tankCount: 1, tankVolume: 30000, tankDocs: 0, tankType: 'Наземный',
    partCount: 1, accuracy: 1, reverseBase: 10000, cad: 0
  };
  for (const [id, value] of Object.entries({ ...defaults, ...values })) {
    if (typeof value === 'boolean') element(id).checked = value;
    else element(id).value = String(value);
  }
  const tabs = ['interior', 'facade', 'topo', 'tanks', 'reverse'].map(tab => {
    const node = element(`tab-${tab}`);
    node.dataset = { tab };
    return node;
  });
  element('calc').querySelectorAll = selector => selector === '.calc-tab' ? tabs
    : selector === 'input,select' ? [...elements.values()] : [];
  const context = {
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      querySelector: selector => selector === '#leadForm textarea[name="Комментарий"]'
        ? element('comment') : null
    },
    window: {}, navigator: {}, localStorage: { getItem: () => '1' },
    fetch() { throw new Error('External requests are disabled in this test'); }
  };
  vm.createContext(context);
  for (const script of scripts) vm.runInContext(script, context);
  element(`tab-${mode}`).listeners.click();
  return { quote: context.window.currentQuote, element };
}

test('all interior services retain their minimum on both sides of 100 m²', () => {
  const minimums = { scanColor: 20000, scanBw: 20000, plan: 20000, planEng: 20000,
    model: 20000, modelEng: 30000, archicad: 35000 };
  for (const [interiorService, minimum] of Object.entries(minimums)) {
    for (const area of [1, 99, 100, 101]) {
      assert.equal(calculator('interior', { area, interiorService }).quote.total,
        minimum, `${interiorService}, ${area} m²`);
    }
  }
});

test('interior price does not fall as area increases without a volume discount', () => {
  for (const interiorService of ['scanColor', 'scanBw', 'plan', 'planEng', 'model', 'modelEng', 'archicad']) {
    let previous = 0;
    for (const area of [1, 99, 100, 101, 150, 200, 250, 251, 350, 999, 1000, 1001]) {
      const total = calculator('interior', { area, interiorService }).quote.total;
      assert.ok(total >= previous, `${interiorService}, ${area} m²: ${total} < ${previous}`);
      previous = total;
    }
  }
});

test('shared order minimum applies to a valid low reverse-engineering estimate', () => {
  const result = calculator('reverse', { reverseBase: 10000 });
  assert.equal(result.quote.total, 20000);
  assert.match(result.element('calcPrice').textContent, /20\s000/);
  assert.match(result.element('calcLines').innerHTML, /Минимальный заказ/);
});

test('higher category minimums and normal rate-based estimates are preserved', () => {
  assert.equal(calculator('facade').quote.total, 50000);
  assert.equal(calculator('topo', { topoMethod: 'vls' }).quote.total, 300000);
  assert.equal(calculator('tanks').quote.total, 30000);
  assert.equal(calculator('interior', { area: 350 }).quote.total, 28000);
  assert.equal(calculator('reverse', { reverseBase: 30000, cad: 25000 }).quote.total, 55000);
});

test('existing volume-discount threshold and rates are preserved', () => {
  assert.equal(calculator('interior', { area: 1000, interiorService: 'scanBw', discount: 0.5 }).quote.total, 60000);
  for (const [discount, expected] of [[0, 60060], [0.1, 54054], [0.25, 45045], [0.5, 30030]]) {
    assert.equal(calculator('interior', { area: 1001, interiorService: 'scanBw', discount }).quote.total, expected);
  }
  assert.equal(calculator('tanks', { tankCount: 10 }).quote.total, 270000);
});

test('existing extras and multipliers are applied after the interior minimum', () => {
  const { quote } = calculator('interior', {
    area: 100, deviations: true, distance: 10, heritage: true, lod: 1.5, urgent: true, vat: 0.05
  });
  assert.ok(Math.abs(quote.total - 68890.5) < 0.000001);
});

test('the displayed minimum also reaches the hidden quote and visible form comment', () => {
  const { element } = calculator('reverse', { reverseBase: 10000 });
  element('sendQuoteBtn').listeners.click();
  assert.match(element('lfQuote').value, /Итого: 20\s000 ₽/);
  assert.match(element('comment').value, /Итого: 20\s000 ₽/);
  assert.match(element('lfQuote').value, /Минимальный заказ/);
});
