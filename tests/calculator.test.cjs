const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const text = value => value.replace(/<[^>]*>/g, '').trim();

function request() {
  const script = html.match(/<script id="quote-request">([\s\S]*?)<\/script>/);
  assert.ok(script, 'The request replaces automatic pricing');
  const elements = new Map();
  const element = (id, extra = {}) => {
    const node = Object.assign({ id, value: '', textContent: '', hidden: false, listeners: {},
      classList: { toggle() {} }, addEventListener(type, fn) { this.listeners[type] = fn; }
    }, extra);
    elements.set(id, node);
    return node;
  };
  const tabs = [...html.matchAll(/<button class="calc-tab[^>]*data-tab="([^"]+)"[^>]*>(.*?)<\/button>/g)]
    .map(([, name, label]) => element(name, { dataset: { tab: name }, textContent: label }));
  const panes = [...html.matchAll(/<div class="calc-pane[^>]*data-pane="([^"]+)">([\s\S]*?)(?=<div class="calc-pane|<!-- Request summary -->)/g)]
    .map(([, name, body]) => {
      const fields = [...body.matchAll(/<(select)\b([^>]*)>([\s\S]*?)<\/select>|<(input)\b([^>]*)>/g)]
        .map(([, select, selectAttrs, optionsHtml, input, inputAttrs]) => {
          const tag = select || input, attrs = selectAttrs || inputAttrs;
          const attrsMap = Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
          const id = attrsMap.id;
          const label = tag === 'input' && attrsMap.type === 'checkbox'
            ? body.match(new RegExp(`<label class="calc-check"><input id="${id}"[^>]*>(.*?)</label>`))[1]
            : body.match(new RegExp(`<label for="${id}">(.*?)</label>`))[1];
          const options = [...(optionsHtml || '').matchAll(/<option[^>]*>(.*?)<\/option>/g)].map(m => ({ text: text(m[1]) }));
          return element(id, { tagName: tag.toUpperCase(), type: attrsMap.type, value: attrsMap.value || '',
            checked: false, labels: [{ textContent: text(label) }], options, selectedIndex: 0,
            reportValidity() { return this.value === '' || (Number(this.value) >= Number(attrsMap.min || 0)); }
          });
        });
      return { dataset: { pane: name }, classList: { toggle() {} }, querySelectorAll: () => fields };
    });
  for (const id of ['requestSummary', 'lfQuote', 'lfQuotePreview', 'sendQuoteBtn']) element(id);
  element('calc', { querySelectorAll: selector => selector === '.calc-tab' ? tabs : selector === '.calc-pane' ? panes : panes.flatMap(p => p.querySelectorAll()) });
  const goals = [];
  const context = { document: { getElementById: id => elements.get(id) }, METRIKA_ID: '110175409', ym: (...args) => goals.push(args) };
  context.window = context;
  vm.runInNewContext(script[1], context);
  const click = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    elements.get('sendQuoteBtn').listeners.click(event);
    return event;
  };
  return { elements, tabs, goals, click };
}

test('public pages retain minimum orders without rates, price examples or automatic totals', () => {
  for (const path of ['index.html', 'uslugi/obmery-pomeshcheniy/index.html', 'uslugi/skanirovanie-fasadov/index.html']) {
    const page = readFileSync(join(__dirname, '..', path), 'utf8');
    assert.doesNotMatch(page, /₽\/(?:м²|га|шт)|id="calcPrice"|id="discount"|id="reverseBase"|function calcInterior|Рассчитать самостоятельно|Примеры базового расчёта/);
    assert.match(page, /(?:20|25) 000 ₽/);
  }
});

test('parameters transfer without price or an initial analytics event', () => {
  const { elements, goals, click } = request();
  assert.equal(goals.length, 0);
  elements.get('area').value = '350';
  elements.get('interiorService').selectedIndex = 3;
  elements.get('heritage').checked = true;
  assert.equal(click().prevented, false);
  const value = elements.get('lfQuote').value;
  assert.match(value, /Площадь, м²: 350/);
  assert.match(value, /видимые инженерные сети/);
  assert.match(value, /Культурное наследие: Да/);
  assert.doesNotMatch(value, /₽|Итого|Ставка|Скидка|НДС/);
  assert.equal(elements.get('lfQuotePreview').textContent, value);
  assert.equal(elements.get('lfQuotePreview').hidden, false);
  assert.deepEqual(goals, [['110175409', 'reachGoal', 'calc']]);
});

test('all five directions transfer only active parameters and retain the selected options', () => {
  const { elements, tabs, click } = request();
  for (const tab of tabs) {
    tab.listeners.click();
    click();
    assert.ok(elements.get('lfQuote').value.startsWith(tab.textContent));
    assert.doesNotMatch(elements.get('lfQuote').value, /₽|Итого|×/);
  }
  tabs.find(t => t.dataset.tab === 'tanks').listeners.click();
  elements.get('tankVolume').selectedIndex = 4;
  click();
  assert.match(elements.get('lfQuote').value, /10000 м³/);
  assert.doesNotMatch(elements.get('lfQuote').value, /Площадь|CAD/);
});

test('invalid numbers block transfer; unknown dimensions remain optional', () => {
  const { elements, goals, click } = request();
  elements.get('area').value = '-10';
  assert.equal(click().prevented, true);
  assert.equal(elements.get('lfQuote').value, '');
  assert.equal(goals.length, 0);
  elements.get('area').value = '';
  assert.equal(click().prevented, false);
  assert.match(elements.get('lfQuote').value, /Площадь, м²: Не указано/);
});

test('editing transferred parameters refreshes the form without another analytics event', () => {
  const { elements, tabs, goals, click } = request();
  click();
  elements.get('area').value = '500';
  elements.get('area').listeners.input();
  assert.match(elements.get('lfQuote').value, /Площадь, м²: 500/);
  tabs.find(t => t.dataset.tab === 'facade').listeners.click();
  assert.ok(elements.get('lfQuote').value.startsWith('Фасады'));
  assert.equal(goals.length, 1);
});

test('fractional dimensions are accepted while counts remain whole numbers', () => {
  for (const id of ['area', 'facadeArea', 'hectares', 'distance']) {
    assert.match(html.match(new RegExp(`<input id="${id}"[^>]*>`))[0], /step="any"/);
  }
  const { elements, tabs, click } = request();
  tabs.find(t => t.dataset.tab === 'topo').listeners.click();
  elements.get('hectares').value = '0.5';
  assert.equal(click().prevented, false);
  assert.match(elements.get('lfQuote').value, /Площадь, га: 0.5/);
});
