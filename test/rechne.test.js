const test = require('node:test');
const assert = require('node:assert');
const { addiere, subtrahiere, multipliziere, quadrat } = require('../src/rechne');

test('quadrat entspricht a * a', () => {
  assert.strictEqual(quadrat(3), 9);
  assert.strictEqual(quadrat(-4), 16);
  assert.strictEqual(quadrat(0), 0);
  assert.strictEqual(quadrat(-0), -0 * -0);
  assert.strictEqual(quadrat(0.5), 0.25);
  assert.strictEqual(quadrat(Infinity), Infinity);
  assert.strictEqual(quadrat(-Infinity), Infinity);
  assert.strictEqual(quadrat(NaN), NaN);
  assert.strictEqual(quadrat(1e200), 1e200 * 1e200);
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
