// B1.1 Command Center: Echt-Proben gegen GitHub. Nur lesend, nur von Hand gestartet, nicht in npm test.
//
//   node werkzeuge/zentrale/echtprobe.mjs
//
// Braucht Noahs Lese-Token in %USERPROFILE%\.zentrale\lese-token und daneben den Sollwert in echtprobe-soll.json
// (B1.3a, siehe LIESMICH). Gibt nur feste Kennungen, Zahlen und Codes aus, nie den Token-Wert oder Logtext. Eine Schreibprobe gibt es in B1.1 nicht (GO vom 21.11.2026); --schreibprobe wird
// abgelehnt.
//
// Zwei Teile, beide mit derselben Abruf-Logik wie die Zentrale (sammle):
//   1. Historischer Teil: sammle() mit dem festen Zeitpunkt REFERENZ_JETZT (Ende November 2026) und einem Leser, der
//      die Issue-Laufliste serverseitig auf 2026-10-31 bis 2026-11-20 begrenzt. Spaetere Laeufe kommen damit gar nicht
//      erst an. Geprueft werden Live 2, NF2, NF3 gegen SOLL und der November gegen MONAT_SOLL: belegte Summe, Zahl der
//      Kostenlaeufe und genau die bekannten unbelegten Laeufe.
//   2. Laufender Teil: sammle() mit der echten Uhrzeit. Der laufende Monat muss belegt vollstaendig sein; erlaubt ist
//      nur ein unbelegter Lauf, der als historischer Sonderfall in MONAT_SOLL steht und in diesen Monat faellt.
//
// Exitcode 0 nur, wenn jede Probe stimmt und die Daten vollstaendig sind. Jede Abweichung, jeder fehlende Lauf, jeder
// zusaetzliche unbelegte Lauf, jeder Teilfehler und jede falsche Summe ergibt Exitcode 1.

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { geheimnisTreffer } from './darstellung.mjs';
import { REPO, monat } from './daten.mjs';
import { erzeugeLeser } from './github-lesen.mjs';
import { imGitArbeitsbaum, ladeToken } from './token.mjs';
import { sammle } from './zentrale.mjs';

export const KOSTEN_TOLERANZ = 1e-6;

// B1.3a: Sollwert fuer den Ablauf des Lese-Tokens. Er steht nicht im Code, sondern in einer Referenzdatei, die Noah
// bei jeder Token-Erneuerung selbst eintraegt (Datum von der Token-Seite, Uhrzeit aus einer gesonderten Kopfprobe).
// Die Echt-Probe liest sie nur; sie erstellt, aendert oder ergaenzt sie nie und nimmt nie den Antwortkopf als Ersatz.
export const ECHTPROBE_SOLL = join(homedir(), '.zentrale', 'echtprobe-soll.json');
export const SOLL_SCHEMA = 'zentrale-echtprobe-soll-v1';
export const SOLL_GRENZE_BYTES = 4096;
// Eigene Setzung (Noahs Tokens laufen 30 Tage), keine gepruefte GitHub-Obergrenze.
export const SOLL_MAX_VORLAUF_MS = 366 * 24 * 60 * 60 * 1000;
const SOLL_FELDER = Object.freeze(['eingetragen', 'leseTokenAblauf', 'quelle', 'schema']);
const ABLAUF_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TAG_ISO = /^\d{4}-\d{2}-\d{2}$/;

// Streng gelesener Zeitpunkt oder null. Rundreise ueber toISOString lehnt Kalenderfehler (31.02., 24:00) ab.
function ablaufMs(wert) {
  if (typeof wert !== 'string' || !ABLAUF_ISO.test(wert)) {
    return null;
  }

  const ms = Date.parse(wert);
  return Number.isFinite(ms) && new Date(ms).toISOString() === `${wert.slice(0, 19)}.000Z` ? ms : null;
}

function tagMs(wert) {
  if (typeof wert !== 'string' || !TAG_ISO.test(wert)) {
    return null;
  }

  const ms = Date.parse(`${wert}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === wert ? ms : null;
}

// Reine Pruefung des Dateiinhalts gegen die (simulierte) aktuelle Zeit. Ergebnis { ok: true, soll, eingetragen, quelle }
// oder { ok: false, grund }. Der Grund ist immer ein fester Text und nennt nie einen Wert aus der Datei.
export function sollAusJson(text, jetzt) {
  const nein = grund => ({ ok: false, grund });

  if (!Number.isFinite(jetzt)) {
    return nein('aktuelle Zeit unbekannt');
  }

  let j;

  try {
    j = JSON.parse(text);
  } catch {
    return nein('kein JSON');
  }

  if (j === null || typeof j !== 'object' || Array.isArray(j)) {
    return nein('kein JSON-Objekt');
  }

  const felder = Object.keys(j);

  if (felder.some(f => !SOLL_FELDER.includes(f))) {
    return nein('unbekanntes Zusatzfeld');
  }

  const fehlt = SOLL_FELDER.find(f => !felder.includes(f));

  if (fehlt !== undefined) {
    return nein(`Feld ${fehlt} fehlt`);
  }

  if (j.schema !== SOLL_SCHEMA) {
    return nein('falsches Schema');
  }

  if (j.quelle !== 'noah') {
    return nein('quelle ist nicht noah');
  }

  const soll = ablaufMs(j.leseTokenAblauf);

  if (soll === null) {
    return nein('leseTokenAblauf ungueltig (erwartet JJJJ-MM-TTThh:mm:ssZ, echtes Datum)');
  }

  const tag = tagMs(j.eingetragen);

  if (tag === null) {
    return nein('eingetragen ungueltig (erwartet JJJJ-MM-TT, echtes Datum)');
  }

  if (j.eingetragen > new Date(jetzt).toISOString().slice(0, 10)) {
    return nein('eingetragen liegt in der Zukunft');
  }

  if (soll < tag) {
    return nein('leseTokenAblauf liegt vor dem Eintragungstag, nicht plausibel');
  }

  if (soll <= jetzt) {
    return nein('Sollwert abgelaufen, Referenzdatei nach der Token-Erneuerung neu eintragen');
  }

  if (soll - jetzt > SOLL_MAX_VORLAUF_MS) {
    return nein('leseTokenAblauf mehr als 366 Tage in der Zukunft, nicht plausibel');
  }

  return { ok: true, soll, eingetragen: j.eingetragen, quelle: j.quelle };
}

// Laedt die Referenzdatei nach dem Muster von ladeFristen (zentrale.mjs): kein Link, keine Nicht-Datei, hoechstens
// 4 KB, nicht in einem Git-Arbeitsbaum, Geheimnis-Filter ueber den Rohinhalt, BOM erlaubt. Liest nur, wirft nie.
export function ladeSoll({ datei = ECHTPROBE_SOLL, fsImpl = fs, jetzt = Date.now(), token = null } = {}) {
  const nein = grund => ({ ok: false, grund });
  let st;

  try {
    st = fsImpl.lstatSync(datei);
  } catch (e) {
    return e?.code === 'ENOENT' ? nein('Referenzdatei fehlt, bitte anlegen (siehe LIESMICH)') : nein('Referenzdatei nicht lesbar');
  }

  try {
    if (st.isSymbolicLink()) {
      return nein('Referenzdatei ist ein Link');
    }

    if (!st.isFile()) {
      return nein('Referenzdatei ist keine Datei');
    }

    if (st.size > SOLL_GRENZE_BYTES) {
      return nein('Referenzdatei zu gross');
    }

    if (imGitArbeitsbaum(datei, fsImpl)) {
      return nein('Referenzdatei liegt in einem Git-Arbeitsbaum');
    }

    const inhalt = fsImpl.readFileSync(datei, 'utf8');

    if (typeof inhalt !== 'string' || Buffer.byteLength(inhalt, 'utf8') > SOLL_GRENZE_BYTES) {
      return nein('Referenzdatei zu gross');
    }

    if (geheimnisTreffer(inhalt, token).length > 0) {
      return nein('Referenzdatei enthaelt ein Geheimnis-Muster');
    }

    return sollAusJson(inhalt.replace(/^﻿/, ''), jetzt);
  } catch {
    return nein('Referenzdatei nicht lesbar');
  }
}
// Fester Zeitpunkt fuer den historischen Teil: letzte Sekunde des Novembers 2026 (UTC).
export const REFERENZ_JETZT = Date.parse('2026-11-30T23:59:59Z');
// Der historische Bestand ist bis einschliesslich 20.11.2026 unabhaengig geprueft (17 Laeufe). Die Issue-Laufliste
// des historischen Abrufs wird deshalb serverseitig auf 2026-10-31 bis 2026-11-20 begrenzt: Aus dem Filter, den
// sammle() fuer REFERENZ_JETZT baut, wird ein Datumsbereich. ".." steht URL-kodiert da, weil github-lesen.mjs ".." im
// Pfad ablehnt; GitHub dekodiert es (gegengeprueft: dieselben 17 Laeufe wie mit "..").
export const LAUFLISTE_PFAD = '/actions/workflows/agent-auftrag.yml/runs?event=issues&';
export const FILTER_OFFEN = 'created=%3E%3D2026-10-31';
export const FILTER_REFERENZ = 'created=2026-10-31%2E%2E2026-11-20';

// Leser fuer den historischen Abruf: schreibt genau in der Issue-Laufliste den offenen Filter in den Bereich um und
// zaehlt, wie oft. Alle anderen Abrufe gehen unveraendert durch.
export function referenzLeser(leser) {
  const zaehler = { umschreibungen: 0 };
  const umschreiben = pfad => {
    if (typeof pfad === 'string' && pfad.includes(LAUFLISTE_PFAD) && pfad.includes(FILTER_OFFEN)) {
      zaehler.umschreibungen += 1;
      return pfad.replace(FILTER_OFFEN, FILTER_REFERENZ);
    }

    return pfad;
  };

  return {
    zaehler,
    leser: {
      holeJson: pfad => leser.holeJson(umschreiben(pfad)),
      holeAlleSeiten: (pfad, optionen) => leser.holeAlleSeiten(umschreiben(pfad), optionen),
      holeLog: id => leser.holeLog(id),
    },
  };
}

// Historischer Abruf mit begrenzter Laufliste. Greift die Umschreibung nicht genau einmal, ist der Abruf kein Beleg:
// fehler nennt dann den Grund.
export async function historischerAbruf(leser, sammleImpl = sammle) {
  const r = referenzLeser(leser);
  const { modell } = await sammleImpl({ leser: r.leser, jetzt: REFERENZ_JETZT, cache: {}, sitzungen: () => ({ ok: true, eintraege: [] }) });
  const n = r.zaehler.umschreibungen;
  return { bereiche: modell.bereiche, fehler: n === 1 ? null : `Begrenzung auf 2026-10-31 bis 2026-11-20 griff ${n}-mal statt genau einmal` };
}

// Feste Sollwerte, unabhaengig vom geprueften Programm aus den Laeufen auf GitHub abgeschrieben (Job-Liste, Logzeile
// "Claude beendet" in Job 1, Zeile "A6-FEHLER" im scheiternden Job, Draft-PR). Terminal 1 prueft sie zusaetzlich gegen
// die Originallaeufe. kosten null heisst: Claude lief belegt nicht, also keine Kosten.
export const SOLL = Object.freeze([
  Object.freeze({
    name: 'Live 2', id: 44765669207, start: '2026-11-20T15:40:42Z', issue: 79,
    jobs: ['completed/success', 'completed/success', 'completed/success', 'completed/success'],
    code: null, kosten: 0.0474278, runden: 6, pr: Object.freeze({ nummer: 104, zustand: 'gemergt', checks: 'success' }),
  }),
  Object.freeze({
    name: 'NF2', id: 44793828526, start: '2026-11-20T18:33:06Z', issue: 81,
    jobs: ['completed/success', 'completed/success', 'completed/failure', 'completed/skipped'],
    code: 'abnahme-exitcode', kosten: 0.0268694, runden: 5, pr: null,
  }),
  Object.freeze({
    name: 'NF3', id: 44826212314, start: '2026-11-20T22:07:07Z', issue: 80,
    jobs: ['completed/success', 'completed/failure', 'completed/skipped', 'completed/skipped'],
    code: 'auftrag-label-start-fehlt', kosten: null, runden: null, pr: null,
  }),
]);

// November 2026, von ChatGPT und Terminal 1 unabhaengig aus den Laeufen und Logs ermittelt: 6 Laeufe mit belegten
// Kosten, zusammen 0,1763432 USD; genau ein Lauf ohne Kostenbeleg (44620884909: Job 1 fehlgeschlagen, im Log weder
// Kostenzeile noch Vor-Start-Code). Der Monat ist deshalb nur als Untergrenze belegt.
export const MONAT_SOLL = Object.freeze({
  monat: '2026-11', summe: 0.1763432, mitKosten: 6, unbelegt: Object.freeze([44620884909]), vollstaendig: false,
});

const jobText = j => (j ? `${j.status}/${j.conclusion}` : 'unbekannt');

function kostenText(l) {
  if (Number.isFinite(l.kosten)) {
    return String(l.kosten);
  }

  return l.kostenOffen === false ? 'keine' : 'unbekannt';
}

// Laeufe eines Monats ohne Kostenbeleg (aufsteigend). Ein Lauf ohne Startzeit zaehlt mit, er koennte im Monat liegen.
export function unbelegteLaeufe(eintraege, m) {
  return eintraege
    .filter(l => (!Number.isFinite(l.start) || monat(l.start) === m) && !Number.isFinite(l.kosten) && l.kostenOffen !== false)
    .map(l => l.id)
    .sort((a, b) => a - b);
}

// Vergleicht einen Lauf mit seinem Sollwert. Liefert die Liste der Abweichungen (leer heisst: stimmt).
export function vergleicheLauf(l, soll) {
  const ab = [];
  const gleich = (feld, ist, sollWert) => {
    if (ist !== sollWert) {
      ab.push(`${feld} ${ist} statt ${sollWert}`);
    }
  };

  gleich('issue', l.issue ? l.issue.nummer : 'unbekannt', soll.issue);
  gleich('jobs', l.jobs.map(jobText).join(' '), soll.jobs.join(' '));
  gleich('code', l.code, soll.code);

  if (soll.kosten === null) {
    gleich('kosten', kostenText(l), 'keine');
  } else if (!Number.isFinite(l.kosten) || Math.abs(l.kosten - soll.kosten) > KOSTEN_TOLERANZ) {
    ab.push(`kosten ${kostenText(l)} statt ${soll.kosten} (Toleranz ${KOSTEN_TOLERANZ})`);
  }

  gleich('runden', l.runden, soll.runden);

  if (soll.pr === null) {
    gleich('pr', l.pr === null ? 'kein PR' : typeof l.pr === 'string' ? l.pr : `#${l.pr.nummer}`, 'kein PR');
  } else if (l.pr === null || typeof l.pr !== 'object') {
    ab.push(`pr ${l.pr === null ? 'kein PR' : l.pr} statt #${soll.pr.nummer}`);
  } else {
    gleich('pr', `#${l.pr.nummer} ${l.pr.zustand}`, `#${soll.pr.nummer} ${soll.pr.zustand}`);
    gleich('checks', l.pr.checks.map(c => `${c.name}=${c.ergebnis}`).join(' '),
      ['build', 'tests', 'schutzdateien', 'agent-auftrag-sammel'].map(n => `${n}=${soll.pr.checks}`).join(' '));
  }

  return ab;
}

// Vergleicht den Kostenbereich und die Laufliste eines Monats mit MONAT_SOLL. Liefert die Abweichungen.
export function vergleicheMonat(kosten, eintraege, soll = MONAT_SOLL) {
  const ab = [];

  if (kosten.monat !== soll.monat) {
    ab.push(`monat ${kosten.monat} statt ${soll.monat}`);
  }

  if (!Number.isFinite(kosten.summe) || Math.abs(kosten.summe - soll.summe) > KOSTEN_TOLERANZ) {
    ab.push(`summe ${kosten.summe} statt ${soll.summe} (Toleranz ${KOSTEN_TOLERANZ})`);
  }

  if (kosten.mitKosten !== soll.mitKosten) {
    ab.push(`mit Kosten ${kosten.mitKosten} statt ${soll.mitKosten}`);
  }

  const unbelegt = unbelegteLaeufe(eintraege, soll.monat).join(',');

  if (unbelegt !== [...soll.unbelegt].sort((a, b) => a - b).join(',')) {
    ab.push(`unbelegt {${unbelegt}} statt {${soll.unbelegt.join(',')}}`);
  }

  if (kosten.vollstaendig !== soll.vollstaendig) {
    ab.push(`vollstaendig ${kosten.vollstaendig} statt ${soll.vollstaendig}`);
  }

  return ab;
}

// Vollstaendigkeit eines sammle()-Ergebnisses: Laufliste und Issue-Kandidaten vollstaendig, kein Teilfehler.
function vollstaendigText(laeufe) {
  if (laeufe.stand === null) {
    return { ok: false, text: `Laufliste fehlgeschlagen (${laeufe.grund ?? 'unbekannt'})` };
  }

  const ok = !laeufe.unvollstaendig && !laeufe.kandidatenUnvollstaendig && laeufe.teilFehler === null;
  return {
    ok,
    text: `${laeufe.eintraege.length} Laeufe, Liste ${laeufe.unvollstaendig ? 'unvollstaendig' : 'vollstaendig'}, Issue-Kandidaten ${laeufe.kandidatenUnvollstaendig ? 'unvollstaendig' : 'vollstaendig'}, Teilfehler ${laeufe.teilFehler === null ? 'nein' : 'ja'}`,
  };
}

export async function echtprobe(argv, {
  tokenLaden = ladeToken, leserBauen = erzeugeLeser, ausgabe = t => process.stdout.write(`${t}\n`), jetzt = Date.now(), historisch = historischerAbruf,
  sollLaden = ladeSoll,
} = {}) {
  if (argv.includes('--schreibprobe')) {
    ausgabe('Abgelehnt: eine Schreibprobe ist in B1.1 nicht enthalten und braucht ein eigenes GO.');
    return 2;
  }

  if (argv.length > 0) {
    ausgabe('Aufruf: node werkzeuge/zentrale/echtprobe.mjs');
    return 2;
  }

  const t = tokenLaden();

  if (!t.ok) {
    ausgabe(`PROBE token: Abbruch (${t.grund}), Exitcode 1`);
    return 1;
  }

  // B1.3a: Referenzdatei genau einmal laden, vor dem ersten GitHub-Abruf.
  const soll = sollLaden({ jetzt, token: t.token });
  const leser = leserBauen({ token: t.token });
  let fehler = 0;
  const melde = (name, ok, text) => {
    fehler += ok ? 0 : 1;
    ausgabe(`PROBE ${name}: ${text} ${ok ? 'OK' : 'ABWEICHUNG'}`);
  };
  const pruefe = (name, ist, soll) => melde(name, ist === soll, `${ist} (erwartet ${soll})`);

  pruefe('repo', (await leser.holeJson(`/repos/${REPO}`)).klasse, 'ok');

  // B1.3: Ablaufdatum des Lese-Tokens aus dem Antwortkopf der Startpruefung (Muss-Treffer), exakt gegen den Sollwert
  // aus der Referenzdatei (B1.3a). Ausgegeben wird nur das streng gelesene Datum, nie der Rohwert des Kopfs. Ohne
  // gueltigen Sollwert wird der Kopf gar nicht erst abgerufen: er kann so nie zum Ersatz-Sollwert werden.
  if (!soll.ok) {
    melde('frist-lese-token', false, `Sollwert nicht pruefbar: ${soll.grund}`);
  } else {
    const st = await leser.holeJson(`/repos/${REPO}`, { start: true });
    const ablauf = st.klasse === 'ok' && Number.isFinite(st.tokenAblauf) ? st.tokenAblauf : null;
    melde('frist-lese-token', ablauf !== null && ablauf === soll.soll,
      `${ablauf === null ? 'kein gueltiges Ablaufdatum im Kopf' : new Date(ablauf).toISOString()} (erwartet ${new Date(soll.soll).toISOString()}, eingetragen ${soll.eingetragen} von ${soll.quelle})`);
  }

  pruefe('geloeschter-zweig', (await leser.holeJson(`/repos/${REPO}/branches/wp/78-agent-44536520447-1`)).klasse, 'unbekannt');
  pruefe('repo-fehlt', (await leser.holeJson('/repos/noah04091/gibt-es-nicht-b1-zentrale')).klasse, 'fehlt');
  pruefe('rate-limit', (await leser.holeJson('/rate_limit')).klasse, 'ok');

  const ohneSitzungen = () => ({ ok: true, eintraege: [] });

  // --- 1. Historischer Teil: fester Zeitpunkt, Laufliste serverseitig bis 2026-11-20 begrenzt ---------------------
  const ha = await historisch(leser);
  const hist = ha.bereiche;
  melde('historisch-zeitraum', ha.fehler === null, ha.fehler ?? 'Laufliste 2026-10-31 bis 2026-11-20 (serverseitig begrenzt)');
  const hv = vollstaendigText(hist.laeufe);
  melde('historisch-laeufe', hv.ok, hv.text);

  for (const soll of SOLL) {
    const l = hist.laeufe.stand === null ? undefined : hist.laeufe.eintraege.find(x => x.id === soll.id);

    if (!l) {
      melde(`lauf ${soll.name} ${soll.id}`, false, hist.laeufe.stand === null ? 'nicht pruefbar, Laufliste fehlgeschlagen' : 'fehlt in der Laufliste');
      continue;
    }

    const ab = vergleicheLauf(l, soll);
    const pr = l.pr && typeof l.pr === 'object' ? `#${l.pr.nummer} ${l.pr.zustand} ${l.pr.checks.map(c => `${c.name}=${c.ergebnis}`).join(' ')}` : String(l.pr ?? 'kein PR');
    const ist = `issue ${l.issue ? l.issue.nummer : 'unbekannt'} jobs ${l.jobs.map(jobText).join(' ')} code ${l.code} kosten ${kostenText(l)} runden ${l.runden} pr ${pr}`;
    melde(`lauf ${soll.name} ${soll.id}`, ab.length === 0, ab.length === 0 ? ist : `${ist}; Abweichung: ${ab.join('; ')}`);
  }

  const hk = hist.kosten;

  if (hk.stand === null || hist.laeufe.stand === null) {
    melde(`historisch-monat ${MONAT_SOLL.monat}`, false, 'nicht pruefbar, Abruf fehlgeschlagen');
  } else {
    const ab = vergleicheMonat(hk, hist.laeufe.eintraege);
    const ist = `summe ${hk.summe} mit Kosten ${hk.mitKosten} unbelegt {${unbelegteLaeufe(hist.laeufe.eintraege, MONAT_SOLL.monat).join(',')}} vollstaendig ${hk.vollstaendig}`;
    melde(`historisch-monat ${MONAT_SOLL.monat}`, ab.length === 0, ab.length === 0 ? ist : `${ist}; Abweichung: ${ab.join('; ')}`);
  }

  // --- 2. Laufender Teil: echte Uhrzeit, laufender Monat streng ----------------------------------------------------
  const akt = (await sammle({ leser, jetzt, cache: {}, sitzungen: ohneSitzungen })).modell.bereiche;
  const av = vollstaendigText(akt.laeufe);
  melde('laufend-laeufe', av.ok, av.text);
  const m = monat(jetzt);

  if (akt.kosten.stand === null || akt.laeufe.stand === null) {
    melde(`laufend-monat ${m}`, false, 'nicht pruefbar, Abruf fehlgeschlagen');
  } else {
    // Erlaubt ist nur ein unbelegter Lauf, der als historischer Sonderfall genau dieses Monats feststeht.
    const ausnahmen = MONAT_SOLL.monat === m ? MONAT_SOLL.unbelegt : [];
    const unbelegt = unbelegteLaeufe(akt.laeufe.eintraege, m);
    const fremd = unbelegt.filter(id => !ausnahmen.includes(id));
    const belegt = akt.kosten.vollstaendig === true || (fremd.length === 0 && unbelegt.length > 0 && akt.laeufe.unvollstaendig === false);
    melde(`laufend-monat ${m}`, belegt && fremd.length === 0,
      `summe ${akt.kosten.summe} mit Kosten ${akt.kosten.mitKosten} vollstaendig ${akt.kosten.vollstaendig} unbelegt {${unbelegt.join(',')}}${fremd.length ? ` davon nicht als Sonderfall belegt {${fremd.join(',')}}` : ''} (Summe nachrechnen gegen gh run view --log)`);
  }

  ausgabe(`INFO auftraege: ${akt.auftraege.stand === null ? 'fehlgeschlagen' : akt.auftraege.eintraege.length}`);
  ausgabe(`INFO freigaben: ${akt.freigaben.stand === null ? 'fehlgeschlagen' : akt.freigaben.eintraege.length}`);
  ausgabe(fehler === 0 ? 'ECHTPROBE BESTANDEN' : `ECHTPROBE NICHT BESTANDEN: ${fehler} Abweichungen`);
  return fehler === 0 ? 0 : 1;
}

if (import.meta.main === true) {
  process.exitCode = await echtprobe(process.argv.slice(2));
}
