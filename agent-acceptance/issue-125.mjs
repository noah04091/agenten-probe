// agent-abnahme-format: v2
//
// Unabhaengige Abnahme fuer Issue #125 (B2.3a Paket 2): potenz(a, b) liefert exakt a ** b,
// ohne Typpruefung, ohne Rundung, ohne Sonderbehandlung.
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
const NAMEN = ['addiere', 'subtrahiere', 'multipliziere', 'hoch', 'dividiere', 'potenz'];

// Eingaben: Zahlen verlustfrei als Text, Zeichenketten unveraendert (pruefen "ohne Typpruefung").
const kodiere = x => (typeof x === 'string' ? { t: 'string', v: x } : { t: 'number', v: Object.is(x, -0) ? '-0' : String(x) });
const zeige = x => (typeof x === 'string' ? JSON.stringify(x) : kodiere(x).v);

const SONDE = [
  "'use strict';",
  'const m = require(' + JSON.stringify(ziel) + ');',
  "const ein = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));",
  "const auf = w => { if (w.t === 'number') { return Number(w.v); } if (w.t === 'string') { return w.v; } throw new Error('Eingabetyp'); };",
  "const ab = x => typeof x === 'number' ? { t: 'number', v: Object.is(x, -0) ? '-0' : String(x) } : { t: typeof x };",
  "const schluessel = (m !== null && (typeof m === 'object' || typeof m === 'function'))",
  "  ? Reflect.ownKeys(m).map(k => typeof k === 'symbol' ? 'symbol:' + String(k.description) : k) : null;",
  "const getrennt = typeof m.hoch === 'function' && m.hoch !== m.potenz;",
  'const typen = {};',
  'for (const n of ein.namen) { typen[n] = typeof m[n]; }',
  'const ergebnisse = ein.aufrufe.map(([n, a]) => {',
  '  try { return { ok: true, w: ab(m[n](...a.map(auf))) }; }',
  "  catch (e) { return { ok: false, fehler: e instanceof TypeError ? 'TypeError' : 'anderer' }; }",
  '});',
  'process.stdout.write(JSON.stringify({ typ: typeof m, schluessel, getrennt, typen, ergebnisse }));',
].join('\n');

function sonde(aufrufe) {
  const out = spawnSync(process.execPath, ['-e', SONDE], {
    input: JSON.stringify({ namen: NAMEN, aufrufe: aufrufe.map(([n, a]) => [n, a.map(kodiere)]) }),
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

// Pflichtfaelle aus Issue #125 mit ausdruecklich erwartetem Wert, zusaetzlich zum Vergleich mit a ** b.
const pflicht = [
  [[2, 10], 1024],
  [[2, -1], 0.5],
  [[-2, 3], -8],
  [[-2, 2], 4],
  [[0, 0], 1],
  [[-8, 1 / 3], NaN],
];

// Feste Grenzfaelle mit ausdruecklich erwartetem Wert: -0, NaN, Infinity und -Infinity muessen
// unterscheidbar bleiben. Wer -0 zu 0 macht, 0 ** 0 anders behandelt oder NaN ersetzt, faellt hier auf.
const grenz = [
  [[-0, 3], -0],
  [[-0, 2], 0],
  [[-0, -1], -Infinity],
  [[-0, -2], Infinity],
  [[-0, 0.5], 0],
  [[-0, -0.5], Infinity],
  [[0, -1], Infinity],
  [[0, 3], 0],
  [[-0, 0], 1],
  [[0, -0], 1],
  [[NaN, 0], 1],
  [[NaN, -0], 1],
  [[NaN, 1], NaN],
  [[1, NaN], NaN],
  [[0, NaN], NaN],
  [[1, Infinity], NaN],
  [[1, -Infinity], NaN],
  [[-1, Infinity], NaN],
  [[2, Infinity], Infinity],
  [[2, -Infinity], 0],
  [[0.5, Infinity], 0],
  [[0.5, -Infinity], Infinity],
  [[Infinity, 0], 1],
  [[Infinity, -1], 0],
  [[-Infinity, 3], -Infinity],
  [[-Infinity, 2], Infinity],
  [[-Infinity, -3], -0],
  [[-Infinity, -2], 0],
  [[10, 309], Infinity],
  [[-10, 309], -Infinity],
  [[2, -1075], 0],
  [[-2, -1075], -0],
  [[2, 0.5], Math.SQRT2],
  [[-2, 0.5], NaN],
  [['2', '3'], 8],
  [['-0', 3], -0],
  [['abc', 2], NaN],
];

const festPotenz = [...pflicht, ...grenz];

// 200 reproduzierbare Paare: Basis -12 bis 12, jede zweite als Bruch mit Achteln, jede siebte als -0;
// Exponent ganzzahlig von -8 bis 8, jeder fuenfte als Bruch mit Vierteln. Sollwert jeweils a ** b.
const naechstesPaar = generator(0x12512500);
const potenzZusatz = [];

for (let i = 0; i < 200; i += 1) {
  const ganz = (naechstesPaar() % 25) - 12;
  const a = i % 7 === 0 ? -0 : (i % 2 === 0 ? ganz / 8 : ganz);
  const e = (naechstesPaar() % 17) - 8;
  potenzZusatz.push([a, i % 5 === 0 ? e / 4 : e]);
}

// Feste Faelle fuer addiere, subtrahiere, multipliziere, dividiere wie in agent-acceptance/issue-111.mjs.
const bestandFest = [
  [2, 3], [7, 0], [0, -9], [-4, 5], [-4, -6], [15, 8], [1, 1], [0.5, 4], [3, -2], [123, 456],
  [-0, 5], [5, -0], [0, 0], [-0, -0],
];
const naechsterBestand = generator(0x12345678);
const bestandZusatz = [];

for (let i = 0; i < 100; i += 1) {
  bestandZusatz.push([(naechsterBestand() % 2001) - 1000, (naechsterBestand() % 41) - 20]);
}

const potenzAlle = [...festPotenz.map(([p]) => p), ...potenzZusatz];
const bestandAlle = [...bestandFest, ...bestandZusatz];
const aufrufe = [];

// potenz und hoch bekommen dieselben Faelle: hoch bleibt unveraendert a ** b.
for (const [a, b] of potenzAlle) {
  aufrufe.push(['potenz', [a, b]], ['hoch', [a, b]]);
}

for (const [a, b] of bestandAlle) {
  aufrufe.push(['addiere', [a, b]], ['subtrahiere', [a, b]], ['multipliziere', [a, b]], ['dividiere', [a, b]]);
}

const antwort = sonde(aufrufe);

for (const name of NAMEN) {
  assert.strictEqual(antwort.typen[name], 'function', `${name} muss als Funktion exportiert sein`);
}

assert.strictEqual(antwort.typ, 'object', 'module.exports muss ein Objekt sein');
assert.ok(Array.isArray(antwort.schluessel), 'Exporte nicht lesbar');
assert.strictEqual(JSON.stringify([...antwort.schluessel].sort()), JSON.stringify([...NAMEN].sort()),
  `Exporte muessen genau ${NAMEN.join(', ')} sein`);
assert.strictEqual(antwort.getrennt, true, 'hoch muss eine eigene Funktion bleiben und darf nicht durch potenz ersetzt werden');
assert.strictEqual(antwort.ergebnisse.length, aufrufe.length, 'Sonde lieferte nicht jedes Ergebnis');

let i = 0;

for (const [k, [a, b]] of potenzAlle.entries()) {
  const art = k < pflicht.length ? 'Pflichtfall' : (k < festPotenz.length ? 'Grenzfall' : `Zusatzfall ${k + 1 - festPotenz.length}`);
  const soll = a ** b;
  const istPotenz = wert(antwort.ergebnisse[i], `${art}: potenz(${zeige(a)}, ${zeige(b)})`);
  const istHoch = wert(antwort.ergebnisse[i + 1], `${art}: hoch(${zeige(a)}, ${zeige(b)})`);
  assert.strictEqual(istPotenz, soll, `${art}: potenz(${zeige(a)}, ${zeige(b)}) liefert nicht exakt a ** b`);
  assert.strictEqual(istHoch, soll, `${art}: hoch(${zeige(a)}, ${zeige(b)}) wurde beeintraechtigt`);

  if (k < festPotenz.length) {
    assert.strictEqual(istPotenz, festPotenz[k][1], `${art}: potenz(${zeige(a)}, ${zeige(b)}) muss ${zeige(festPotenz[k][1])} liefern`);
  }

  i += 2;
}

for (const [k, [a, b]] of bestandAlle.entries()) {
  const fall = k < bestandFest.length ? `Fall (${zeige(a)}, ${zeige(b)})` : `Zusatzfall ${k + 1 - bestandFest.length} (${a}, ${b})`;
  assert.strictEqual(wert(antwort.ergebnisse[i], `addiere ${fall}`), a + b, `${fall}: addiere wurde beeintraechtigt`);
  assert.strictEqual(wert(antwort.ergebnisse[i + 1], `subtrahiere ${fall}`), a - b, `${fall}: subtrahiere wurde beeintraechtigt`);
  assert.strictEqual(wert(antwort.ergebnisse[i + 2], `multipliziere ${fall}`), a * b, `${fall}: multipliziere wurde beeintraechtigt`);
  assert.strictEqual(wert(antwort.ergebnisse[i + 3], `dividiere ${fall}`), a / b, `${fall}: dividiere wurde beeintraechtigt`);
  i += 4;
}

assert.strictEqual(i, aufrufe.length, 'nicht jedes Ergebnis wurde geprueft');

process.stdout.write('A6-ABNAHME-BESTANDEN\n');
