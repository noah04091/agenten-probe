// agent-abnahme-format: v2
//
// Unabhaengige Abnahme fuer Issue #78 (A6 Live 1): quadrat(a) liefert exakt a * a.
// Format v2: Dieser Treiber laedt src/rechne.js nie selbst. Nur ein Kindprozess (Sonde) laedt den
// Agentencode, ruft ihn auf und gibt die Ergebnisse verlustfrei kodiert zurueck (-0, NaN, Infinity
// und der Typ bleiben unterscheidbar). Jeder Vergleich laeuft hier im Treiber mit assert.strictEqual.
// Ohne Netz, ohne Zufall ausser festen Seeds. Erfolg: genau eine Zeile A6-ABNAHME-BESTANDEN.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ziel = require.resolve('../src/rechne.js');
const NAMEN = ['addiere', 'subtrahiere', 'multipliziere', 'quadrat'];

const zahl = x => ({ t: 'number', v: Object.is(x, -0) ? '-0' : String(x) });

const SONDE = [
  "'use strict';",
  'const m = require(' + JSON.stringify(ziel) + ');',
  "const ein = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));",
  "const auf = w => { if (w.t === 'number') { return Number(w.v); } throw new Error('Eingabetyp'); };",
  "const ab = x => typeof x === 'number' ? { t: 'number', v: Object.is(x, -0) ? '-0' : String(x) } : { t: typeof x };",
  'const typen = {};',
  'for (const n of ein.namen) { typen[n] = typeof m[n]; }',
  'const ergebnisse = ein.aufrufe.map(([n, a]) => {',
  '  try { return { ok: true, w: ab(m[n](...a.map(auf))) }; }',
  "  catch (e) { return { ok: false, fehler: e instanceof TypeError ? 'TypeError' : 'anderer' }; }",
  '});',
  'process.stdout.write(JSON.stringify({ typen, ergebnisse }));',
].join('\n');

function sonde(aufrufe) {
  const out = spawnSync(process.execPath, ['-e', SONDE], {
    input: JSON.stringify({ namen: NAMEN, aufrufe: aufrufe.map(([n, a]) => [n, a.map(zahl)]) }),
    env: {},
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });

  if (out.error !== undefined || out.status !== 0 || out.signal !== null) {
    throw new Error('Sonde fehlgeschlagen');
  }

  return JSON.parse(out.stdout);
}

// Rueckkodierung: Zahlen exakt, jeder andere Typ wird zu einem Wert, der nie einer Zahl gleicht.
function wert(r, beschreibung) {
  assert.strictEqual(r.ok, true, `${beschreibung} hat einen Fehler geworfen`);
  return r.w.t === 'number' ? Number(r.w.v) : `kein Zahlwert (${r.w.t})`;
}

// Reproduzierbarer Zahlengenerator wie in agent-acceptance/issue-38.mjs.
function generator(start) {
  let seed = start;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed % 2001) - 1000;
  };
}

// Feste Faelle fuer addiere, subtrahiere, multipliziere wie in agent-acceptance/issue-38.mjs.
const bestandFest = [
  [2, 3], [7, 0], [0, -9], [-4, 5], [-4, -6], [15, 8], [1, 1], [0.5, 4], [3, -2], [123, 456],
];
const naechsterBestand = generator(0x12345678);
const bestandZusatz = [];

for (let i = 0; i < 100; i += 1) {
  bestandZusatz.push([naechsterBestand(), naechsterBestand()]);
}

const quadratFest = [
  3, -4, 0, -0, 0.5, -2.5, 1e-200, 1e200, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity,
];
const naechstesQuadrat = generator(0x78787878);
const quadratZusatz = [];

for (let i = 0; i < 100; i += 1) {
  quadratZusatz.push(naechstesQuadrat());
}

const aufrufe = [];

for (const a of [...quadratFest, ...quadratZusatz]) {
  aufrufe.push(['quadrat', [a]]);
}

for (const [a, b] of [...bestandFest, ...bestandZusatz]) {
  aufrufe.push(['multipliziere', [a, b]], ['addiere', [a, b]], ['subtrahiere', [a, b]]);
}

const antwort = sonde(aufrufe);

for (const name of NAMEN) {
  assert.strictEqual(antwort.typen[name], 'function', `${name} muss exportiert sein`);
}

assert.strictEqual(antwort.ergebnisse.length, aufrufe.length, 'Sonde lieferte nicht jedes Ergebnis');

let i = 0;

for (const a of quadratFest) {
  assert.strictEqual(wert(antwort.ergebnisse[i], `quadrat(${zahl(a).v})`), a * a,
    `quadrat(${zahl(a).v}) liefert nicht exakt a * a`);
  i += 1;
}

for (const [k, a] of quadratZusatz.entries()) {
  assert.strictEqual(wert(antwort.ergebnisse[i], `quadrat(${a})`), a * a,
    `Zusatzfall ${k + 1}: quadrat(${a})`);
  i += 1;
}

for (const [k, [a, b]] of [...bestandFest, ...bestandZusatz].entries()) {
  const fall = k < bestandFest.length ? `Fall (${a}, ${b})` : `Zusatzfall ${k + 1 - bestandFest.length} (${a}, ${b})`;
  assert.strictEqual(wert(antwort.ergebnisse[i], `multipliziere ${fall}`), a * b,
    `${fall}: multipliziere wurde beeintraechtigt`);
  assert.strictEqual(wert(antwort.ergebnisse[i + 1], `addiere ${fall}`), a + b,
    `${fall}: addiere wurde beeintraechtigt`);
  assert.strictEqual(wert(antwort.ergebnisse[i + 2], `subtrahiere ${fall}`), a - b,
    `${fall}: subtrahiere wurde beeintraechtigt`);
  i += 3;
}

// Ausdruecklich: multipliziere(0, -9) ergibt -0 (Fall 3 der festen Faelle).
assert.strictEqual(wert(antwort.ergebnisse[quadratFest.length + quadratZusatz.length + 6], 'multipliziere(0, -9)'), -0,
  'multipliziere(0, -9) muss -0 liefern');

process.stdout.write('A6-ABNAHME-BESTANDEN\n');
