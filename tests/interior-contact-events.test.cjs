const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function page(metrika = 'available') {
  const file = join(__dirname, '..', 'uslugi', 'obmery-pomeshcheniy', 'index.html');
  assert.ok(existsSync(file), 'The interior service page must exist');
  const html = readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(script => script.includes('function ymGoal'));
  assert.equal(scripts.length, 1, 'Run the real contact handler exactly once');
  const calls = [];
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(match => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)]
      .map(attr => [attr[1], attr[2]]));
    assert.equal(attrs.onclick, undefined, 'No duplicate inline contact handler');
    const listeners = [];
    return {
      href: attrs.href,
      dataset: attrs['data-goal'] ? { goal: attrs['data-goal'] } : {},
      addEventListener(type, listener) { if (type === 'click') listeners.push(listener); },
      click() {
        const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        listeners.forEach(listener => listener(event));
        assert.equal(event.defaultPrevented, false, 'Analytics must preserve navigation');
      }
    };
  });
  const counterId = html.match(/window\.METRIKA_ID="([^"]+)"/)[1];
  assert.equal(counterId, '110175409', 'Keep the existing site counter');
  const context = {
    METRIKA_ID: counterId,
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, '[data-goal]');
        return links.filter(link => link.dataset.goal);
      },
      getElementById: () => null
    },
    localStorage: { getItem: () => '1' },
    fetch() { throw new Error('External requests are disabled'); }
  };
  context.window = context;
  if (metrika !== 'missing') context.ym = (...args) => {
    if (metrika === 'throws') throw new Error('Unavailable counter');
    calls.push(args);
  };
  vm.runInNewContext(scripts[0], context);
  return { links, calls, counterId };
}

test('interior page: each contact click sends only its own goal', () => {
  const { links, calls, counterId } = page();
  const contacts = links.filter(link => /^(tel:|mailto:|https:\/\/(t\.me|(?:www\.)?max\.ru)\/)/.test(link.href));
  assert.deepEqual(new Set(contacts.map(link => link.dataset.goal)), new Set(['call', 'telegram', 'max', 'email']));
  for (const link of contacts) {
    const expectedGoal = link.href.startsWith('tel:') ? 'call'
      : link.href.startsWith('mailto:') ? 'email'
        : new URL(link.href).hostname === 't.me' ? 'telegram' : 'max';
    assert.equal(link.dataset.goal, expectedGoal, 'The goal must match the contact channel');
    calls.length = 0;
    link.click();
    assert.deepEqual(calls, [[counterId, 'reachGoal', expectedGoal]]);
    link.click();
    assert.deepEqual(calls, Array.from({ length: 2 }, () => [counterId, 'reachGoal', expectedGoal]),
      'A second click sends exactly one more matching event');
  }
});

test('interior page: reaching the form is navigation, not a lead', () => {
  const { links, calls } = page();
  assert.ok(links.some(link => link.href === '/#leadform'));
  for (const link of links.filter(link => link.href.startsWith('/') || link.href.startsWith('#'))) {
    link.click();
  }
  assert.deepEqual(calls, []);
});

for (const metrika of ['missing', 'throws']) {
  test(`interior page: ${metrika} analytics preserves contact navigation`, () => {
    const { links, calls } = page(metrika);
    links.filter(link => link.dataset.goal).forEach(link => link.click());
    assert.deepEqual(calls, []);
  });
}
