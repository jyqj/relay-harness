const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const QA_ONLY = new Set(['main/release-ui-walk.js', 'main/composer-official-qa.js']);

test('every packaged production source JavaScript file opts into type checking', () => {
  const root = path.resolve(__dirname, '..');
  const missing = [];
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    const relative = String(entry).split(path.sep).join('/');
    if (!relative.endsWith('.js') || relative.endsWith('.test.js') || QA_ONLY.has(relative)) continue;
    const source = fs.readFileSync(path.join(root, String(entry)), 'utf8');
    if (!/^\s*(?:#![^\n]*\n)?\s*\/\/ @ts-check\b/.test(source) || /@ts-nocheck/.test(source)) missing.push(relative);
  }
  assert.deepEqual(missing, [], 'New production JS must carry @ts-check; do not hide it behind an exclusion');
  const config = fs.readFileSync(path.resolve(root, '..', 'tsconfig.json'), 'utf8');
  const parsed = JSON.parse(config.replace(/\/\/[^\n]*/g, ''));
  assert.deepEqual(parsed.exclude.slice().sort(), ['node_modules', 'vendor', ...Array.from(QA_ONLY, entry => `src/${entry}`)].sort());
  assert.ok(parsed.include.includes('src/**/*.js'));
  assert.ok(parsed.include.includes('src/**/*.d.ts'));
});
