const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const formHtml = html.match(/<form id="leadForm"[\s\S]*?<\/form>/)[0];
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(source => source.includes('function ymGoal'));

function form(values = {}, clientId, captcha) {
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
  Object.assign(f.elements['name'], { value: 'Локальная проверка' });
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
  elements.lfQuote = f.elements['Параметры для расчёта'];
  elements.lfQuotePreview = Object.assign(element(), { hidden: false });
  if (captcha) elements.lfCaptcha = { dataset: { sitekey: 'local-widget' }, hidden: true };
  const context = {
    document: { getElementById: id => elements[id] || null, querySelectorAll: () => [] },
    localStorage: { getItem: () => '1' }, METRIKA_ID: '110175409',
    ym: (...args) => {
      if (args[1] !== 'getClientID') return goals.push(args);
      if (clientId instanceof Error) throw clientId;
      if (clientId !== undefined) args[2](clientId);
    },
    FormData: class {
      constructor(node) { this.fields = Object.fromEntries(Object.entries(node.elements).map(([key, field]) => [key, field.value])); }
      set(name, value) { this.fields[name] = value; }
    },
    // This local promise is the only submission destination; no network API is exposed.
    fetch(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })); }
  };
  if (captcha) {
    context.document.createElement = () => ({ remove() {} });
    context.document.head = { appendChild() { context.onLeadCaptchaReady(); } };
    context.grecaptcha = {
      render(node, options) { captcha.options = options; return 0; },
      getResponse() { return captcha.token; },
      reset() { captcha.token = ''; captcha.resets++; }
    };
  }
  context.window = context;
  vm.runInNewContext(script, context);
  const submit = () => f.listeners.submit({ preventDefault() {} });
  const click = () => { if (!button.disabled) submit(); };
  return { f, elements, button, requests, goals, submit, click };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const accepted = () => ({ ok: true, json: async () => ({ ok: true, next: '/thanks' }) });

test('the form offers text fields and material links without a file-upload control', () => {
  assert.doesNotMatch(formHtml, /type="file"|name="Файлы"|enctype="multipart\/form-data"/);
  assert.match(formHtml, /Фото и планы/);
  for (const goal of ['max', 'telegram', 'email']) assert.match(formHtml, new RegExp(`data-goal="${goal}"`));
});

test('a successful text-only submission sends one request and one lead goal', async () => {
  const fixture = form({ 'Комментарий': 'Тестовый текст', 'Параметры для расчёта': 'Помещения\nПлощадь, м²: 350' });
  // Native hidden inputs retain a programmatically assigned value on form.reset().
  const reset = fixture.f.reset;
  fixture.f.reset = () => { const quote = fixture.elements.lfQuote.value; reset(); fixture.elements.lfQuote.value = quote; };
  fixture.click();
  fixture.submit();
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
  assert.equal(request.options.body.fields['Параметры для расчёта'], 'Помещения\nПлощадь, м²: 350');
  request.resolve(accepted());
  await flush();
  assert.equal(fixture.f.resets, 1);
  assert.equal(fixture.elements.lfQuote.value, '');
  assert.equal(fixture.elements.lfQuotePreview.hidden, true);
  assert.match(fixture.elements.lfMsg.textContent, /Заявка отправлена/);
  assert.equal(fixture.button.disabled, false);
  assert.deepEqual(fixture.goals, [['110175409', 'reachGoal', 'lead']]);
});

test('the exact ClientID is included for Formspree and never sent alongside an analytics goal', async () => {
  const clientId = '12345678901234567890';
  const fixture = form({ 'Комментарий': 'ТЕСТ локальной передачи' }, clientId);
  fixture.click();
  assert.equal(fixture.requests[0].options.body.fields.ClientID, clientId);
  fixture.requests[0].resolve(accepted());
  await flush();
  assert.deepEqual(fixture.goals, [['110175409', 'reachGoal', 'lead']]);
});

test('missing, unavailable or invalid ClientID does not delay or pollute a submission', () => {
  for (const clientId of [undefined, new Error('Counter unavailable'), '', 'not an ID', 12345]) {
    const fixture = form({}, clientId);
    fixture.click();
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].options.body.fields.ClientID, undefined);
  }
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
    fixture.requests[1].resolve(accepted());
    await flush();
    assert.equal(fixture.goals.length, 1);
  });
}

test('missing name, short phone, missing consent and honeypot prevent submission', () => {
  for (const values of [{ 'name': '' }, { 'Телефон': '+7' }, { _gotcha: 'bot' }]) {
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

test('ambiguous responses preserve a question and never record a successful lead', async () => {
  for (const response of [
    { ok: true, json: async () => { throw new Error('HTML'); } },
    { ok: true, json: async () => ({}) },
    { ok: true, json: async () => ({ ok: false }) },
    { ok: true, json: async () => ({ ok: true, next: '/captcha' }) },
    { ok: true, json: async () => ({ ok: true, errors: [{ code: 'REQUIRED_FIELD_EMPTY' }] }) },
    { ...accepted(), redirected: true }
  ]) {
    const fixture = form({ 'name': 'Анна-Мария', 'Комментарий': 'Сделаете обмер?' });
    fixture.click();
    fixture.requests[0].resolve(response);
    await flush();
    assert.equal(fixture.f.resets, 0);
    assert.equal(fixture.f.elements['Комментарий'].value, 'Сделаете обмер?');
    assert.equal(fixture.button.disabled, false);
    assert.deepEqual(fixture.goals, []);
    assert.match(fixture.elements.lfMsg.className, /err/);
  }
});

test('configured widget requires a response and refreshes it after a rejected request', async () => {
  const captcha = { token: '', resets: 0 };
  const fixture = form({ 'name': 'Anne-Marie', 'Комментарий': 'Обмер завтра?' }, undefined, captcha);
  fixture.submit();
  assert.equal(fixture.requests.length, 0);
  assert.match(fixture.elements.lfMsg.textContent, /проверку от спама/);
  captcha.token = 'local-widget-test';
  fixture.submit();
  const fields = fixture.requests[0].options.body.fields;
  assert.equal(fields['g-recaptcha-response'], captcha.token);
  assert.equal(fields._gotcha, '');
  assert.equal(fields['name'], 'Anne-Marie');
  fixture.requests[0].resolve({ ok: false, json: async () => ({ errors: [{ code: 'CAPTCHA_FAILED' }] }) });
  await flush();
  assert.equal(captcha.resets, 1);
  assert.equal(fixture.button.disabled, false);
  assert.equal(fixture.f.elements['Комментарий'].value, 'Обмер завтра?');
  assert.equal(fixture.goals.length, 0);
  fixture.submit();
  assert.equal(fixture.requests.length, 1);
  captcha.token = 'second-local-widget-test';
  fixture.submit();
  fixture.requests[1].resolve(accepted());
  await flush();
  assert.equal(fixture.f.resets, 1);
  assert.deepEqual(fixture.goals, [['110175409', 'reachGoal', 'lead']]);
});
