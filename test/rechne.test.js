const test = require('node:test');
const assert = require('node:assert');
const { addiere } = require('../src/rechne');

test('addiere zählt zwei Zahlen zusammen', () => {
  assert.strictEqual(addiere(2, 3), 5);
});

test('T12 absichtlich rot', () => { assert.strictEqual(addiere(2, 2), 5); });
