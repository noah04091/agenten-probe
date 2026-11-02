const test = require('node:test');
const assert = require('node:assert');
const { addiere, subtrahiere } = require('../src/rechne');

test('addiere zählt zwei Zahlen zusammen', () => {
  assert.strictEqual(addiere(2, 3), 5);
});

test('subtrahiere zieht die zweite Zahl von der ersten ab', () => {
  assert.strictEqual(subtrahiere(5, 3), 2);
});
