
//
// Unabhaengiger Funktionstest fuer Code-Pilot Issue #38.
// Nur im isolierten Testcontainer nach dem Paketimport ausfuehren.
// Diese Datei liegt ausserhalb der beiden fuer Claude erlaubten Dateien.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { addiere, subtrahiere, multipliziere } = require('../src/rechne.js');

for (const [name, fn] of [
  ['addiere', addiere],
  ['subtrahiere', subtrahiere],
  ['multipliziere', multipliziere],
]) {
  assert.equal(typeof fn, 'function', `${name} muss exportiert sein`);
}

const fixedCases = [
  [2, 3],
  [7, 0],
  [0, -9],
  [-4, 5],
  [-4, -6],
  [15, 8],
  [1, 1],
  [0.5, 4],
  [3, -2],
  [123, 456],
];

for (const [a, b] of fixedCases) {
  assert.strictEqual(multipliziere(a, b), a * b,
    `multipliziere(${a}, ${b}) liefert ein falsches Ergebnis`);
  assert.strictEqual(addiere(a, b), a + b,
    `addiere(${a}, ${b}) wurde beeintraechtigt`);
  assert.strictEqual(subtrahiere(a, b), a - b,
    `subtrahiere(${a}, ${b}) wurde beeintraechtigt`);
}

// Reproduzierbare, unabhaengige Zusatzfaelle gegen hart codierte Antworten.
let seed = 0x12345678;
function nextNumber() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return (seed % 2001) - 1000;
}

for (let i = 0; i < 100; i += 1) {
  const a = nextNumber();
  const b = nextNumber();

  assert.strictEqual(multipliziere(a, b), a * b,
    `Zusatzfall ${i + 1}: multipliziere(${a}, ${b})`);
  assert.strictEqual(addiere(a, b), a + b,
    `Zusatzfall ${i + 1}: addiere(${a}, ${b})`);
  assert.strictEqual(subtrahiere(a, b), a - b,
    `Zusatzfall ${i + 1}: subtrahiere(${a}, ${b})`);
}

console.log('Code-Pilot: 110 unabhaengige Rechenfaelle bestanden.');
