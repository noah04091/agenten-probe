// B1.1 Command Center: Darstellung. Maskierung und CSP (W5), veraltet und Abruf fehlgeschlagen (W8),
// Geheimnis-Filter vor dem Schreiben (W9).
globalThis.fetch = () => { throw new Error('W10: Netz in Zentrale-Tests verboten'); };

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CSP, VERALTET_MS, bereichZustand, geheimnisTreffer, link, maskiere, notseite, seite } from '../werkzeuge/zentrale/darstellung.mjs';
import { fristenModell } from '../werkzeuge/zentrale/daten.mjs';
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
      kosten: bereich({ monat: '2026-11', summe: 0.0743, mitKosten: 2, belegtOhneKosten: 1, kostenUnbekannt: 0, ohneBeleg: 0, vollstaendig: true }),
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
  assert.equal(bereichZustand({ stand: JETZT - VERALTET_MS }, JETZT), 'geladen');
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

test('K3: Momentaufnahme mit Erzeugungszeit, Neuladen nur im Schleifenbetrieb, nach dem Ende kein Neuladen', () => {
  const REFRESH = '<meta http-equiv="refresh" content="60">';
  const einmal = seite(modell(), JETZT);
  assert.ok(einmal.includes('<strong>Momentaufnahme: erzeugt am 21.11.2026 um 10:20 UTC.</strong>'), 'Kennzeichnung fehlt');
  assert.ok(einmal.includes('Die Seite erneuert sich nicht von selbst.'));
  assert.ok(!einmal.includes(REFRESH), 'Neuladen ohne Schleife');
  assert.ok(!/http-equiv="refresh"/i.test(einmal));
  assert.ok(!/aktuell/i.test(einmal), 'die Seite behauptet Aktualitaet');
  assert.ok(einmal.includes('<title>Zentrale (Momentaufnahme 10:20 UTC)</title>'));

  const schleife = seite(modell(), JETZT, { schleife: true });
  assert.ok(schleife.includes(REFRESH), 'Muss-Treffer: Neuladen im Schleifenbetrieb');
  assert.ok(schleife.includes('Momentaufnahme: erzeugt am 21.11.2026 um 10:20 UTC.'));
  assert.ok(schleife.includes('eine neue Momentaufnahme ist bis 10:23 UTC fällig'));
  assert.ok(schleife.includes('läuft die Schleife nicht mehr und die Werte sind veraltet'));
  assert.ok(!/aktuell/i.test(schleife));

  const ende = seite(modell(), JETZT + 5 * 60_000, { schleife: true, beendet: { um: JETZT + 5 * 60_000, grund: 'Strg+C' } });
  assert.ok(!ende.includes(REFRESH), 'Neuladen nach dem Ende');
  assert.ok(ende.includes('Die Schleife wurde am 21.11.2026 um 10:25 UTC beendet (Strg+C). Diese Seite wird nicht mehr erneuert.'));
  assert.ok(ende.includes('Momentaufnahme: erzeugt am 21.11.2026 um 10:20 UTC.'));
  assert.ok(!ende.includes('fällig'));

  // CSP unveraendert, kein Skript in allen drei Formen.
  for (const h of [einmal, schleife, ende]) {
    assert.ok(h.includes(`content="${CSP}"`));
    assert.ok(!/<script/i.test(h));
  }
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

// B1.1a P1: Codes nur mit Namen. Ein Code aus BEKANNTE_CODES erscheint mit Namen und "keine Beschreibung hinterlegt",
// jeder andere bleibt "unbekannter Code" (siehe auch den unveraenderten Test oben mit erfundener-code).
test('B1.1a P1: bekannter Code ohne Klartext mit Namen, erfundene und manipulierte Codes weiter unbekannt', () => {
  const mit = code => {
    const m = modell();
    m.bereiche.laeufe.eintraege[0].code = code;
    return seite(m, JETZT);
  };

  for (const c of ['abnahme-git-struktur', 'transport-token', 'job-unbekannt']) {
    const html = mit(c);
    assert.ok(html.includes(`<td>${c} (keine Beschreibung hinterlegt)</td>`), c);
    assert.ok(!html.includes('unbekannter Code'), c);
  }

  // Codes mit Klartext bleiben wie bisher.
  assert.ok(mit('abnahme-exitcode').includes('<td>abnahme-exitcode: Abnahme nicht bestanden.</td>'));
  // Erfunden, aehnlich, Gross- und Kleinschreibung, Prototyp-Namen, Sonderzeichen: unbekannt, Name erscheint nie.
  for (const c of ['erfundener-code', 'transport-token2', 'transport-tokenx', 'xtransport-token', 'Transport-token', 'transport-token ', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '<b>transport-token</b>', 'mehrdeutig-x']) {
    const html = mit(c);
    assert.ok(html.includes('<td>unbekannter Code</td>'), c);
    assert.ok(!html.includes(`<td>${maskiere(c)}`), `${c}: Name erscheint als Fehler`);
    assert.ok(!html.includes('keine Beschreibung hinterlegt'), c);
  }

  // Mehrere Fehlerzeilen bleiben "mehrere Fehlercodes im Log", auch wenn jeder Code bekannt ist.
  assert.ok(mit('mehrdeutig').includes('<td>mehrere Fehlercodes im Log</td>'));
  // Die Spalte sagt, woher der Code stammt: aus dem Log, nicht bestaetigt.
  assert.ok(mit('transport-token').includes('<th>Fehler laut Log</th>'));
});

// B1.1a P2 bis P4: drei Zahlen, Hinweis ohne Kostenbeleg statt Abruffehler, Beschriftung.
test('B1.1a P2 bis P4: Kostenbereich mit drei Zahlen, Hinweis ohne Kostenbeleg und Beschriftung', () => {
  const kostenTeil = html => /<section class="[a-z]+"><h2>4 Kosten<\/h2>.*?<\/section>/.exec(html)[0];
  const mit = (werte, teilFehler = null) => {
    const m = modell();
    m.bereiche.kosten = { stand: JETZT, fehlschlag: null, teilFehler, monat: '2026-11', summe: 0.204, ...werte };
    return kostenTeil(seite(m, JETZT));
  };

  // November-Stand: 7 · 11 · 1, ein Lauf ohne Kostenbeleg, kein Abruffehler.
  const nov = mit({ mitKosten: 7, belegtOhneKosten: 11, kostenUnbekannt: 1, ohneBeleg: 1, vollstaendig: false });
  assert.ok(nov.includes('Monat 2026-11 (UTC): mindestens 0,204 $ (unvollständig), Läufe mit Kosten: 7, belegt ohne Kosten: 11, Kosten unbekannt: 1'));
  assert.ok(nov.includes('1 Lauf ohne Kostenbeleg, Monatssumme unvollständig.'));
  assert.ok(!nov.includes('Abruf fehlgeschlagen'));
  // P4: Beschriftung steht im Kostenbereich.
  assert.ok(nov.includes('Kosten der Agent-Aufträge (Workflow agent-auftrag.yml), nicht der Gesamtverbrauch des Anthropic-Workspace. Der steht in der Anthropic-Konsole.'));

  // Mehrzahl; vollstaendig ohne Hinweis; echter Abruffehler bleibt sichtbar.
  assert.ok(mit({ mitKosten: 1, belegtOhneKosten: 0, kostenUnbekannt: 3, ohneBeleg: 3, vollstaendig: false }).includes('3 Läufe ohne Kostenbeleg, Monatssumme unvollständig.'));
  const voll = mit({ mitKosten: 2, belegtOhneKosten: 1, kostenUnbekannt: 0, ohneBeleg: 0, vollstaendig: true });
  assert.ok(voll.includes('Monat 2026-11 (UTC): 0,204 $, Läufe mit Kosten: 2') && !voll.includes('ohne Kostenbeleg') && !voll.includes('mindestens'));
  const abruf = mit({ mitKosten: 7, belegtOhneKosten: 11, kostenUnbekannt: 1, ohneBeleg: 0, vollstaendig: false }, JETZT);
  assert.ok(abruf.includes('Abruf fehlgeschlagen um 10:20 UTC (teilweise)'));
  assert.ok(abruf.includes('mindestens 0,204 $ (unvollständig)') && !abruf.includes('ohne Kostenbeleg'));
  // Fehlende Zahlen erscheinen als "unbekannt", nie als 0.
  assert.ok(mit({ vollstaendig: false }).includes('Läufe mit Kosten: unbekannt, belegt ohne Kosten: unbekannt, Kosten unbekannt: unbekannt'));
});

// B1.3: Bereich "0 Fristen", Banner und Notseite.
const H = 60 * 60 * 1000;
const T = 24 * H;
const LESE = Date.parse('2026-12-21T21:04:30Z');
const fristModell = (jetzt, datei = { status: 'ok', fristen: {
  'bot-token': { name: 'Bot-Token noah04091-agent', ablauf: Date.parse('2026-12-22T11:26:44Z'), tagesgenau: false, eingetragenAm: Date.parse('2026-11-22T00:00:00Z') },
  'anthropic-schluessel': { name: 'Anthropic-Schlüssel github-testbot', ablauf: Date.parse('2027-01-31T00:00:00Z'), tagesgenau: true, eingetragenAm: Date.parse('2026-11-22T00:00:00Z') },
} }, lese = LESE) => ({ ...modell(), erzeugt: jetzt, fristen: fristenModell({ jetzt, leseToken: { ablauf: lese, gemeldetAm: jetzt }, datei }) });
const fristenTeil = html => /<section class="fristen">.*?<\/section>/.exec(html)[0];

test('B1.3 Darstellung: Texte je Stufe, Herkunft, Tagesgenauigkeit ohne Uhrzeit, Banner nur fuer Rot', () => {
  const zeile = (jetzt, n = 0) => /<tr class="frist-[a-z]+">.*?<\/tr>/g[Symbol.match](fristenTeil(seite(fristModell(jetzt), jetzt)))[n];
  const html = j => seite(fristModell(j), j);

  // ok, Hinweis, Warnung, dringend, abgelaufen (Lese-Token).
  assert.ok(zeile(LESE - 20 * T).includes('läuft am 21.12.2026 um 21:04 UTC ab (noch 20 Tage)</td>'));
  assert.ok(zeile(LESE - 20 * T).startsWith('<tr class="frist-ok">'));
  assert.ok(zeile(LESE - 10 * T).includes('läuft am 21.12.2026 um 21:04 UTC ab (noch 10 Tage), bald erneuern'));
  assert.ok(zeile(LESE - 10 * T).startsWith('<tr class="frist-gelb">'));
  assert.ok(!html(LESE - 10 * T).includes('class="banner"'), 'Hinweis ist gelb, kein Banner');
  assert.ok(zeile(LESE - 5 * T).includes('läuft am 21.12.2026 um 21:04 UTC ab (noch 5 Tage), jetzt erneuern'));
  assert.ok(zeile(LESE - 5 * T).startsWith('<tr class="frist-rot">'));
  assert.ok(html(LESE - 5 * T).includes('<div class="banner"><p><strong>Lese-Token der Zentrale:</strong> läuft am 21.12.2026 um 21:04 UTC ab (noch 5 Tage), jetzt erneuern. Neues Lese-Token auf GitHub anlegen'));
  assert.ok(zeile(LESE - 30 * H).includes('läuft in 30 Stunden ab (am 21.12.2026 um 21:04 UTC), jetzt erneuern'));
  assert.ok(zeile(LESE - 90 * 60 * 1000).includes('läuft in 1 Stunde ab'));
  assert.ok(zeile(LESE - 59 * 60 * 1000).includes('läuft in weniger als einer Stunde ab'));
  assert.ok(zeile(LESE + 1000).includes('abgelaufen seit 21.12.2026 um 21:04 UTC'));
  assert.ok(html(LESE + 1000).includes('class="banner"'));
  assert.ok(zeile(LESE - 20 * T).includes(`von GitHub gemeldet am ${String(new Date(LESE - 20 * T).getUTCDate()).padStart(2, '0')}.12.2026 um 21:04 UTC`));

  // Manuell: Herkunft, Tagesgenauigkeit ohne Uhrzeit, Pruefhinweis nach 45 Tagen.
  const j = Date.parse('2026-11-22T12:00:00Z');
  assert.ok(zeile(j, 1).includes('läuft am 22.12.2026 um 11:26 UTC ab (noch 29 Tage)'));
  assert.ok(zeile(j, 1).includes('manuell eingetragen am 22.11.2026, nicht von der Zentrale geprüft</td>'));
  assert.ok(zeile(j, 2).includes('läuft am 31.01.2027 ab (noch 69 Tage)'), zeile(j, 2));
  assert.ok(!/31\.01\.2027 um/.test(zeile(j, 2)), 'keine erfundene Uhrzeit');
  const spaet = Date.parse('2027-01-10T00:00:00Z');
  assert.ok(zeile(spaet, 2).includes('Eintrag vom 22.11.2026, bitte prüfen'));
  assert.ok(zeile(spaet, 2).includes('noch 21 Tage'));
  // Tagesgenau: ab 00:00 UTC des Ablauftags abgelaufen (vorsichtig).
  assert.ok(zeile(Date.parse('2027-01-31T00:00:00Z'), 2).includes('abgelaufen seit 31.01.2027<'));
});

test('B1.3 Darstellung: unbekannt nie als ok, ohne Fristenmodell alle drei unbekannt, Name maskiert, kein "aktuell"', () => {
  const j = Date.parse('2026-11-22T12:00:00Z');
  const ohne = seite({ ...modell(), erzeugt: j }, j);
  const f = fristenTeil(ohne);
  assert.equal((f.match(/<tr class="frist-unbekannt">/g) ?? []).length, 3);
  assert.equal((f.match(/Ablauf unbekannt: nicht ermittelt\./g) ?? []).length, 3);
  assert.ok(!f.includes('frist-ok') && !f.includes('noch '));

  const fehlt = fristenTeil(seite(fristModell(j, { status: 'fehlt' }), j));
  assert.equal((fehlt.match(/Ablauf unbekannt: keine manuellen Fristen \(fristen.json fehlt\)\./g) ?? []).length, 2);
  assert.equal((fehlt.match(/<tr class="frist-ok">/g) ?? []).length, 1, 'nur das belegte Lese-Token ist ok');
  const kaputt = fristenTeil(seite(fristModell(j, { status: 'ungueltig', grund: 'Zugang doppelt' }), j));
  assert.equal((kaputt.match(/Ablauf unbekannt: fristen.json ungültig: Zugang doppelt\./g) ?? []).length, 2);
  const ohneKopf = fristenTeil(seite(fristModell(j, { status: 'fehlt' }, null), j));
  assert.ok(ohneKopf.includes('Ablauf unbekannt: GitHub hat in der Startprüfung kein Ablaufdatum gemeldet.'));
  assert.ok(ohneKopf.includes('Quelle: Antwortkopf der Startprüfung bei GitHub'));
  assert.equal((ohneKopf.match(/<tr class="frist-unbekannt">/g) ?? []).length, 3);

  for (const b of BOESE) {
    const m = fristModell(j, { status: 'ok', fristen: { 'bot-token': { name: b, ablauf: LESE, tagesgenau: false, eingetragenAm: j } } });
    const h = seite(m, j);
    assert.ok(h.includes(maskiere(b)) && !h.includes(b), b);
  }

  for (const s of [seite(fristModell(j), j), seite(fristModell(LESE - T), LESE - T), ohne]) {
    assert.ok(!/aktuell/i.test(s), 'die Seite behauptet Aktualitaet');
    assert.ok(!/<script/i.test(s) && s.includes(`content="${CSP}"`));
  }
});

test('B1.3 Notseite: drei Faelle bei 401, Token-Datei, andere Fehler; ohne Daten, ohne Neuladen, ohne Skript', () => {
  const j = Date.parse('2026-12-22T09:00:00Z');
  const l = { ablauf: LESE, gemeldetAm: Date.parse('2026-12-01T10:00:00Z') };
  const a = notseite({ erzeugt: j, art: 'abgelehnt', letzteMeldung: l });
  assert.ok(a.includes('Das Lese-Token wird von GitHub abgelehnt (401). Es ist wahrscheinlich abgelaufen am 21.12.2026 um 21:04 UTC (laut letzter Meldung von GitHub am 01.12.2026 um 10:00 UTC).'));
  const b = notseite({ erzeugt: LESE - T, art: 'abgelehnt', letzteMeldung: l });
  assert.ok(b.includes('abgelehnt (401), obwohl es laut letzter Meldung von GitHub am 01.12.2026 um 10:00 UTC bis 21.12.2026 um 21:04 UTC gültig ist. Wurde es widerrufen oder geändert?'));
  assert.ok(!b.includes('abgelaufen'));
  // Genau zum Ablaufzeitpunkt gilt (a).
  assert.ok(notseite({ erzeugt: LESE, art: 'abgelehnt', letzteMeldung: l }).includes('wahrscheinlich abgelaufen am'));
  const c = notseite({ erzeugt: j, art: 'abgelehnt', letzteMeldung: null });
  assert.ok(c.includes('Das Lese-Token wird von GitHub abgelehnt (401). Ablauf unbekannt.') && !c.includes('abgelaufen'));
  // Unbrauchbare letzte Meldung zaehlt wie keine.
  assert.ok(notseite({ erzeugt: j, art: 'abgelehnt', letzteMeldung: { ablauf: 'x', gemeldetAm: 1 } }).includes('Ablauf unbekannt.'));
  const d = notseite({ erzeugt: j, art: 'token-datei', grund: 'Token fehlt', letzteMeldung: l });
  assert.ok(d.includes('Das Lese-Token kann nicht geladen werden: Token fehlt. Letzte Meldung von GitHub (am 01.12.2026 um 10:00 UTC): Ablauf 21.12.2026 um 21:04 UTC.'));
  const e = notseite({ erzeugt: j, art: 'start', grund: '<b>HTTP 500</b>', letzteMeldung: l });
  assert.ok(e.includes('fehlgeschlagen: &lt;b&gt;HTTP 500&lt;/b&gt;. Das ist keine Ablehnung der Anmeldung (401).') && !e.includes('<b>HTTP'));
  assert.ok(!/abgelaufen/i.test(e) && !e.includes('21.12.2026'), 'allgemeine Fehlerseite nennt keinen Ablauf');

  for (const s of [a, b, c, d, e]) {
    assert.ok(!/http-equiv="refresh"/.test(s) && !/<script/i.test(s) && s.includes(`content="${CSP}"`));
    assert.ok(s.includes('Notseite: erzeugt') && s.includes('Es werden keine GitHub-Daten angezeigt'));
    assert.ok(!s.includes('<table') && !s.includes('<a '), 'keine Daten, keine Links');
    assert.ok(!/aktuell/i.test(s));
    assert.deepEqual(geheimnisTreffer(s, 'github_pat_TESTNURATTRAPPE_0000000000'), []);
  }
});
