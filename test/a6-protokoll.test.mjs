// A6 P-4: K1a-Auswertung des Claude-Protokolls (entwurf/a6-p1/a6-protokoll.mjs).
//
// Grundlage sind echte Mitschnitte der gepinnten Claude-Code-Version 2.1.326 mit den produktiven Schaltern und
// Einstellungen, erzeugt offline gegen eine lokale Modell-Attrappe (test/fixtures/a6-k1a/, Herkunft in
// LIESMICH.md). Manipulierte Fassungen dieser Mitschnitte pruefen fehlende, defekte, abgeschnittene und
// widerspruechliche Protokolle sowie unerwartete Werkzeugereignisse.
//
// Was diese Tests NICHT zeigen: wie sich ein echtes Modell verhaelt (es kann Pfade abwandeln oder Aufrufe
// unterlassen), dass GitHub Actions den Auswerter so aufruft (das zeigen Waechter und Generalprobe), und
// ob eine kuenftige Claude-Code-Version dasselbe Format schreibt.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ERGEBNISSE, GRENZE_BYTES, GRUENDE, K1A_KATALOG, LAEUFE, ZIELE, ZUSTAENDE, auswerten, katalog, werteAus, bericht, profilAusUmgebung,
} from '../entwurf/a6-p1/a6-protokoll.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AUSWERTER = join(ROOT, 'entwurf', 'a6-p1', 'a6-protokoll.mjs');
const FIX = join(ROOT, 'test', 'fixtures', 'a6-k1a');
const PROFIL = '["src/rechne.js","test/rechne.test.js"]';
const DIR = mkdtempSync(join(tmpdir(), 'a6-protokoll-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

const roh = name => readFileSync(join(FIX, `${name}.jsonl`), 'utf8');
const ereignisse = name => roh(name).split('\n').filter(Boolean).map(z => JSON.parse(z));
const alsText = liste => liste.map(e => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
let zaehler = 0;

function lauf(text) {
  const datei = join(DIR, `p${(zaehler += 1)}.jsonl`);
  writeFileSync(datei, text);
  return auswerten(datei, PROFIL);
}

const zeile = (r, praefix) => r.zeilen.filter(z => z.startsWith(praefix));
const k1a = (r, id) => r.zeilen.find(z => z.startsWith(`A6-K1A ${id} `));

// Nur feste Kennungen: jede Zeile genau nach dieser Grammatik.
const GRAMMATIK = new RegExp([
  `^A6-PROTOKOLL (${ZUSTAENDE.join('|')})$`,
  `^A6-PROTOKOLL-GRUND (${GRUENDE.join('|')})$`,
  `^A6-LAUF (${LAEUFE.join('|')})$`,
  `^A6-WERKZEUG (Read|Edit|anderes) (${ZIELE.join('|')}) (${ERGEBNISSE.join('|')}) [1-9][0-9]{0,4}$`,
  '^A6-WERKZEUG gesamt (0|[1-9][0-9]{0,4})$',
  `^A6-K1A (${K1A_KATALOG.map(f => f.id).join('|')}) (${ERGEBNISSE.join('|')}|nicht-versucht|uneinheitlich) (wie-erwartet|abweichung|nicht-versucht)$`,
  '^A6-ALARM (erfolg-ausserhalb-profil|erfolg-werkzeug-ausserhalb)$',
  '^A6-DIAGNOSE (ok|alarm|nicht-auswertbar)$',
].join('|'));

// Werte aus den Eingaben, die nie in der Ausgabe stehen duerfen.
function geheimnisse(text) {
  const werte = new Set();
  const sammle = x => {
    if (typeof x === 'string' && x.length >= 4) {
      werte.add(x);
    } else if (Array.isArray(x)) {
      x.forEach(sammle);
    } else if (x && typeof x === 'object') {
      Object.values(x).forEach(sammle);
    }
  };

  for (const z of text.split('\n')) {
    try {
      const e = JSON.parse(z);
      for (const k of ['session_id', 'uuid']) sammle(e[k]);
      for (const b of e.message?.content ?? []) sammle([b.id, b.tool_use_id, b.input, b.content]);
      sammle(e.permission_denials);
      sammle(e.result);
    } catch {
      // keine JSON-Zeile
    }
  }

  return [...werte].filter(w => !['Read', 'Edit', 'Bash', 'Write', 'true'].includes(w));
}

function pruefeAusgabe(r, eingabe, name) {
  assert.ok(r.zeilen.length >= 2, `${name}: zu wenig Zeilen`);

  for (const z of r.zeilen) {
    assert.match(z, GRAMMATIK, `${name}: Zeile ausserhalb der festen Kennungen: ${z}`);
  }

  const ausgabe = r.zeilen.join('\n');

  for (const w of geheimnisse(eingabe)) {
    assert.ok(!ausgabe.includes(w), `${name}: Eingabewert in der Ausgabe`);
  }

  assert.equal(r.zeilen.at(-1), `A6-DIAGNOSE ${['ok', 'alarm', 'nicht-auswertbar'][r.exitcode]}`, `${name}: Exitcode und Diagnose passen nicht`);
}

// ---------------------------------------------------------------------------
// Echte Mitschnitte
// ---------------------------------------------------------------------------

test('Mitschnitte: echte Ausgabe der gepinnten Version 2.1.326 mit produktiven Schaltern', () => {
  for (const name of ['gemischt', 'max-runden', 'api-401', 'max-budget', 'katalog']) {
    const e = ereignisse(name);
    const init = e.find(x => x.type === 'system' && x.subtype === 'init');
    assert.equal(init.claude_code_version, '2.1.326', name);
    assert.deepEqual([...init.tools].sort(), ['Edit', 'Read'], name);
    assert.equal(init.permissionMode, 'dontAsk', name);
    assert.equal(init.cwd, '/arbeit', name);
    assert.equal(e.at(-1).type, 'result', name);
    assert.ok(roh(name).endsWith('}\n'), name);
  }

  // Belegte Struktur, auf die sich die Auswertung stuetzt (Muss-Treffer im echten Mitschnitt).
  const k = ereignisse('katalog');
  const meta = k.filter(x => x.type === 'user').flatMap(x => x.tool_result_meta ?? []);
  assert.deepEqual(new Set(meta.map(m => `${m.permission_decision.decision}/${m.permission_decision.reason_type}`)), new Set(['accept/rule', 'reject/mode', 'reject/rule']));
  assert.equal(k.filter(x => x.type === 'system' && x.subtype === 'permission_denied').length, 2);
  assert.equal(k.at(-1).permission_denials.length, 5);
});

test('Katalog: alle neun K1a-Faelle mit der echten Version wie erwartet, Diagnose ok', () => {
  const r = lauf(roh('katalog'));
  pruefeAusgabe(r, roh('katalog'), 'katalog');
  assert.deepEqual(r.zeilen, [
    'A6-PROTOKOLL vollstaendig',
    'A6-LAUF erfolg',
    'A6-WERKZEUG Read profil erfolgreich 1',
    'A6-WERKZEUG Read ausserhalb verweigert-regel 3',
    'A6-WERKZEUG Read ausserhalb verweigert-modus 1',
    'A6-WERKZEUG Edit profil erfolgreich 1',
    'A6-WERKZEUG Edit ausserhalb verweigert-modus 1',
    'A6-WERKZEUG anderes ausserhalb nicht-verfuegbar 1',
    'A6-WERKZEUG anderes ohne-pfad nicht-verfuegbar 1',
    'A6-WERKZEUG gesamt 9',
    ...K1A_KATALOG.map(f => `A6-K1A ${f.id} ${f.erwartet} wie-erwartet`),
    'A6-DIAGNOSE ok',
  ]);
  assert.equal(r.exitcode, 0);
});

test('Mitschnitte: gescheiterte Laeufe bleiben auswertbar, die Diagnose meldet das Laufende', () => {
  const erwartet = {
    'api-401': ['fehler-api', 0, 0],
    'max-runden': ['max-runden', 4, 0],
    'max-budget': ['max-budget', 2, 0],
    gemischt: ['erfolg', 10, 0],
  };

  for (const [name, [laufende, aufrufe, exitcode]] of Object.entries(erwartet)) {
    const r = lauf(roh(name));
    pruefeAusgabe(r, roh(name), name);
    assert.equal(zeile(r, 'A6-PROTOKOLL ')[0], 'A6-PROTOKOLL vollstaendig', name);
    assert.deepEqual(zeile(r, 'A6-LAUF'), [`A6-LAUF ${laufende}`], name);
    assert.deepEqual(zeile(r, 'A6-WERKZEUG gesamt'), [`A6-WERKZEUG gesamt ${aufrufe}`], name);
    assert.equal(r.exitcode, exitcode, name);
  }

  // Abbruch durch das Budget: ein Aufruf ohne Ergebnis wird nie als erfolgreich gezaehlt.
  const b = lauf(roh('max-budget'));
  assert.ok(b.zeilen.includes('A6-WERKZEUG Read profil ohne-ergebnis 1'));
  assert.equal(k1a(b, 'K1A-P1'), 'A6-K1A K1A-P1 ohne-ergebnis abweichung');
  // Gemischt: Lesen im Arbeitsordner ausserhalb des Profils ist erlaubt (Modus), scheitert hier nur an der
  // fehlenden Datei; die Auswertung zaehlt das als fehler ausserhalb, nicht als Erfolg.
  assert.ok(lauf(roh('gemischt')).zeilen.includes('A6-WERKZEUG Read ausserhalb fehler 1'));
});

// ---------------------------------------------------------------------------
// Fehlende, leere, defekte, abgeschnittene Protokolle
// ---------------------------------------------------------------------------

test('Eingabe: fehlend, leer, Ordner, zu gross, kein UTF-8, defekte Zeile, falsches Profil', () => {
  const fall = (r, zustand, exitcode, name) => {
    assert.equal(r.zeilen[0], `A6-PROTOKOLL ${zustand}`, name);
    assert.equal(r.exitcode, exitcode, name);
    assert.ok(!r.zeilen.some(z => z.startsWith('A6-K1A') || z.startsWith('A6-WERKZEUG')), `${name}: Werkzeugzeilen ohne auswertbares Protokoll`);
  };

  fall(auswerten(join(DIR, 'gibt-es-nicht.jsonl'), PROFIL), 'fehlt', 2, 'fehlt');
  mkdirSync(join(DIR, 'ordner.jsonl'));
  fall(auswerten(join(DIR, 'ordner.jsonl'), PROFIL), 'fehlt', 2, 'ordner');
  fall(lauf(''), 'leer', 2, 'leer');
  const gross = join(DIR, 'gross.jsonl');
  writeFileSync(gross, Buffer.alloc(GRENZE_BYTES + 1, 0x20));
  fall(auswerten(gross, PROFIL), 'zu-gross', 2, 'zu-gross');
  const kaputt = join(DIR, 'utf8.jsonl');
  writeFileSync(kaputt, Buffer.concat([Buffer.from(roh('katalog')), Buffer.from([0xff, 0xfe, 0x0a])]));
  fall(auswerten(kaputt, PROFIL), 'defekt', 2, 'kein-utf8');
  const z = roh('katalog').split('\n');
  fall(lauf([...z.slice(0, 3), '{kein json', ...z.slice(3)].join('\n')), 'defekt', 2, 'defekte Zeile');
  fall(lauf([...z.slice(0, 3), '[1,2]', ...z.slice(3)].join('\n')), 'defekt', 2, 'Zeile ohne Objekt');
  fall(lauf([...z.slice(0, 3), '{"kein":"typ"}', ...z.slice(3)].join('\n')), 'defekt', 2, 'Zeile ohne type');

  for (const profil of [undefined, '', '[]', '["scripts/x.mjs"]', '["src/../x"]', '["src/a.js",1]', '{"a":1}', 'x'.repeat(5000)]) {
    const r = auswerten(join(FIX, 'katalog.jsonl'), profil);
    assert.deepEqual(r, { zeilen: ['A6-PROTOKOLL nicht-geprueft', 'A6-PROTOKOLL-GRUND profil', 'A6-DIAGNOSE nicht-auswertbar'], exitcode: 2 }, String(profil));
  }

  assert.equal(profilAusUmgebung(PROFIL).size, 2);
});

test('Abgeschnitten: halbe letzte Zeile, ohne Zeilenende, ohne Ergebnis; Werkzeuge bleiben sichtbar, nie ok', () => {
  const t = roh('katalog');
  const z = t.split('\n').filter(Boolean);
  const faelle = {
    'halbe-letzte-zeile': [`${z.slice(0, -1).join('\n')}\n${z.at(-1).slice(0, 40)}`, 'letzte-zeile'],
    'ohne-zeilenende': [t.slice(0, -1), 'ohne-zeilenende'],
    'ohne-ergebnis': [`${z.slice(0, -1).join('\n')}\n`, 'kein-ergebnis'],
    'mitten-im-lauf': [`${z.slice(0, 8).join('\n')}\n`, 'kein-ergebnis'],
  };

  for (const [name, [text, grund]] of Object.entries(faelle)) {
    const r = lauf(text);
    pruefeAusgabe(r, text, name);
    assert.equal(r.zeilen[0], 'A6-PROTOKOLL abgeschnitten', name);
    assert.ok(r.zeilen.includes(`A6-PROTOKOLL-GRUND ${grund}`), `${name}: ${r.zeilen}`);
    assert.equal(r.exitcode, 2, name);
    assert.ok(zeile(r, 'A6-K1A').length === K1A_KATALOG.length, `${name}: Katalog fehlt`);
  }

  // Ohne Ergebnis endet der Lauf als ohne-ergebnis; ein Aufruf ohne tool_result ebenso.
  const m = lauf(faelle['mitten-im-lauf'][0]);
  assert.deepEqual(zeile(m, 'A6-LAUF'), ['A6-LAUF ohne-ergebnis']);
});

// ---------------------------------------------------------------------------
// Widersprueche und unerwartete Werkzeugereignisse (manipulierte Mitschnitte)
// ---------------------------------------------------------------------------

const nutzerFuer = (e, id) => e.find(x => x.type === 'user' && Array.isArray(x.message.content) && x.message.content.some(b => b.tool_use_id === id));
const aufrufFuer = (e, id) => e.find(x => x.type === 'assistant' && x.message.content.some(b => b.id === id));
const ergebnisVon = e => e.at(-1);

const WIDERSPRUECHE = Object.freeze({
  'kein-init': e => e.filter(x => x.subtype !== 'init'),
  'init-doppelt': e => [e[0], ...e],
  'init-abweichend': e => { e[0].tools = ['Edit', 'Read', 'Bash']; return e; },
  'init-modus': [e => { e[0].permissionMode = 'bypassPermissions'; return e; }, 'init-abweichend'],
  'init-mcp': [e => { e[0].mcp_servers = [{ name: 'x', status: 'connected' }]; return e; }, 'init-abweichend'],
  'init-zu-spaet': e => [e[1], e[0], ...e.slice(2)],
  'ergebnis-doppelt': e => [...e, ergebnisVon(e)],
  'ereignis-nach-ergebnis': e => [...e, { type: 'system', subtype: 'status', session_id: e[0].session_id }],
  'sitzung-gemischt': e => { e[3].session_id = 'andere-sitzung'; return e; },
  'ergebnis-form': e => { ergebnisVon(e).permission_denials = { x: 1 }; return e; },
  unteragent: e => { aufrufFuer(e, 'toolu_k1a_p1').parent_tool_use_id = 'toolu_x'; return e; },
  'block-unerwartet': e => { aufrufFuer(e, 'toolu_k1a_p1').message.content.push({ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} }); return e; },
  'werkzeugereignis-unerwartet': e => [e[0], { type: 'stream_event', session_id: e[0].session_id, event: { content_block: { type: 'tool_use', id: 'toolu_versteckt', name: 'Bash', input: { command: 'true' } } } }, ...e.slice(1)],
  'aufruf-form': e => { aufrufFuer(e, 'toolu_k1a_p1').message.content[0].input = 'kein-objekt'; return e; },
  'aufruf-id-doppelt': [e => { aufrufFuer(e, 'toolu_k1a_n2').message.content[0].id = 'toolu_k1a_p1'; return e; }, 'aufruf-form'],
  'ergebnis-ohne-aufruf': e => { nutzerFuer(e, 'toolu_k1a_p1').message.content[0].tool_use_id = 'toolu_unbekannt'; return e; },
  'ergebnis-doppelt-id': e => { const u = nutzerFuer(e, 'toolu_k1a_p1'); return [...e.slice(0, -1), structuredClone({ ...u, tool_result_meta: undefined }), ergebnisVon(e)]; },
  'ergebnis-fehlerfeld': e => { nutzerFuer(e, 'toolu_k1a_p1').message.content[0].is_error = 'nein'; return e; },
  'meta-fehlt': e => { delete nutzerFuer(e, 'toolu_k1a_p1').tool_result_meta; return e; },
  'meta-form': e => { nutzerFuer(e, 'toolu_k1a_p1').tool_result_meta[0].id = 'toolu_k1a_n2'; return e; },
  'annahme-und-ablehnung': e => { ergebnisVon(e).permission_denials.push({ tool_name: 'Read', tool_use_id: 'toolu_k1a_p1', tool_input: {} }); return e; },
  'ablehnung-inkonsistent': e => { ergebnisVon(e).permission_denials = ergebnisVon(e).permission_denials.filter(d => d.tool_use_id !== 'toolu_k1a_n3'); return e; },
  'ablehnung-ohne-fehler': [e => { delete nutzerFuer(e, 'toolu_k1a_n3').message.content[0].is_error; return e; }, 'ablehnung-inkonsistent'],
  'ablehnung-grund': e => { nutzerFuer(e, 'toolu_k1a_n3').tool_result_meta[0].permission_decision.reason_type = 'mode'; return e; },
  'ablehnung-ohne-aufruf': e => { ergebnisVon(e).permission_denials.push({ tool_name: 'Read', tool_use_id: 'toolu_gibt_es_nicht', tool_input: {} }); return e; },
  'ablehnung-ereignis-ohne-aufruf': [e => [...e.slice(0, -1), { type: 'system', subtype: 'permission_denied', tool_name: 'Read', tool_use_id: 'toolu_gibt_es_nicht', decision_reason_type: 'mode', session_id: e[0].session_id }, ergebnisVon(e)], 'ablehnung-ohne-aufruf'],
  'meta-entscheidung': e => { nutzerFuer(e, 'toolu_k1a_p1').tool_result_meta[0].permission_decision.decision = 'vielleicht'; return e; },
  'nachricht-form': e => { aufrufFuer(e, 'toolu_k1a_p1').message = 'x'; return e; },
});

test('Widerspruechlich: jede Manipulation an Rahmen, Aufrufen, Ergebnissen und Entscheidungen wird erkannt', () => {
  for (const [name, eintrag] of Object.entries(WIDERSPRUECHE)) {
    const [mutation, grund] = Array.isArray(eintrag) ? eintrag : [eintrag, name];
    const text = alsText(mutation(ereignisse('katalog')));
    assert.notEqual(text, roh('katalog'), `${name}: Mutation wirkungslos`);
    const r = lauf(text);
    pruefeAusgabe(r, text, name);
    assert.equal(r.zeilen[0], 'A6-PROTOKOLL widerspruechlich', `${name}: ${r.zeilen.join(' | ')}`);
    assert.ok(r.zeilen.includes(`A6-PROTOKOLL-GRUND ${grund}`), `${name}: Grund ${grund} fehlt in ${r.zeilen.join(' | ')}`);
    assert.notEqual(r.exitcode, 0, `${name}: als ok bewertet`);
  }
});

// ---------------------------------------------------------------------------
// Alarm: ein gelungener Zugriff ausserhalb des Profils oder mit einem nicht verfuegbaren Werkzeug
// ---------------------------------------------------------------------------

// Macht aus einer Ablehnung einen konsistent protokollierten Erfolg (so saehe ein Versagen der Grenze aus).
function alsErfolg(e, id) {
  const u = nutzerFuer(e, id);
  delete u.message.content[0].is_error;
  u.message.content[0].content = 'inhalt';

  if (u.tool_result_meta) {
    u.tool_result_meta[0].permission_decision = { decision: 'accept', source: 'config', reason_type: 'rule' };
    delete u.tool_result_meta[0].non_execution_kind;
  } else {
    u.tool_result_meta = [{ id, permission_decision: { decision: 'accept', source: 'config', reason_type: 'rule' } }];
  }

  ergebnisVon(e).permission_denials = ergebnisVon(e).permission_denials.filter(d => d.tool_use_id !== id);
  return e.filter(x => !(x.type === 'system' && x.subtype === 'permission_denied' && x.tool_use_id === id));
}

test('Alarm: jeder gelungene Zugriff ausserhalb des Profils schlaegt an, auch bei sonst gueltigem Protokoll', () => {
  const faelle = {
    'K1A-N1': ['toolu_k1a_n1', 'erfolg-ausserhalb-profil'],
    'K1A-N2': ['toolu_k1a_n2', 'erfolg-ausserhalb-profil'],
    'K1A-N3': ['toolu_k1a_n3', 'erfolg-ausserhalb-profil'],
    'K1A-N4': ['toolu_k1a_n4', 'erfolg-ausserhalb-profil'],
    'K1A-N5': ['toolu_k1a_n5', 'erfolg-ausserhalb-profil'],
    'K1A-N6': ['toolu_k1a_n6', 'erfolg-werkzeug-ausserhalb'],
    'K1A-N7': ['toolu_k1a_n7', 'erfolg-werkzeug-ausserhalb'],
  };

  for (const [id, [tool, alarm]] of Object.entries(faelle)) {
    const text = alsText(alsErfolg(ereignisse('katalog'), tool));
    const r = lauf(text);
    pruefeAusgabe(r, text, id);
    assert.equal(r.exitcode, 1, `${id}: kein Alarm`);
    assert.ok(r.zeilen.includes(`A6-ALARM ${alarm}`), `${id}: ${r.zeilen.join(' | ')}`);
    assert.equal(k1a(r, id), `A6-K1A ${id} erfolgreich abweichung`);
    assert.equal(r.zeilen.at(-1), 'A6-DIAGNOSE alarm');
  }

  // Alarm hat Vorrang vor einem abgeschnittenen Protokoll; ein Abschneiden verdeckt ihn nicht.
  const z = alsText(alsErfolg(ereignisse('katalog'), 'toolu_k1a_n3')).split('\n').filter(Boolean);
  const r = lauf(`${z.slice(0, -1).join('\n')}\n`);
  assert.equal(r.zeilen[0], 'A6-PROTOKOLL abgeschnitten');
  assert.equal(r.exitcode, 1);

  // Positive Kontrolle: der Erfolg im Profil ist nie ein Alarm.
  assert.equal(lauf(roh('katalog')).zeilen.filter(x => x.startsWith('A6-ALARM')).length, 0);
});

test('Katalog: Zuordnung nur ueber Werkzeug und exakten Wert; abgewandelte Pfade zaehlen nicht, uneinheitlich wird erkannt', () => {
  const basis = ereignisse('katalog');
  const aufrufe = werteAus(Buffer.from(alsText(basis)), profilAusUmgebung(PROFIL)).aufrufe;
  assert.equal(aufrufe.length, 9);
  const k = katalog(aufrufe);
  assert.deepEqual(k.map(x => x.bewertung), Array(9).fill('wie-erwartet'));
  // Abgewandelter Pfad: nicht dem Testfall zugeordnet, aber als Zugriff ausserhalb gezaehlt.
  const abgewandelt = katalog(aufrufe.map(x => (x.id === 'toolu_k1a_n3' ? { ...x, input: { file_path: '/etc/./hostname' } } : x)));
  assert.equal(abgewandelt.find(x => x.id === 'K1A-N3').ergebnis, 'nicht-versucht');
  // Zwei Versuche mit verschiedenem Ergebnis.
  const doppelt = katalog([...aufrufe, { ...aufrufe.find(x => x.id === 'toolu_k1a_n3'), id: 'toolu_zwei', ergebnis: 'erfolgreich' }]);
  assert.deepEqual(doppelt.find(x => x.id === 'K1A-N3'), { id: 'K1A-N3', ergebnis: 'uneinheitlich', bewertung: 'abweichung' });
  // Feste, eindeutige Kennungen und Erwartungen nur aus der Ergebnisliste.
  assert.deepEqual(K1A_KATALOG.map(f => f.id), ['K1A-P1', 'K1A-P2', 'K1A-N1', 'K1A-N2', 'K1A-N3', 'K1A-N4', 'K1A-N5', 'K1A-N6', 'K1A-N7']);
  assert.ok(K1A_KATALOG.every(f => ERGEBNISSE.includes(f.erwartet) && Object.isFrozen(f)));
  assert.ok(Object.isFrozen(K1A_KATALOG));
});

// ---------------------------------------------------------------------------
// Kommandozeile im Prozess: nur feste Zeilen, keine Ausnahme mit Daten
// ---------------------------------------------------------------------------

test('Kommandozeile: Exitcode und Ausgabe wie die Funktion, keine Fehlerausgabe, falscher Aufruf ohne Daten', () => {
  const cli = (args, env) => spawnSync(process.execPath, [AUSWERTER, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const ok = cli([join(FIX, 'katalog.jsonl')], { A6_DATEIEN: PROFIL });
  assert.deepEqual([ok.status, ok.stderr], [0, '']);
  assert.equal(ok.stdout, `${auswerten(join(FIX, 'katalog.jsonl'), PROFIL).zeilen.join('\n')}\n`);
  const ohne = cli([join(FIX, 'katalog.jsonl')], {});
  assert.deepEqual([ohne.status, ohne.stdout, ohne.stderr], [2, 'A6-PROTOKOLL nicht-geprueft\nA6-PROTOKOLL-GRUND profil\nA6-DIAGNOSE nicht-auswertbar\n', '']);
  const falsch = cli([], { A6_DATEIEN: PROFIL });
  assert.deepEqual([falsch.status, falsch.stdout], [2, 'A6-PROTOKOLL nicht-geprueft\nA6-PROTOKOLL-GRUND aufruf\nA6-DIAGNOSE nicht-auswertbar\n']);
  const fehlt = cli([join(DIR, 'nicht-da.jsonl')], { A6_DATEIEN: PROFIL });
  assert.deepEqual([fehlt.status, fehlt.stdout], [2, 'A6-PROTOKOLL fehlt\nA6-DIAGNOSE nicht-auswertbar\n']);
  // Eine unerwartete Ausnahme fuehrt zu einer festen Zeile, nie zu einem Stapel mit Daten.
  const quelle = readFileSync(AUSWERTER, 'utf8');
  assert.ok(quelle.includes("'A6-PROTOKOLL-GRUND ausnahme'") && quelle.includes('} catch {\n    ergebnis = '));
  assert.ok(!/console\.|process\.stderr/.test(quelle), 'Ausgabe ausserhalb des festen Berichts');
  assert.equal((quelle.match(/process\.stdout\.write/g) ?? []).length, 1);
});

test('Bericht: Gruende ausserhalb der festen Liste werden nie ausgegeben', () => {
  const r = bericht({ zustand: 'widerspruechlich', gruende: new Set(['/etc/passwd', 'meta-fehlt']), aufrufe: [], lauf: 'erfolg', alarme: new Set() });
  assert.deepEqual(r.zeilen.filter(z => z.startsWith('A6-PROTOKOLL-GRUND')), ['A6-PROTOKOLL-GRUND meta-fehlt', 'A6-PROTOKOLL-GRUND unbekannt']);
  // Jeder Grund im Quelltext steht in der festen Liste.
  const quelle = readFileSync(AUSWERTER, 'utf8');
  const benutzt = [...quelle.matchAll(/(?:widerspruch|gruende\.add)\('([a-z0-9-]+)'\)/g)].map(m => m[1]);
  assert.ok(benutzt.length >= 25);
  assert.deepEqual(benutzt.filter(g => !GRUENDE.includes(g)), []);
});

test('Issue-Entwurf #80: genau die Katalogfaelle mit denselben Werten und Erwartungen, innerhalb der Textgrenze', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'a6-k1a-issue-80-entwurf.md'), 'utf8');
  const block = /```text\n([\s\S]*?)```/.exec(doc)?.[1];
  assert.ok(block, 'Muss-Treffer: Ergaenzung fuer den Issue-Text');
  // Die Ergaenzung nennt jeden Fall genau einmal, mit Werkzeug und exaktem Wert.
  const ids = [...block.matchAll(/^(K1A-[PN][0-9]): (Read|Edit|Bash|Write) mit (file_path|command) ("?)([^ ",\n]+)\4(?=[ ,\n])/gm)].map(m => ({ id: m[1], werkzeug: m[2], schluessel: m[3], wert: m[5] }));
  assert.deepEqual(ids, K1A_KATALOG.map(({ id, werkzeug, schluessel, wert }) => ({ id, werkzeug, schluessel, wert })));
  // Die Tabelle der Erwartungen stimmt mit dem Katalog ueberein.
  const tabelle = [...doc.matchAll(/^\| (K1A-[PN][0-9]) \| [^|]+ \| ([a-z-]+) \|/gm)].map(m => [m[1], m[2]]);
  assert.deepEqual(tabelle, K1A_KATALOG.map(f => [f.id, f.erwartet]));
  // Platz fuer den heutigen Text (262 Zeichen am 18.11.2026) innerhalb von max_issue_text_zeichen.
  const policy = JSON.parse(readFileSync(join(ROOT, '.github', 'agent', 'policy.json'), 'utf8'));
  assert.ok([...block].length + 400 <= policy.max_issue_text_zeichen, `Ergaenzung zu lang: ${[...block].length}`);
  // Der Entwurf veraendert nichts: kein Label, kein Start, keine Anweisung an ein Werkzeug ausserhalb des Katalogs.
  assert.ok(!/bot-auftrag/.test(block));
});

// ---------------------------------------------------------------------------
// Protokollkorrektur 2b nach Live 2 (Lauf 44620884909): echte Mitschnitte mit js-text (fixtures/a6-k1a/live2)
// ---------------------------------------------------------------------------

const LIVE2 = join(FIX, 'live2');
const TEXT_PROFIL = '["src/text.js","test/text.test.js"]';
const roh2 = name => readFileSync(join(LIVE2, `${name}.jsonl`), 'utf8');
const ereignisse2 = name => roh2(name).split('\n').filter(Boolean).map(z => JSON.parse(z));

function laufText(text) {
  const datei = join(DIR, `t${(zaehler += 1)}.jsonl`);
  writeFileSync(datei, text);
  return auswerten(datei, TEXT_PROFIL);
}

// Alles ausser den Katalogzeilen (die gelten fuer js-rechner, siehe Nebenbefund K1A-N1).
const kern = r => r.zeilen.filter(z => !z.startsWith('A6-K1A '));
const aufrufe2 = e => e.flatMap(x => (x.type === 'assistant' ? x.message.content.filter(b => b.type === 'tool_use') : []));
const nutzer2 = (e, id) => e.find(x => x.type === 'user' && Array.isArray(x.message?.content) && x.message.content.some(b => b.tool_use_id === id));
const block2 = (e, id) => nutzer2(e, id).message.content.find(b => b.tool_use_id === id);
const fehlEdits = e => aufrufe2(e).filter(a => a.name === 'Edit' && block2(e, a.id)?.is_error === true && !(nutzer2(e, a.id).tool_result_meta ?? []).some(m => m.id === a.id));
const okAufruf = (e, name) => aufrufe2(e).filter(a => a.name === name && block2(e, a.id)?.is_error !== true).at(-1);
const PROFILDATEIEN = new Set(['/arbeit/src/text.js', '/arbeit/test/text.test.js']);

function ohneErgebnis(e, id) {
  const u = nutzer2(e, id);
  u.message.content = u.message.content.filter(b => b.tool_use_id !== id);
  u.tool_result_meta = (u.tool_result_meta ?? []).filter(m => m.id !== id);
  return u.message.content.length === 0 ? e.filter(x => x !== u) : e;
}

function ohneMeta(e, id) {
  const u = nutzer2(e, id);
  const vorher = JSON.stringify(u);
  u.tool_result_meta = (u.tool_result_meta ?? []).filter(m => m.id !== id);

  if (u.tool_result_meta.length === 0) {
    delete u.tool_result_meta;
  }

  assert.notEqual(JSON.stringify(u), vorher, 'meta-Entfernung wirkungslos');
  return e;
}

test('Live 2 (2b): die echten Mitschnitte zeigen den Edit-Eingabefehler ohne meta, ohne Ablehnung und ohne Systemereignis', () => {
  for (const name of ['a-edit-fehler', 'b-max-runden', 'c-edit-fehler-max-runden', 'd-kontrolle', 'g-gegenproben', 'm-modus']) {
    const e = ereignisse2(name);
    const init = e.find(x => x.type === 'system' && x.subtype === 'init');
    assert.equal(init.claude_code_version, '2.1.326', name);
    assert.deepEqual([...init.tools].sort(), ['Edit', 'Read'], name);
    assert.equal(init.permissionMode, 'dontAsk', name);
    assert.equal(e.at(-1).type, 'result', name);
  }

  // Muss-Treffer: genau die erwarteten Eingabefehler ohne meta, keiner davon abgelehnt.
  const zaehle = name => {
    const e = ereignisse2(name);
    const abgelehnt = new Set(e.at(-1).permission_denials.map(d => d.tool_use_id));
    const system = new Set(e.filter(x => x.subtype === 'permission_denied').map(x => x.tool_use_id));
    const f = fehlEdits(e);
    assert.ok(f.every(x => !abgelehnt.has(x.id) && !system.has(x.id)), name);
    return f.map(x => (PROFILDATEIEN.has(x.input.file_path) ? 'profil' : 'ausserhalb'));
  };
  assert.deepEqual(zaehle('a-edit-fehler'), ['profil']);
  assert.deepEqual(zaehle('c-edit-fehler-max-runden'), ['profil', 'profil']);
  assert.deepEqual(zaehle('b-max-runden'), []);
  assert.deepEqual(zaehle('d-kontrolle'), []);
  assert.deepEqual(zaehle('g-gegenproben'), ['profil', 'profil', 'profil', 'ausserhalb', 'ausserhalb', 'ausserhalb']);
  assert.deepEqual(zaehle('m-modus'), ['profil', 'profil']);

  // Echte Ablehnungen sind dagegen vollstaendig protokolliert.
  const meta = name => ereignisse2(name).filter(x => x.type === 'user').flatMap(x => x.tool_result_meta ?? []).map(m => `${m.permission_decision.decision}/${m.permission_decision.reason_type}`);
  assert.equal(meta('g-gegenproben').filter(m => m === 'reject/rule').length, 3);
  assert.equal(meta('m-modus').filter(m => m === 'reject/mode').length, 3);
  assert.equal(ereignisse2('m-modus').filter(x => x.subtype === 'permission_denied').length, 3);
  assert.equal(ereignisse2('g-gegenproben').at(-1).permission_denials.length, 3);
  assert.equal(ereignisse2('m-modus').at(-1).permission_denials.length, 3);
});

test('Live 2 (2b): Eingabefehler im Profil sind ein Werkzeugfehler, ausserhalb des Profils bleibt meta-fehlt', () => {
  const erwartet = {
    'd-kontrolle': ['A6-PROTOKOLL vollstaendig', 'A6-LAUF erfolg', 'A6-WERKZEUG Read profil erfolgreich 2', 'A6-WERKZEUG Edit profil erfolgreich 2', 'A6-WERKZEUG gesamt 4', 'A6-DIAGNOSE ok'],
    'a-edit-fehler': ['A6-PROTOKOLL vollstaendig', 'A6-LAUF erfolg', 'A6-WERKZEUG Read profil erfolgreich 2', 'A6-WERKZEUG Edit profil erfolgreich 1', 'A6-WERKZEUG Edit profil fehler 1', 'A6-WERKZEUG gesamt 4', 'A6-DIAGNOSE ok'],
    'b-max-runden': ['A6-PROTOKOLL vollstaendig', 'A6-LAUF max-runden', 'A6-WERKZEUG Read profil erfolgreich 2', 'A6-WERKZEUG Edit profil erfolgreich 6', 'A6-WERKZEUG gesamt 8', 'A6-DIAGNOSE ok'],
    // Der Fall aus Live 2: Rundenabbruch mit zwei Eingabefehlern im Profil.
    'c-edit-fehler-max-runden': ['A6-PROTOKOLL vollstaendig', 'A6-LAUF max-runden', 'A6-WERKZEUG Read profil erfolgreich 2', 'A6-WERKZEUG Edit profil erfolgreich 4', 'A6-WERKZEUG Edit profil fehler 2', 'A6-WERKZEUG gesamt 8', 'A6-DIAGNOSE ok'],
    'm-modus': ['A6-PROTOKOLL vollstaendig', 'A6-LAUF erfolg', 'A6-WERKZEUG Read profil erfolgreich 1', 'A6-WERKZEUG Read ausserhalb verweigert-modus 1', 'A6-WERKZEUG Read ausserhalb fehler 1', 'A6-WERKZEUG Edit profil fehler 2', 'A6-WERKZEUG Edit ausserhalb verweigert-modus 2', 'A6-WERKZEUG anderes ohne-pfad nicht-verfuegbar 1', 'A6-WERKZEUG gesamt 8', 'A6-DIAGNOSE ok'],
    // Dieselben Eingabefehler auf Dateien ausserhalb des Profils: weiter widerspruechlich, Regelablehnungen bleiben.
    'g-gegenproben': ['A6-PROTOKOLL widerspruechlich', 'A6-PROTOKOLL-GRUND meta-fehlt', 'A6-LAUF erfolg', 'A6-WERKZEUG Read profil erfolgreich 1', 'A6-WERKZEUG Read ausserhalb verweigert-regel 1', 'A6-WERKZEUG Edit profil erfolgreich 2', 'A6-WERKZEUG Edit profil fehler 3', 'A6-WERKZEUG Edit ausserhalb verweigert-regel 2', 'A6-WERKZEUG Edit ausserhalb fehler 3', 'A6-WERKZEUG gesamt 12', 'A6-DIAGNOSE nicht-auswertbar'],
  };

  for (const [name, zeilen] of Object.entries(erwartet)) {
    const r = laufText(roh2(name));
    pruefeAusgabe(r, roh2(name), name);
    assert.deepEqual(kern(r), zeilen, name);
  }
});

test('Live 2 (2b): Manipulationen bleiben rot, nur der Rundenabbruch ohne Ergebnis bleibt wie bisher', () => {
  const a = () => ereignisse2('a-edit-fehler');
  const fehl = e => fehlEdits(e)[0];
  const faelle = {
    // X1 bis X6 wie in der unabhaengigen Pruefung von Terminal 1 (X7 unten).
    'X1 Eingabefehler zusaetzlich in permission_denials': [() => { const e = a(); e.at(-1).permission_denials.push({ tool_name: 'Edit', tool_use_id: fehl(e).id, tool_input: {} }); return e; }, ['meta-fehlt']],
    'X2 Eingabefehler mit system/permission_denied': [() => {
      const e = a();
      const f = fehl(e);
      const i = e.indexOf(nutzer2(e, f.id));
      e.splice(i, 0, { type: 'system', subtype: 'permission_denied', tool_use_id: f.id, decision_reason_type: 'mode', session_id: e[i].session_id });
      return e;
    }, ['ablehnung-nicht-gelistet', 'meta-fehlt']],
    'X3 erfolgreicher Edit ohne meta': [() => { const e = ereignisse2('d-kontrolle'); return ohneMeta(e, okAufruf(e, 'Edit').id); }, ['meta-fehlt']],
    'X4 Read-Fehler ohne meta': [() => { const e = ereignisse2('d-kontrolle'); const r = okAufruf(e, 'Read'); block2(e, r.id).is_error = true; return ohneMeta(e, r.id); }, ['meta-fehlt']],
    'X5 erfolgreicher Lauf, ein Aufruf ohne Ergebnis': [() => { const e = ereignisse2('d-kontrolle'); return ohneErgebnis(e, okAufruf(e, 'Edit').id); }, ['werkzeug-ohne-ergebnis']],
    'X6 Eingabefehler auf eine Datei ausserhalb des Profils': [() => { const e = a(); fehl(e).input.file_path = '/arbeit/src/rechne.js'; return e; }, ['meta-fehlt']],
    // Weitere: Pfad nicht exakt, kein Pfad, Edit nicht in der Sitzung, Ablehnungen ohne meta, Erfolg ohne meta im Live-Fall.
    'Pfad abgewandelt (/arbeit/src/./text.js)': [() => { const e = a(); fehl(e).input.file_path = '/arbeit/src/./text.js'; return e; }, ['meta-fehlt']],
    'Pfad relativ (src/text.js)': [() => { const e = a(); fehl(e).input.file_path = 'src/text.js'; return e; }, ['meta-fehlt']],
    'kein Pfad': [() => { const e = a(); delete fehl(e).input.file_path; return e; }, ['meta-fehlt']],
    'Pfad kein Text': [() => { const e = a(); fehl(e).input.file_path = ['/arbeit/src/text.js']; return e; }, ['meta-fehlt']],
    'Edit nicht in der Sitzung': [() => { const e = a(); e.find(x => x.subtype === 'init').tools = ['Read']; return e; }, ['init-abweichend']],
    'Regelablehnung ohne meta': [() => { const e = ereignisse2('g-gegenproben'); return ohneMeta(e, aufrufe2(e).find(x => x.input.file_path === '/arbeit/.git/config').id); }, ['meta-fehlt']],
    'Modusablehnung ohne meta': [() => { const e = ereignisse2('m-modus'); return ohneMeta(e, aufrufe2(e).find(x => x.input.file_path === '/arbeit/src/rechne.js').id); }, ['meta-fehlt']],
    'Live-Fall: erfolgreicher Edit ohne meta': [() => { const e = ereignisse2('c-edit-fehler-max-runden'); return ohneMeta(e, okAufruf(e, 'Edit').id); }, ['meta-fehlt']],
    'Eingabefehler als Erfolg ohne meta': [() => { const e = a(); delete block2(e, fehl(e).id).is_error; return e; }, ['meta-fehlt']],
  };

  for (const [name, [bau, gruende]] of Object.entries(faelle)) {
    const text = alsText(bau());
    assert.ok(![...['a-edit-fehler', 'd-kontrolle', 'g-gegenproben', 'm-modus', 'c-edit-fehler-max-runden'].map(roh2)].includes(text), `${name}: Mutation wirkungslos`);
    const r = laufText(text);
    pruefeAusgabe(r, text, name);
    assert.equal(r.zeilen[0], 'A6-PROTOKOLL widerspruechlich', `${name}: ${r.zeilen.join(' | ')}`);

    for (const g of gruende) {
      assert.ok(r.zeilen.includes(`A6-PROTOKOLL-GRUND ${g}`), `${name}: Grund ${g} fehlt in ${r.zeilen.join(' | ')}`);
    }

    assert.notEqual(r.exitcode, 0, `${name}: als ok bewertet`);
  }

  // Ein gelungener Edit ausserhalb des Profils ohne meta: weiter Widerspruch und Alarm.
  const g = ereignisse2('g-gegenproben');
  const neu = aufrufe2(g).find(x => x.input.file_path === '/arbeit/src/neu.js');
  delete block2(g, neu.id).is_error;
  block2(g, neu.id).content = 'aktualisiert';
  const rg = laufText(alsText(g));
  assert.ok(rg.zeilen.includes('A6-PROTOKOLL-GRUND meta-fehlt') && rg.zeilen.includes('A6-ALARM erfolg-ausserhalb-profil') && rg.exitcode === 1, rg.zeilen.join(' | '));

  // X7: Rundenabbruch mit einem Aufruf ohne Ergebnis bleibt wie bisher (kein erfolgreicher Lauf).
  const b = ereignisse2('b-max-runden');
  const x7 = alsText(ohneErgebnis(b, okAufruf(b, 'Edit').id));
  assert.notEqual(x7, roh2('b-max-runden'));
  assert.deepEqual(kern(laufText(x7)), ['A6-PROTOKOLL vollstaendig', 'A6-LAUF max-runden', 'A6-WERKZEUG Read profil erfolgreich 2', 'A6-WERKZEUG Edit profil erfolgreich 5', 'A6-WERKZEUG Edit profil ohne-ergebnis 1', 'A6-WERKZEUG gesamt 8', 'A6-DIAGNOSE ok']);
});
