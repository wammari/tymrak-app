import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicAssets } from '../cloudflare/public-assets.mjs';

const pages = ['login.html', 'manager-login.html', 'activate.html', 'reset-password.html', 'employee.html', 'timecard.html'];

test('every page with a password field loads the show/hide script', () => {
  for (const page of pages) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.match(html, /<script src="\/password-toggle\.js" defer><\/script>/, page);
  }
});

test('password-toggle.js is published and switches the field type', () => {
  assert.ok(publicAssets.includes('password-toggle.js'));
  const js = readFileSync(new URL('../password-toggle.js', import.meta.url), 'utf8');
  assert.match(js, /input\.type = visible \? "text" : "password"/);
  assert.match(js, /aria-pressed/);
});

test('password fields created later by a page are covered too', () => {
  const js = readFileSync(new URL('../password-toggle.js', import.meta.url), 'utf8');
  assert.match(js, /MutationObserver/);
});
