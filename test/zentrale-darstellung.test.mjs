// B1.1 Command Center: Darstellung. Maskierung und CSP (W5), veraltet und Abruf fehlgeschlagen (W8),
// Geheimnis-Filter vor dem Schreiben (W9).
globalThis.fetch = () => { throw new Error('W10: Netz in Zentrale-Tests verboten'); };

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CSP, VERALTET_MS, bereichZustand, geheimnisTreffer, link, maskiere, seite } from '../werkzeuge/zentrale/darstellung.mjs';
import { durchlauf } from '../werkzeuge/zentrale/zentrale.mjs';

const JETZT = Date.parse('2026-11-21T10:20:00Z');
const R = 'https://github.com/noah04091/agenten-probe';
const BOESE = Object.freeze(['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><a href=javascript:alert(1)>x</a>', "' onmouseover='alert(1)", '<svg/onload=alert(1)>']);

function modell({ titel = 'Titel', stand = JETZT, fehlschlag = null, teilFehler = null } = {}) {
  const bereich = extra => ({ stand, fehlschlag, teilFehler, ...extra });
  return {
    erzeugt: JETZT,
    bereiche: {
      auftraege: bereich({ eintraege: [{ nummer: 90, titel, url: `${R}/issues/90`, profil: titel, startlabel: true, freigaben: 1, abnahme: 'fehlt' }] }),
      laeufe: bereich({
        eintraege: [{ id: 1, url: `${R}/actions/runs/1`, start: JETZT, issue: { nummer: 90, url: 'javascript:alert(1)' }, jobs: [{ status: 'completed', conclusion: titel }, null, null, null],
          code: 'abnahme-exitcode', kosten: 0.0474278, runden: 6, pr: { nummer: 104, url: `${R}/pull/104`, zustand: 'gemergt', checks: [{ name: titel, ergebnis: 'success' }] } }],
        generalprobe: 3,
      }),
      freigaben: bereich({ eintraege: [{ laufId: 1, url: `${R}/actions/runs/1`, environment: titel, job: 3, restMinuten: 40 }] }),
      kosten: bereich({ monat: '2026-11', summe: 0.0743, mitKosten: 2, ohneKosten: 1, vollstaendig: true }),
      sitzungen: bereich({ eintraege: [{ name: titel, cwd: titel, start: JETZT, aktiv: JETZT, status: titel, id8: '0123abcd' }] }),
    },
  };
}

test('Maskierung (W5): alle fuenf Zeichen, jede boese Eingabe erscheint nur maskiert, kein Skript', () => {
  assert.equal(maskiere('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');

  for (const b of BOESE) {
    const html = seite(modell({ titel: b }), JETZT);
    assert.ok(html.includes(maskiere(b)), `Muss-Treffer: maskiert vorhanden: ${b}`);
    assert.ok(!html.includes(b), `roh enthalten: ${b}`);
    assert.ok(!/<script/i.test(html), 'Skript in der Seite');
    assert.ok(!/<[^>]*\son[a-z]+\s*=/i.test(html), 'Ereignis-Attribut in einem Tag');
    assert.ok(!/href="javascript:/i.test(html), 'javascript-Link');
  }
});

test('Seite: CSP, Neuladen, kein externer Inhalt, Links nur auf das eigene Repository', () => {
  const html = seite(modell(), JETZT);
  assert.equal(CSP, "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'");
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`));
  assert.ok(html.includes('<meta http-equiv="refresh" content="60">'));
  assert.ok(html.includes('@media (max-width:700px)'));
  assert.ok(!/<(script|iframe|object|embed|link|img)\b/i.test(html));
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
  assert.ok(hrefs.length >= 3, 'Muss-Treffer: Links vorhanden');
  assert.ok(hrefs.every(h => h.startsWith(`${R}/`)), hrefs.join(' '));
  assert.ok([...html.matchAll(/<a /g)].length === [...html.matchAll(/rel="noopener noreferrer"/g)].length);
  assert.equal(link('https://github.com/noah04091/agenten-probe-x/1', 'x'), 'x');
  assert.equal(link('https://github.com.evil.example/noah04091/agenten-probe/1', 'x'), 'x');
  assert.equal(link(`${R}/issues/1"onclick="x`, 'x'), 'x');
  // Fester lokaler Link auf die Sitzungsuebersicht nur, wenn im Modell angegeben.
  assert.ok(seite({ ...modell(), sitzungsUebersicht: 'file:///C:/Users/x/Documents/claude-werkzeuge/sitzungen.html' }, JETZT).includes('Sitzungsübersicht</a>'));
  assert.ok(!html.includes('Sitzungsübersicht'));
});

test('Seite: Werte und Texte (Fehlercode mit Klartext, Kosten, Frist mit Reserve, maßgeblich GitHub)', () => {
  const html = seite(modell(), JETZT);
  assert.ok(html.includes('abnahme-exitcode: Abnahme nicht bestanden.'));
  assert.ok(html.includes('0,047 $'));
  assert.ok(html.includes('noch 40 min, Job 3 braucht 2 min Reserve: praktisch noch 38 min (Stand 10:20 UTC)'));
  assert.ok(html.includes('Maßgeblich ist GitHub'));
  assert.ok(html.includes('Monat 2026-11 (UTC): 0,074 $'));
  const unv = modell();
  unv.bereiche.kosten.vollstaendig = false;
  assert.ok(seite(unv, JETZT).includes('mindestens 0,074 $ (unvollständig)'));
  // Kosten: "keine", wenn Claude nicht lief; "unbekannt" nur, wenn das Log nicht ladbar war. Jobs: "nicht gestartet".
  const ohne = modell();
  Object.assign(ohne.bereiche.laeufe.eintraege[0], { kosten: null, kostenOffen: false, jobs: [{ status: 'nicht-gestartet' }, null, null, null] });
  assert.ok(seite(ohne, JETZT).includes('<td>keine</td>') && seite(ohne, JETZT).includes('<td>nicht gestartet</td>'));
  ohne.bereiche.laeufe.eintraege[0].kostenOffen = true;
  assert.ok(!seite(ohne, JETZT).includes('<td>keine</td>'));
  const unbekannt = modell();
  unbekannt.bereiche.laeufe.eintraege[0].code = 'erfundener-code';
  assert.ok(seite(unbekannt, JETZT).includes('unbekannter Code') && !seite(unbekannt, JETZT).includes('erfundener-code'));
});

test('Veraltet und fehlgeschlagen (W8): nie alte Werte als aktuell', () => {
  assert.equal(bereichZustand({ stand: JETZT - VERALTET_MS }, JETZT), 'aktuell');
  assert.equal(bereichZustand({ stand: JETZT - VERALTET_MS - 1 }, JETZT), 'veraltet');
  assert.equal(bereichZustand({ stand: JETZT, fehlschlag: JETZT }, JETZT), 'fehlgeschlagen');
  assert.equal(bereichZustand({ stand: JETZT - 1000, fehlschlag: JETZT }, JETZT), 'fehlgeschlagen');
  assert.equal(bereichZustand({ stand: null, fehlschlag: null }, JETZT), 'leer');

  const alt = seite(modell({ stand: JETZT - 11 * 60 * 1000 }), JETZT);
  assert.equal((alt.match(/<section class="veraltet">/g) ?? []).length, 5);
  assert.ok(alt.includes('veraltet, Stand: 10:09 UTC'));
  assert.ok(!alt.includes('<p class="stand">'));

  const weg = seite(modell({ titel: 'WERT-DARF-NICHT-ERSCHEINEN', stand: JETZT - 60_000, fehlschlag: JETZT }), JETZT);
  assert.equal((weg.match(/Abruf fehlgeschlagen um 10:20 UTC/g) ?? []).length, 5);
  assert.ok(!weg.includes('WERT-DARF-NICHT-ERSCHEINEN'));
  assert.ok(!weg.includes('0,047'));

  const teil = seite(modell({ teilFehler: JETZT }), JETZT);
  assert.ok(teil.includes('Abruf fehlgeschlagen um 10:20 UTC (teilweise)'));
});

test('Geheimnis-Filter (W9): Seite mit Muster oder Token-Wert wird nicht geschrieben, Exitcode 1', async () => {
  const token = 'github_pat_TESTNURATTRAPPE_0000000000';
  assert.deepEqual(geheimnisTreffer('<p>sauber</p>', token), []);

  for (const [inhalt, name] of [['ghp_x', 'ghp_'], ['gho_x', 'gho_'], ['ghs_x', 'ghs_'], ['ghu_x', 'ghu_'], ['github_pat_x', 'github_pat_'], ['sk-ant-x', 'sk-ant'], ['-----BEGIN RSA', '-----BEGIN']]) {
    assert.ok(geheimnisTreffer(`<p>${inhalt}</p>`, token).includes(name), name);
  }

  assert.deepEqual(geheimnisTreffer('<p>TESTNURATTRAPPE_0000000000</p>', 'TESTNURATTRAPPE_0000000000'), ['token-wert']);

  // Durchlauf mit einem Issue-Titel, der ein Geheimnis-Muster enthaelt: keine Datei, Exitcode 1.
  let geschrieben = 0;
  const fsImpl = { existsSync: () => false, readFileSync: () => '{}', writeFileSync: () => { geschrieben += 1; }, renameSync: () => { geschrieben += 1; }, mkdirSync: () => {} };
  const leser = {
    holeJson: async p => (p === '/repos/noah04091/agenten-probe' ? { klasse: 'ok', daten: {} } : { klasse: 'unbekannt', grund: 'x' }),
    holeAlleSeiten: async p => (p.includes('state=open') ? { klasse: 'ok', vollstaendig: true, daten: [{ number: 5, title: 'enthaelt ghp_ABC', labels: [{ name: 'agent:js-text' }] }] } : { klasse: 'unbekannt', grund: 'x' }),
    holeLog: async () => ({ klasse: 'unbekannt' }),
  };
  const r = await durchlauf({ token, leser, jetzt: JETZT, fsImpl, ordner: 'Z', sitzungen: () => ({ ok: true, eintraege: [] }) });
  assert.equal(r.exitcode, 1);
  assert.match(r.meldung, /Geheimnis-Muster gefunden \(ghp_\)/);
  assert.equal(geschrieben, 0);
});
