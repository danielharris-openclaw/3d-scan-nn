const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const formHtml = html.match(/<form id="leadForm"[\s\S]*?<\/form>/)[0];
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(source => source.includes('function ymGoal'));

function form(values = {}) {
  const requests = [], goals = [], elements = {};
  const element = (value = '') => ({
    value, checked: false, textContent: '', className: '', disabled: false,
    classList: { toggle() {}, add() {} }, listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; }
  });
  const f = element();
  f.action = formHtml.match(/action="([^"]+)"/)[1];
  // Build the submitted fields from the real form, without storing personal data.
  f.elements = Object.fromEntries([...formHtml.matchAll(/<(?:input|select|textarea)\b[^>]*name="([^"]+)"/g)]
    .map(match => [match[1], element()]));
  Object.assign(f.elements['Имя'], { value: 'Локальная проверка' });
  Object.assign(f.elements['Телефон'], { value: '+7 (000) 000-00-00' });
  for (const [name, value] of Object.entries(values)) f.elements[name].value = value;
  f._gotcha = f.elements._gotcha;
  f.resets = 0;
  f.reset = () => { f.resets++; for (const field of Object.values(f.elements)) field.value = ''; };
  const button = element();
  f.querySelector = selector => selector === '.lf-submit' ? button : null;
  elements.leadForm = f;
  elements.lfPhone = f.elements['Телефон'];
  elements.lfConsent = Object.assign(element(), { checked: true });
  elements.lfMsg = element();
  const context = {
    document: { getElementById: id => elements[id] || null, querySelectorAll: () => [] },
    localStorage: { getItem: () => '1' }, METRIKA_ID: '110175409',
    ym: (...args) => goals.push(args),
    FormData: class {
      constructor(node) { this.fields = Object.fromEntries(Object.entries(node.elements).map(([key, field]) => [key, field.value])); }
    },
    // This local promise is the only submission destination; no network API is exposed.
    fetch(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })); }
  };
  context.window = context;
  vm.runInNewContext(script, context);
  const submit = () => f.listeners.submit({ preventDefault() {} });
  const click = () => { if (!button.disabled) submit(); };
  return { f, elements, button, requests, goals, submit, click };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('the form offers text fields and material links without a file-upload control', () => {
  assert.doesNotMatch(formHtml, /type="file"|name="Файлы"|enctype="multipart\/form-data"/);
  assert.match(formHtml, /Фото и планы/);
  for (const goal of ['max', 'telegram', 'email']) assert.match(formHtml, new RegExp(`data-goal="${goal}"`));
});

test('a successful text-only submission sends one request and one lead goal', async () => {
  const fixture = form({ 'Комментарий': 'Тестовый текст', 'Расчёт калькулятора': 'Тестовый расчёт' });
  fixture.click();
  fixture.click();
  assert.equal(fixture.requests.length, 1, 'The disabled submit button prevents a second click');
  assert.equal(fixture.button.disabled, true);
  assert.equal(fixture.goals.length, 0, 'No lead event before a successful response');
  const request = fixture.requests[0];
  assert.equal(request.url, 'https://formspree.io/f/mlgybbgv');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Accept, 'application/json');
  assert.equal(request.options.body.fields['Файлы'], undefined);
  assert.equal(request.options.body.fields['Комментарий'], 'Тестовый текст');
  assert.equal(request.options.body.fields['Расчёт калькулятора'], 'Тестовый расчёт');
  request.resolve({ ok: true });
  await flush();
  assert.equal(fixture.f.resets, 1);
  assert.match(fixture.elements.lfMsg.textContent, /Заявка отправлена/);
  assert.equal(fixture.button.disabled, false);
  assert.deepEqual(fixture.goals, [['110175409', 'reachGoal', 'lead']]);
});

for (const failure of ['http', 'network']) {
  test(`${failure} failure preserves the form, sends no lead goal and allows retry`, async () => {
    const fixture = form({ 'Комментарий': 'Сохранить при ошибке' });
    fixture.click();
    if (failure === 'http') fixture.requests[0].resolve({ ok: false });
    else fixture.requests[0].reject(new Error('Simulated network failure'));
    await flush();
    assert.equal(fixture.elements.lfMsg.className, 'lf-msg err');
    assert.equal(fixture.f.elements['Комментарий'].value, 'Сохранить при ошибке');
    assert.equal(fixture.f.resets, 0);
    assert.equal(fixture.button.disabled, false);
    assert.deepEqual(fixture.goals, []);
    fixture.click();
    assert.equal(fixture.requests.length, 2);
    fixture.requests[1].resolve({ ok: true });
    await flush();
    assert.equal(fixture.goals.length, 1);
  });
}

test('missing name, short phone, missing consent and honeypot prevent submission', () => {
  for (const values of [{ 'Имя': '' }, { 'Телефон': '+7' }, { _gotcha: 'bot' }]) {
    const fixture = form(values);
    fixture.submit();
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual(fixture.goals, []);
  }
  const fixture = form();
  fixture.elements.lfConsent.checked = false;
  fixture.submit();
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(fixture.goals, []);
});
