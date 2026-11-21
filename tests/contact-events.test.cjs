const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).filter(script => script.includes('function ymGoal'));
assert.equal(scripts.length, 1, 'Load the real contact-event script');
const counterId = html.match(/window\.METRIKA_ID="([^"]+)"/)[1];
const maxUrl = 'https://max.ru/u/f9LHodD0cOKQJvAxbQRGybXhznQk8_Y7LqODhTtC9LwLBpcAMsGiYcZlj8o';

function page(metrika = 'available') {
  const calls = [];
  const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(match => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)]
      .map(attr => [attr[1], attr[2]]));
    assert.equal(attrs.onclick, undefined, 'No second inline click handler');
    const listeners = [];
    return {
      href: attrs.href, text: match[2].replace(/<[^>]+>/g, '').trim(),
      dataset: attrs['data-goal'] ? { goal: attrs['data-goal'] } : {},
      position: match.index,
      addEventListener(type, listener) { if (type === 'click') listeners.push(listener); },
      click(defaultPrevented = false) {
        const event = { defaultPrevented, preventDefault() { this.defaultPrevented = true; } };
        for (const listener of listeners) listener(event);
        assert.equal(event.defaultPrevented, defaultPrevented, 'Analytics must not change navigation');
      }
    };
  });
  // Only DOM and external analytics are replaced; handlers run directly from index.html.
  const context = {
    document: {
      querySelectorAll(selector) {
        if (selector === 'a[href="#leadform"], a[href="/#leadform"]') {
          return links.filter(link => link.href === '#leadform' || link.href === '/#leadform');
        }
        assert.equal(selector, '[data-goal]');
        return links.filter(link => link.dataset.goal);
      },
      getElementById: () => null
    },
    METRIKA_ID: counterId,
    localStorage: { getItem: () => '1' },
    fetch() { throw new Error('External requests are disabled in this test'); }
  };
  context.window = context;
  if (metrika !== 'missing') context.ym = (...args) => {
    if (metrika === 'throws') throw new Error('Simulated unavailable counter');
    if (args[1] === 'reachGoal') calls.push(args);
  };
  vm.runInNewContext(scripts[0], context);
  return { links, calls };
}

const areas = [
  ['header', '<!-- nav -->', '<!-- hero body -->', ['call']],
  ['hero', '<!-- hero body -->', '<!-- hero visual:', ['telegram', 'max', 'call']],
  ['contacts', '<section id="leadform"', '<form id="leadForm"', ['telegram', 'max', 'call']],
  ['form', '<form id="leadForm"', '</form>', ['max', 'telegram', 'email']],
  ['footer', '<footer', '</footer>', ['call', 'email']]
];

for (const [area, start, end, goals] of areas) {
  test(`${area}: every contact click sends exactly one matching goal`, () => {
    const { links, calls } = page();
    const startIndex = html.indexOf(start), endIndex = html.indexOf(end, startIndex);
    assert.ok(startIndex >= 0 && endIndex > startIndex, `Find ${area} in the real page`);
    const contacts = links.filter(link => link.position > startIndex && link.position < endIndex
      && (/^tel:|^mailto:|^https:\/\/t\.me\//.test(link.href) || /[МM][АA][ХX]/i.test(link.text)));
    assert.equal(contacts.length, goals.length);
    for (const [index, link] of contacts.entries()) {
      calls.length = 0;
      link.click();
      assert.deepEqual(calls, [[counterId, 'reachGoal', goals[index]]], link.text);
      link.click();
      assert.deepEqual(calls, Array.from({ length: 2 }, () => [counterId, 'reachGoal', goals[index]]),
        'Each subsequent click also sends exactly one event');
    }
  });
}

test('all MAX links use the owner-provided profile URL instead of a phone link', () => {
  const { links } = page();
  const maxLinks = links.filter(link => /[МM][АA][ХX]/i.test(link.text));
  assert.equal(maxLinks.length, 3);
  for (const link of maxLinks) {
    assert.equal(link.href, maxUrl);
    assert.equal(link.dataset.goal, 'max');
  }
});

test('every form link reports one transition, while other navigation reports none', () => {
  const { links, calls } = page();
  assert.ok(links.filter(link => link.href === '#leadform').length > 2);
  for (const link of links.filter(link => link.href.startsWith('#') || link.href === 'privacy.html')) {
    calls.length = 0;
    link.click();
    assert.deepEqual(calls, link.href === '#leadform' ? [[counterId, 'reachGoal', 'form_open']] : [], link.text);
  }
});

test('invalid request parameters can prevent the form transition without recording it', () => {
  const { links, calls } = page();
  const request = links.find(link => link.text === 'Перейти к заявке на расчёт');
  assert.ok(request);
  request.click(true);
  assert.deepEqual(calls, []);
});

test('missing or failing analytics does not prevent contact navigation', () => {
  for (const state of ['missing', 'throws']) {
    const { links, calls } = page(state);
    for (const link of links.filter(link => link.dataset.goal || link.href === '#leadform')) assert.doesNotThrow(() => link.click());
    assert.deepEqual(calls, []);
  }
});
