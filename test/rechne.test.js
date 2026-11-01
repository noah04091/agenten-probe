const test = require('node:test');
const assert = require('node:assert');
const { addiere } = require('../src/rechne');

test('addiere zählt zwei Zahlen zusammen', () => {
  assert.strictEqual(addiere(2, 3), 5);
});
