// agent-abnahme-format: v2
//
// Unabhaengige Abnahme fuer Issue #79 (A6 Live 2): umkehren(text) kehrt die Reihenfolge der
// Unicode-Codepoints um, also exakt [...text].reverse().join(''). Nicht nach UTF-16-Einheiten, nicht
// nach sichtbaren Zeichen: ein kombinierendes Zeichen (U+0301) wandert als eigener Codepoint mit und
// darf danach an einem anderen Buchstaben stehen. Einzelne Surrogate werden nicht geprueft.
// Format v2: Dieser Treiber laedt src/text.js nie selbst. Nur ein Kindprozess (Sonde) laedt den
// Agentencode, ruft ihn auf und gibt Ergebnis, Typ oder Fehlerart zurueck. Jeder Vergleich laeuft hier
// im Treiber mit assert.strictEqual. Ohne Netz, ohne Zufall ausser einem festen Seed.
// Erfolg: genau eine Zeile A6-ABNAHME-BESTANDEN.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ziel = require.resolve('../src/text.js');
const NAMEN = ['zeichenzahl', 'umkehren'];

// Eingaben, die JSON nicht direkt traegt, reisen als Kennung und entstehen erst in der Sonde.
const text = s => ({ t: 'string', v: s });
const UNDEFINIERT = { t: 'undefined' };
const NULL = { t: 'null' };
const FUENF = { t: 'number', v: '5' };
const STRINGOBJEKT = { t: 'stringobjekt', v: 'x' };
const FELD = { t: 'array', v: ['a'] };

const SONDE = [
  "'use strict';",
  'const m = require(' + JSON.stringify(ziel) + ');',
  "const ein = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));",
  'const auf = w => {',
  "  switch (w.t) {",
  "    case 'string': return w.v;",
  "    case 'number': return Number(w.v);",
  "    case 'undefined': return undefined;",
  "    case 'null': return null;",
  "    case 'stringobjekt': return new String(w.v);",
  "    case 'array': return [...w.v];",
  "    default: throw new Error('Eingabetyp');",
  '  }',
  '};',
  "const ab = x => typeof x === 'string' ? { t: 'string', v: x } : typeof x === 'number' ? { t: 'number', v: String(x) } : { t: typeof x };",
  'const typen = {};',
  'for (const n of ein.namen) { typen[n] = typeof m[n]; }',
  'const ergebnisse = ein.aufrufe.map(({ n, a, doppelt }) => {',
  '  try { const x = auf(a); return { ok: true, w: ab(doppelt ? m[n](m[n](x)) : m[n](x)) }; }',
  "  catch (e) { return { ok: false, fehler: e instanceof TypeError ? 'TypeError' : 'anderer' }; }",
  '});',
  'process.stdout.write(JSON.stringify({ typen, ergebnisse }));',
].join('\n');

function sonde(aufrufe) {
  const out = spawnSync(process.execPath, ['-e', SONDE], {
    input: JSON.stringify({ namen: NAMEN, aufrufe }),
    env: {},
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (out.error !== undefined || out.status !== 0 || out.signal !== null) {
    throw new Error('Sonde fehlgeschlagen');
  }

  return JSON.parse(out.stdout);
}

// Rueckkodierung: Zeichenketten und Zahlen exakt, jeder andere Typ als Wert, der keinem Soll gleicht.
function wert(r, beschreibung) {
  assert.strictEqual(r.ok, true, `${beschreibung} hat einen Fehler geworfen`);

  if (r.w.t === 'string') {
    return r.w.v;
  }

  return r.w.t === 'number' ? Number(r.w.v) : `kein Wert vom Typ string oder number (${r.w.t})`;
}

function typFehler(r, beschreibung) {
  assert.strictEqual(r.ok ? 'kein Fehler' : r.fehler, 'TypeError', `${beschreibung} muss einen TypeError ausloesen`);
}

// Feste Faelle fuer umkehren. U+00C4 ist ein einzelner Codepoint, U+0301 ein kombinierender Akzent.
const umkehrFest = [
  ['', ''],
  ['abc', 'cba'],
  ['\u00C4pfel', 'lefp\u00C4'],
  ['a\u{1F600}b', 'b\u{1F600}a'],
  ['e\u0301x', 'x\u0301e'],
];

// Lange Eingabe: 100 000 Codepoints aus ASCII, Umlauten und U+1F600, fester Seed.
const VORRAT = ['a', 'b', 'z', 'Q', '0', '7', ' ', '.', '\u00E4', '\u00F6', '\u00FC', '\u00C4', '\u00D6', '\u00DC', '\u00DF', '\u{1F600}'];
let seed = 0x79797979;
const teile = [];

for (let i = 0; i < 100_000; i += 1) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  teile.push(VORRAT[seed % VORRAT.length]);
}

const lang = teile.join('');

// Feste Faelle fuer zeichenzahl, unveraendert.
const zaehlFest = [
  ['', 0],
  ['abc', 3],
  ['\u{1F600}', 1],
  ['e\u0301', 2],
];

const aufrufe = [
  ...umkehrFest.map(([s]) => ({ n: 'umkehren', a: text(s) })),
  { n: 'umkehren', a: text(lang) },
  { n: 'umkehren', a: text(lang), doppelt: true },
  ...[UNDEFINIERT, NULL, FUENF, STRINGOBJEKT, FELD].map(a => ({ n: 'umkehren', a })),
  ...zaehlFest.map(([s]) => ({ n: 'zeichenzahl', a: text(s) })),
  { n: 'zeichenzahl', a: FUENF },
];

const antwort = sonde(aufrufe);

for (const name of NAMEN) {
  assert.strictEqual(antwort.typen[name], 'function', `${name} muss exportiert sein`);
}

assert.strictEqual(antwort.ergebnisse.length, aufrufe.length, 'Sonde lieferte nicht jedes Ergebnis');

const r = antwort.ergebnisse;
let i = 0;

for (const [s, soll] of umkehrFest) {
  assert.strictEqual(wert(r[i], `umkehren(${JSON.stringify(s)})`), soll, `umkehren(${JSON.stringify(s)}) ist falsch`);
  i += 1;
}

assert.strictEqual(wert(r[i], 'umkehren(lange Eingabe)'), [...lang].reverse().join(''),
  'umkehren der langen Eingabe weicht von der Codepoint-Umkehrung ab');
i += 1;
assert.strictEqual(wert(r[i], 'umkehren(umkehren(lange Eingabe))'), lang,
  'umkehren(umkehren(s)) ergibt nicht wieder s');
i += 1;

for (const beschreibung of ['undefined', 'null', '5', "new String('x')", "['a']"]) {
  typFehler(r[i], `umkehren(${beschreibung})`);
  i += 1;
}

for (const [s, soll] of zaehlFest) {
  assert.strictEqual(wert(r[i], `zeichenzahl(${JSON.stringify(s)})`), soll, `zeichenzahl(${JSON.stringify(s)}) wurde beeintraechtigt`);
  i += 1;
}

typFehler(r[i], 'zeichenzahl(5)');

process.stdout.write('A6-ABNAHME-BESTANDEN\n');
