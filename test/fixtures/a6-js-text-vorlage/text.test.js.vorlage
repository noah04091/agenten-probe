const test = require('node:test');
const assert = require('node:assert/strict');

// Momentaufnahme VOR dem Laden des Moduls und vor jedem Aufruf, auch nicht aufzaehlbare Schluessel.
const globalVorher = Reflect.ownKeys(globalThis);
const stringPrototypVorher = Reflect.ownKeys(String.prototype);

const textModul = require('../src/text');

const { zeichenzahl } = textModul;

// Alle erwarteten Werte sind feste Zahlen, keine zweite Zaehllogik als Referenz.

test('Export: genau zeichenzahl als Funktion mit einem Parameter', () => {
  assert.deepEqual(Object.keys(textModul), ['zeichenzahl']);
  assert.equal(typeof zeichenzahl, 'function');
  assert.equal(zeichenzahl.length, 1);
});

test('normale Zeichenketten', () => {
  assert.strictEqual(zeichenzahl(''), 0);
  assert.strictEqual(zeichenzahl('a'), 1);
  assert.strictEqual(zeichenzahl('Hallo'), 5);
  assert.strictEqual(zeichenzahl(' '), 1);
  assert.strictEqual(zeichenzahl('Hallo Welt'), 10);
  assert.strictEqual(zeichenzahl('Hallo, Welt!?'), 13);
  assert.strictEqual(zeichenzahl('Raum 42'), 7);
  assert.strictEqual(zeichenzahl('0123456789'), 10);
  assert.strictEqual(zeichenzahl('\t\n'), 2);
});

test('deutsche Umlaute und \u00df', () => {
  assert.strictEqual(zeichenzahl('\u00e4\u00f6\u00fc'), 3);
  assert.strictEqual(zeichenzahl('\u00c4\u00d6\u00dc'), 3);
  assert.strictEqual(zeichenzahl('\u00df'), 1);
  assert.strictEqual(zeichenzahl('Stra\u00dfe'), 6);
});

test('Emoji ausserhalb der Basic Multilingual Plane zaehlt als ein Codepoint', () => {
  const emoji = '\u{1F600}';
  assert.strictEqual(emoji.length, 2);
  assert.strictEqual(zeichenzahl(emoji), 1);
  assert.strictEqual(zeichenzahl(`a${emoji}b`), 3);
  assert.strictEqual(zeichenzahl('\u{1D11E}'), 1);
});

test('kombinierende Zeichen werden einzeln gezaehlt, keine Normalisierung', () => {
  // a mit kombinierendem Trema: zwei Codepoints. Nach NFC waere es ein Codepoint.
  assert.strictEqual(zeichenzahl('a\u0308'), 2);
  assert.strictEqual(zeichenzahl('a\u0308'.normalize('NFC')), 1);
  // Vorkomponiertes ae: ein Codepoint. Nach NFD waeren es zwei.
  assert.strictEqual(zeichenzahl('\u00e4'), 1);
  assert.strictEqual(zeichenzahl('\u00e4'.normalize('NFD')), 2);
  // Mehrere kombinierende Zeichen an einem Buchstaben.
  assert.strictEqual(zeichenzahl('e\u0301\u0323'), 3);
});

test('zusammengesetzte Emoji zaehlen jeden Codepoint (keine Graphem-Cluster)', () => {
  // Flagge Deutschland: zwei Regional-Indicator-Codepoints.
  assert.strictEqual(zeichenzahl('\u{1F1E9}\u{1F1EA}'), 2);
  // Frau am Computer: Frau, Zero-Width-Joiner, Laptop.
  assert.strictEqual(zeichenzahl('\u{1F469}\u200d\u{1F4BB}'), 3);
  // Daumen hoch mit Hautton-Modifikator.
  assert.strictEqual(zeichenzahl('\u{1F44D}\u{1F3FD}'), 2);
});

test('einzelne Surrogate zaehlen je als ein Codepoint', () => {
  assert.strictEqual(zeichenzahl('\uD83D'), 1);
  assert.strictEqual(zeichenzahl('\uDE00'), 1);
  assert.strictEqual(zeichenzahl('\uDE00\uD83D'), 2);
  assert.strictEqual(zeichenzahl('x\uD83Dy'), 3);
});

test('lange Eingabe mit 100 000 Codepoints', () => {
  // 50 000 Emoji (je zwei UTF-16-Einheiten) und 50 000 Umlaute: 150 000 Einheiten, 100 000 Codepoints.
  const lang = '\u{1F600}'.repeat(50_000) + '\u00e4'.repeat(50_000);
  assert.strictEqual(lang.length, 150_000);
  assert.strictEqual(zeichenzahl(lang), 100_000);
  assert.strictEqual(zeichenzahl('a'.repeat(100_000)), 100_000);
  assert.strictEqual(zeichenzahl('a'.repeat(100_001)), 100_001);
});

const MELDUNG = 'zeichenzahl erwartet eine primitive Zeichenkette';

test('ungueltige Typen loesen einen echten TypeError aus, ohne Typumwandlung', () => {
  const ungueltig = [
    null,
    undefined,
    42,
    0,
    Number.NaN,
    true,
    false,
    10n,
    Symbol('x'),
    [],
    ['Hallo'],
    {},
    { toString: () => 'Hallo' },
    new String('Hallo'),
    () => 'Hallo',
  ];

  for (const wert of ungueltig) {
    // Die eigene Meldung belegt, dass die Typpruefung greift und nicht erst for...of scheitert.
    assert.throws(() => zeichenzahl(wert), error => error instanceof TypeError && error.constructor === TypeError && error.message === MELDUNG, String(typeof wert));
  }

  assert.throws(() => zeichenzahl(), error => error.constructor === TypeError && error.message === MELDUNG);
});

test('die uebergebene Zeichenkette und der globale Zustand bleiben unveraendert', () => {
  const text = 'a\u0308\u{1F469}\u200d\u{1F4BB}';
  const kopie = `${text}`;

  assert.strictEqual(zeichenzahl(text), 5);
  assert.strictEqual(zeichenzahl(text), 5);
  assert.strictEqual(text, kopie);
  assert.strictEqual(text.length, 7);
  assert.deepEqual(Reflect.ownKeys(globalThis), globalVorher);
  assert.deepEqual(Reflect.ownKeys(String.prototype), stringPrototypVorher);
});
