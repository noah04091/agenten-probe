// B1.1 Command Center: Logauszug (W6). Nur Code, Runden, Kosten; nie Logtext.
globalThis.fetch = () => { throw new Error('W10: Netz in Zentrale-Tests verboten'); };

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { GRENZE_ZEICHEN, logAuszug } from '../werkzeuge/zentrale/log-auszug.mjs';
import { cacheBereinigt } from '../werkzeuge/zentrale/zentrale.mjs';

const LOGS = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'zentrale', 'logs');
const log = name => readFileSync(join(LOGS, `${name}.txt`), 'utf8');

test('Logauszug: echte Formen (BOM, Zeitstempel) ergeben Code, Runden und Kosten', () => {
  assert.ok(log('job1-live2').startsWith('﻿'), 'Muss-Treffer: BOM wie im echten Log');
  assert.deepEqual({ ...logAuszug(log('job1-live2')) }, { code: null, runden: 6, kosten: 0.047427800000000006 });
  assert.deepEqual({ ...logAuszug(log('job1-nf2')) }, { code: null, runden: 5, kosten: 0.026869399999999998 });
  assert.deepEqual({ ...logAuszug(log('job2-nf2')) }, { code: 'abnahme-exitcode', runden: null, kosten: null });
  assert.deepEqual({ ...logAuszug(log('job1-nf3')) }, { code: 'auftrag-label-start-fehlt', runden: null, kosten: null });
});

test('Logauszug: Skriptanzeige, fast passende und eingeschleuste Zeilen zaehlen nicht (W6)', () => {
  const text = log('eingeschleust');
  assert.ok(text.includes('ghs_TESTGEHEIMNIS') && text.includes('<script>'), 'Muss-Treffer: Testgeheimnis und Fremdtext im Log');
  const r = logAuszug(text);
  assert.deepEqual(Object.keys(r).sort(), ['code', 'kosten', 'runden']);
  assert.deepEqual({ ...r }, { code: 'paket-unveraendert', runden: null, kosten: null });
  const aus = JSON.stringify(r);

  for (const verboten of ['ghs_', 'TESTGEHEIMNIS', 'script', 'ignoriere', 'Token', 'GROSS', 'fuehrendes']) {
    assert.ok(!aus.includes(verboten), `${verboten} in der Ausgabe`);
  }

  // Auch der Cache nimmt nur diese drei Werte auf; jedes weitere Feld und jeder ungueltige Code fliegt raus.
  const cache = cacheBereinigt({ 1: { ...r, roh: text }, 2: { code: 'ghs_TEST <x>', runden: 1, kosten: 1 }, abc: r });
  assert.deepEqual(cache, { 1: { code: 'paket-unveraendert', runden: null, kosten: null } });
  assert.ok(!JSON.stringify(cache).includes('ghs_'));
});

test('Logauszug: CRLF, mehrere Codes, mehrere Kostenzeilen, ungueltige Eingaben', () => {
  const z = s => `2026-11-20T10:00:00.0000000Z ${s}`;
  assert.equal(logAuszug(`${z('A6-FEHLER abnahme-exitcode')}\r\n`).code, 'abnahme-exitcode');
  assert.equal(logAuszug('A6-FEHLER abnahme-exitcode\n').code, 'abnahme-exitcode');
  assert.equal(logAuszug([z('A6-FEHLER abnahme-exitcode'), z('A6-FEHLER paket-unveraendert')].join('\n')).code, 'mehrdeutig');
  assert.equal(logAuszug([z('A6-FEHLER abnahme-exitcode'), z('A6-FEHLER abnahme-exitcode')].join('\n')).code, 'mehrdeutig');
  const zwei = logAuszug([z('Claude beendet: Runden 1, Kosten 0.1 USD'), z('Claude beendet: Runden 2, Kosten 0.2 USD')].join('\n'));
  assert.deepEqual([zwei.runden, zwei.kosten], [null, null]);
  assert.equal(logAuszug(z('Claude beendet: Runden 6, Kosten 1e-05 USD')).kosten, null);
  assert.equal(logAuszug(z('Claude beendet: Runden 6, Kosten null USD')).kosten, null);
  assert.equal(logAuszug(z(`A6-FEHLER ${'a'.repeat(61)}`)).code, null);
  assert.equal(logAuszug(z('A6-FEHLER abnahme-exitcode ')).code, null);

  for (const x of [null, undefined, 42, {}, ['A6-FEHLER x']]) {
    assert.deepEqual({ ...logAuszug(x) }, { code: null, runden: null, kosten: null });
  }

  assert.equal(logAuszug(`A6-FEHLER abnahme-exitcode\n${'x'.repeat(GRENZE_ZEICHEN)}`).code, null);
});
