const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function page() {
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const script = html.match(/<script id="home-navigation">([\s\S]*?)<\/script>/);
  assert.ok(script, 'The real mobile navigation script must exist');
  const element = (extra = {}) => Object.assign({
    listeners: {}, attrs: {},
    addEventListener(type, callback) { this.listeners[type] = callback; },
    getAttribute(name) { return this.attrs[name] || null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    focus() { this.focused = true; }
  }, extra);
  const target = element(), summary = element();
  const link = element({ hash: '#services' });
  const menu = element({ open: true,
    querySelectorAll: () => [link], querySelector: () => summary });
  const select = element({ id: 'interiorService', value: 'scanColor', selectedIndex: 0,
    options: [{ text: 'Только сканирование, цвет' }, { text: '3D модель с видимыми инженерными сетями' }],
    attrs: { 'aria-describedby': 'existing-help' },
    insertAdjacentElement(position, hint) { this.hint = hint; }
  });
  vm.runInNewContext(script[1], { document: {
    getElementById: id => id === 'mobileMenu' ? menu : target,
    querySelectorAll: () => [select], createElement: () => element()
  }});
  return { menu, link, target, summary, select };
}

test('mobile menu closes and focuses the chosen section without cancelling navigation', () => {
  const { menu, link, target } = page();
  let prevented = false;
  link.listeners.click.call(link, { preventDefault() { prevented = true; } });
  assert.equal(menu.open, false);
  assert.equal(target.focused, true);
  assert.equal(prevented, false);
});

test('Escape returns focus to the menu control', () => {
  const { menu, summary } = page();
  menu.listeners.keydown({ key: 'Escape' });
  assert.equal(menu.open, false);
  assert.equal(summary.focused, true);
});

test('full selected text updates accessibly without changing the selected value', () => {
  const { select } = page();
  assert.equal(select.hint.textContent, 'Выбрано: Только сканирование, цвет');
  assert.equal(select.getAttribute('aria-describedby'), 'existing-help ' + select.hint.id);
  select.selectedIndex = 1;
  select.value = 'modelEng';
  select.listeners.change();
  assert.equal(select.hint.textContent, 'Выбрано: 3D модель с видимыми инженерными сетями');
  assert.equal(select.value, 'modelEng');
});
