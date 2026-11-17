// A6 P-1: Generalprobe als gewoehnlicher Test. Dieselbe Kette und dieselben Negativfaelle, die der Workflow
// in seinen Probejobs ausfuehrt, hier in einem Prozessbaum ohne Container, ohne Netz und ohne Artefakte.
//
// Der Harness (generalprobe/probe.mjs) startet die UNVERAENDERTEN Einstiege aus scripts/ mit genau ihrem
// Umgebungsvertrag. Ersetzt sind nur GitHub (Vorlademodul github-attrappe.mjs) und Claude (festes
// Testpaket). Jeder Negativfall muss an genau seinem Fehlercode scheitern.
//
// Was dieser Test NICHT zeigt: Container, Netzisolation, Vorschaltcontainer, echte Artefakte, die
// Einhaltung durch GitHub Actions selbst, Claude. Das zeigen die Probejobs des Workflows.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FAELLE, ISSUE, RUN_ID, WRITES_OK, kette, negativ, pruefeAnfragen } from '../generalprobe/probe.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ANKER = createHash('sha256').update(readFileSync(join(ROOT, 'scripts', 'agent-code-integritaet.mjs'))).digest('hex');
const BASIS_DIR = mkdtempSync(join(tmpdir(), 'a6-generalprobe-test-'));

after(() => rmSync(BASIS_DIR, { recursive: true, force: true }));

// Erwartete Codes, hier ein zweites Mal festgeschrieben: eine Aenderung im Harness allein macht den Test rot.
const ERWARTET = Object.freeze({
  'P5-paket-manipuliert': 'job-paket-hash',
  'P5-ungueltiger-hash': 'job-hash-format',
  'P5-fremder-lauf': 'job-schnappschuss-lauf',
  'P5-falscher-ausgangscommit': 'auftrag-abweichung',
  'P5-checkout-nicht-auf-basis': 'job-checkout-head',
  'P7-skriptbytes-veraendert': 'integritaet-skript-hash',
  'N1N2-pruefer-und-policy-veraendert': 'anker-pruefer',
  'S4-node-options-im-vertrag': 'job-umgebung-node',
  'K2-git-config-im-arbeitsordner': 'paket-git-ordner',
  'P4-code-veraendert-hash-nachgezogen': 'paket-sha256',
  'P4-code-veraendert-sha256-nachgezogen': 'paket-git-blob',
  'P3-abnahme-im-arbeitsbaum-wirkungslos': 'bestanden',
  'E1-freigabe-zweimal-branch': 'live-branch-vorhanden',
  'E2-freigabe-zweimal-pr': 'live-pr-vorhanden',
  'L2-ausgabedatei-als-symlink': 'job-ausgabe-datei',
  'L1-job3-zweiter-versuch': 'live-branch-vorhanden',
  'NF2-abnahme-fachlich-falsch': 'abnahme-exitcode',
});

test('Generalprobe positiv: Job 0 bis Job 3 mit demselben Paket, nur lesend vor Job 3, genau die erwarteten Schreibaufrufe', () => {
  const e = kette(join(BASIS_DIR, 'positiv'), { quelle: ROOT, anker: ANKER });
  assert.match(e.basis, /^[0-9a-f]{40}$/);
  assert.match(e.auftrag, /^[0-9a-f]{64}$/);
  assert.match(e.paket, /^[0-9a-f]{64}$/);
  assert.equal(createHash('sha256').update(e.paketBytes).digest('hex'), e.paket);
  assert.deepEqual(pruefeAnfragen(e), []);
  // Muss-Treffer der Pruefung: Job 0 und 1a haben gelesen, Job 3 hat geschrieben.
  assert.ok(e.anfragen0.length >= 6 && e.anfragen1.length >= 6);
  assert.deepEqual(e.anfragen3.filter(a => a.methode !== 'GET').map(a => `${a.methode} ${a.pfad.replace('/repos/noah04091/agenten-probe/', '')}`), [...WRITES_OK]);
  assert.ok(e.anfragen3.every(a => a.host === 'api.github.com' && a.verboten === undefined));
  const zustand = JSON.parse(readFileSync(join(e.t3, 'a6-probe-github', 'zustand.json'), 'utf8'));
  const pr = zustand.pulls.at(-1);
  assert.equal(pr.draft, true);
  assert.equal(pr.head.ref, `wp/${ISSUE}-agent-${RUN_ID}-1`);
  // Gegenprobe der Anfragepruefung: ein fremder Host wird erkannt.
  assert.deepEqual(pruefeAnfragen({ ...e, anfragen0: [...e.anfragen0, { methode: 'GET', host: 'example.com', pfad: '/', token: 'ja' }] }), ['Anfrage an fremden Host oder ohne Token']);
});

test('Generalprobe negativ: jeder Fall scheitert genau an seinem Mechanismus', () => {
  assert.deepEqual(Object.keys(FAELLE).sort(), Object.keys(ERWARTET).filter(n => n !== 'NF2-abnahme-fachlich-falsch').sort());
  const ergebnisse = negativ(join(BASIS_DIR, 'negativ'), { quelle: ROOT, anker: ANKER });
  assert.equal(ergebnisse.length, Object.keys(ERWARTET).length);
  // Alle Faelle auf einmal vergleichen, damit eine Abweichung jeden betroffenen Fall zeigt.
  assert.deepEqual(Object.fromEntries(ergebnisse.map(x => [x.name, x.zusatz ? `${x.erhalten} (${x.zusatz})` : x.erhalten])), ERWARTET);

  for (const x of ergebnisse) {
    assert.equal(x.erhalten, ERWARTET[x.name], `${x.name}: erhalten ${x.erhalten}${x.zusatz ? `, ${x.zusatz}` : ''}`);
    assert.equal(x.erwartet, ERWARTET[x.name], `${x.name}: Erwartung im Harness abweichend`);
    assert.equal(x.ok, true, `${x.name}: ${x.zusatz ?? 'nicht ok'}`);
  }
});
