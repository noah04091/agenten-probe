const test = require('node:test');
const assert = require('node:assert');
const { addiere, subtrahiere, multipliziere, hoch, dividiere } = require('../src/rechne');

test('dividiere entspricht a / b', () => {
  assert.strictEqual(dividiere(10, 4), 2.5);
  assert.strictEqual(dividiere(1, 0), Infinity);
  assert.strictEqual(dividiere(-1, 0), -Infinity);
  assert.strictEqual(dividiere(0, -5), -0);
  assert.strictEqual(Number.isNaN(dividiere(0, 0)), true);
});

test('hoch entspricht basis ** exponent', () => {
  assert.strictEqual(hoch(2, 10), 1024);
  assert.strictEqual(hoch(2, -1), 0.5);
  assert.strictEqual(hoch(-2, 3), -8);
  assert.strictEqual(hoch(0, 0), 1);
});

test('addiere zählt zwei Zahlen zusammen', () => {
  assert.strictEqual(addiere(2, 3), 5);
});

test('subtrahiere zieht die zweite Zahl von der ersten ab', () => {
  assert.strictEqual(subtrahiere(5, 3), 2);
});

test('multipliziere mit positiven Zahlen', () => {
  assert.strictEqual(multipliziere(2, 3), 6);
});

test('multipliziere mit negativen Zahlen', () => {
  assert.strictEqual(multipliziere(-2, -3), 6);
  assert.strictEqual(multipliziere(-2, 3), -6);
  assert.strictEqual(multipliziere(2, -3), -6);
});

test('multipliziere mit null', () => {
  assert.strictEqual(multipliziere(0, 5), 0);
  assert.strictEqual(multipliziere(5, 0), 0);
  assert.strictEqual(multipliziere(0, 0), 0);
  // 0 und -0 werden unterschieden (strictEqual nutzt Object.is)
  assert.strictEqual(multipliziere(0, -9), -0);
  assert.strictEqual(multipliziere(-9, 0), -0);
});
