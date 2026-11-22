// agent-abnahme-format: v2
//
// Unabhaengige Abnahme fuer Issue #111 (B0-Funktionstest): dividiere(a, b) liefert exakt a / b.
// Format v2: Dieser Treiber laedt src/rechne.js nie selbst. Nur ein Kindprozess (Sonde) laedt den
// Agentencode, ruft ihn auf und gibt die Ergebnisse verlustfrei kodiert zurueck (-0, NaN, Infinity
// und der Typ bleiben unterscheidbar). Jeder Vergleich laeuft hier im Treiber mit assert.strictEqual
// (Object.is-Genauigkeit). Ohne Netz, ohne Zufall ausser festen Seeds.
// Erfolg: genau eine Zeile A6-ABNAHME-BESTANDEN.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ziel = require.resolve('../src/rechne.js');
const NAMEN = ['addiere', 'subtrahiere', 'multipliziere', 'hoch', 'dividiere'];

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
    return seed;
  };
}

// Pflichtfaelle fuer dividiere mit ausdruecklich erwartetem Wert, zusaetzlich zum Vergleich mit a / b.
const dividiereSoll = [
  [[10, 4], 2.5],
  [[6, 3], 2],
  [[-9, 4], -2.25],
  [[7, -2], -3.5],
  [[1, 3], 1 / 3],
  [[0.5, 0.25], 2],
  [[1, 0], Infinity],
  [[-1, 0], -Infinity],
  [[0, -5], -0],
  [[0, 0], NaN],
  [[-0, 5], -0],
  [[5, -0], -Infinity],
  [[0, 5], 0],
];

// 100 reproduzierbare Paare: Zaehler -1000 bis 1000, Nenner -20 bis 20 (die 0 ist moeglich),
// jeder dritte Zaehler als Bruch mit Nachkommastellen.
const naechstesPaar = generator(0x10910910);
const dividiereZusatz = [];

for (let i = 0; i < 100; i += 1) {
  const ganz = (naechstesPaar() % 2001) - 1000;
  const a = i % 3 === 0 ? ganz / 8 : ganz;
  dividiereZusatz.push([a, (naechstesPaar() % 41) - 20]);
}

// Feste Faelle fuer addiere, subtrahiere, multipliziere wie in agent-acceptance/issue-38.mjs.
const bestandFest = [
  [2, 3], [7, 0], [0, -9], [-4, 5], [-4, -6], [15, 8], [1, 1], [0.5, 4], [3, -2], [123, 456],
];
const naechsterBestand = generator(0x12345678);
const bestandZusatz = [];

for (let i = 0; i < 100; i += 1) {
  bestandZusatz.push([(naechsterBestand() % 2001) - 1000, (naechsterBestand() % 2001) - 1000]);
}

// Feste Faelle und Zusatzfaelle fuer hoch wie in agent-acceptance/issue-82.mjs.
const hochFest = [
  [2, 10], [2, -1], [-2, 3], [0, 0], [-0, 3], [2, 0.5], [NaN, 0], [1, Infinity], [10, 309],
];
const naechsterHoch = generator(0x82828282);
const hochZusatz = [];

for (let i = 0; i < 50; i += 1) {
  hochZusatz.push([(naechsterHoch() % 21) - 10, (naechsterHoch() % 13) - 6]);
}

const dividiereAlle = [...dividiereSoll.map(([p]) => p), ...dividiereZusatz];
const aufrufe = [];

for (const [a, b] of dividiereAlle) {
  aufrufe.push(['dividiere', [a, b]]);
}

for (const [b, e] of [...hochFest, ...hochZusatz]) {
  aufrufe.push(['hoch', [b, e]]);
}

for (const [a, b] of [...bestandFest, ...bestandZusatz]) {
  aufrufe.push(['multipliziere', [a, b]], ['addiere', [a, b]], ['subtrahiere', [a, b]]);
}

const antwort = sonde(aufrufe);

for (const name of NAMEN) {
  assert.strictEqual(antwort.typen[name], 'function', `${name} muss als Funktion exportiert sein`);
}

assert.strictEqual(antwort.ergebnisse.length, aufrufe.length, 'Sonde lieferte nicht jedes Ergebnis');

let i = 0;

for (const [k, [a, b]] of dividiereAlle.entries()) {
  const pflicht = k < dividiereSoll.length;
  const fall = `${pflicht ? 'Pflichtfall' : `Zusatzfall ${k + 1 - dividiereSoll.length}`}: dividiere(${zahl(a).v}, ${zahl(b).v})`;
  const ist = wert(antwort.ergebnisse[i], fall);
  assert.strictEqual(ist, a / b, `${fall} liefert nicht exakt a / b`);

  if (pflicht) {
    assert.strictEqual(ist, dividiereSoll[k][1], `${fall} muss ${zahl(dividiereSoll[k][1]).v} liefern`);
  }

  i += 1;
}

for (const [k, [b, e]] of [...hochFest, ...hochZusatz].entries()) {
  const fall = `${k < hochFest.length ? 'Fall' : `Zusatzfall ${k + 1 - hochFest.length}`}: hoch(${zahl(b).v}, ${zahl(e).v})`;
  assert.strictEqual(wert(antwort.ergebnisse[i], fall), b ** e, `${fall}: hoch wurde beeintraechtigt`);
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

assert.strictEqual(i, aufrufe.length, 'nicht jedes Ergebnis wurde geprueft');

process.stdout.write('A6-ABNAHME-BESTANDEN\n');
