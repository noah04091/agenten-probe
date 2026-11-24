// B1.1 Command Center: HTML-Seite aus dem Anzeigemodell. Rein, ohne Netz, ohne Dateien.
//
// Kein Skript, kein externer Inhalt, strenge CSP. Jeder uebernommene Text wird maskiert. Links nur auf
// https://github.com/noah04091/agenten-probe/... (dazu genau ein fester lokaler Link auf die Sitzungsuebersicht).
// Je Bereich "Stand: HH:MM UTC"; aelter als 10 Minuten: grau mit "veraltet"; gescheiterter Abruf: "Abruf
// fehlgeschlagen um ...", nie alte Werte als neu. Die Datei ist statisch: Sie nennt sich oben ausdruecklich
// Momentaufnahme mit Erzeugungszeit und behauptet nie, aktuell zu sein. Neu laden laesst sie den Browser nur im
// Schleifenbetrieb; dann nennt sie die Zeit, bis zu der die naechste Erzeugung faellig ist. Eine Seite nach dem Ende
// der Schleife traegt kein Neuladen mehr und sagt, dass die Schleife beendet ist.

import { ZUGAENGE } from './daten.mjs';
import { klartext, nurName } from './fehlercodes.mjs';

export const VERALTET_MS = 10 * 60 * 1000;
// Schleifenbetrieb: neue Datei alle 120 Sekunden; faellig ist die naechste spaetestens eine Minute danach.
export const NAECHSTE_FAELLIG_MS = 3 * 60 * 1000;
export const GITHUB_PRAEFIX = 'https://github.com/noah04091/agenten-probe/';
export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'";
const GEHEIM_MUSTER = Object.freeze(['github_pat_', 'ghp_', 'gho_', 'ghs_', 'ghu_', 'sk-ant', '-----BEGIN']);

export function maskiere(wert) {
  return String(wert ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Link nur auf das eigene Repository auf github.com, mit harmlosen Zeichen; sonst nur Text.
export function link(url, text) {
  if (typeof url === 'string' && url.startsWith(GITHUB_PRAEFIX) && /^[A-Za-z0-9/:._#?=&%-]+$/.test(url) && url.length <= 300) {
    return `<a href="${maskiere(url)}" rel="noopener noreferrer">${maskiere(text)}</a>`;
  }

  return maskiere(text);
}

export function uhrzeit(ms) {
  if (!Number.isFinite(ms)) {
    return 'unbekannt';
  }

  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function datumZeit(ms) {
  if (!Number.isFinite(ms)) {
    return 'unbekannt';
  }

  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}. ${uhrzeit(ms)}`;
}

function tagUndZeit(ms) {
  if (!Number.isFinite(ms)) {
    return 'unbekannt';
  }

  const d = new Date(ms);
  return `am ${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()} um ${uhrzeit(ms)}`;
}

export function dollar(betrag) {
  return Number.isFinite(betrag) ? `${betrag.toFixed(3).replace('.', ',')} $` : 'unbekannt';
}

// Zustand eines Bereichs zum Erzeugungszeitpunkt: 'fehlgeschlagen', 'leer' (noch nie geladen), 'veraltet' oder
// 'geladen' (in diesem Durchlauf frisch geholt).
export function bereichZustand(bereich, jetzt) {
  const stand = bereich?.stand;
  const fehlschlag = bereich?.fehlschlag;

  if (Number.isFinite(fehlschlag) && (!Number.isFinite(stand) || fehlschlag >= stand)) {
    return 'fehlgeschlagen';
  }

  if (!Number.isFinite(stand)) {
    return 'leer';
  }

  return jetzt - stand > VERALTET_MS ? 'veraltet' : 'geladen';
}

function rahmen(titel, bereich, jetzt, inhalt) {
  const zustand = bereichZustand(bereich, jetzt);
  let kopf;
  let koerper;

  if (zustand === 'fehlgeschlagen') {
    kopf = `<p class="hinweis fehler">Abruf fehlgeschlagen um ${uhrzeit(bereich.fehlschlag)}${bereich.grund ? `: ${maskiere(bereich.grund)}` : ''}</p>`;
    koerper = '';
  } else if (zustand === 'leer') {
    kopf = '<p class="hinweis">Noch kein Stand.</p>';
    koerper = '';
  } else if (zustand === 'veraltet') {
    kopf = `<p class="hinweis">veraltet, Stand: ${uhrzeit(bereich.stand)}. Die Werte stammen aus einem früheren Abruf.</p>`;
    koerper = inhalt();
  } else {
    kopf = `<p class="stand">Stand: ${uhrzeit(bereich.stand)}</p>`;
    koerper = inhalt();
  }

  // Einzelne Abrufe gescheitert: betroffene Werte stehen als "unbekannt" da, der Bereich sagt es ausdruecklich.
  if (zustand !== 'fehlgeschlagen' && Number.isFinite(bereich?.teilFehler)) {
    kopf += `<p class="hinweis fehler">Abruf fehlgeschlagen um ${uhrzeit(bereich.teilFehler)} (teilweise): betroffene Werte stehen als „unbekannt“ da.</p>`;
  }

  return `<section class="${zustand}"><h2>${maskiere(titel)}</h2>${kopf}${koerper}</section>`;
}

function auftraege(b) {
  if (!b.eintraege.length) {
    return '<p>Keine offenen Agenten-Aufträge.</p>';
  }

  const zeilen = b.eintraege.map(a => `<tr><td>${link(a.url, `#${a.nummer}`)}</td><td>${maskiere(a.titel)}</td><td>${maskiere(a.profil)}</td>`
    + `<td>${a.startlabel ? 'gesetzt' : 'nicht gesetzt'}</td><td>${Number.isInteger(a.freigaben) ? `${a.freigaben} von 3` : 'unbekannt'}</td>`
    + `<td>${maskiere(a.abnahme)}</td></tr>`);
  return `<table><tr><th>Issue</th><th>Titel</th><th>Profil</th><th>Startlabel</th><th>Startfreigaben</th><th>Abnahme</th></tr>${zeilen.join('')}</table>`;
}

function jobText(j) {
  if (!j) {
    return 'unbekannt';
  }

  if (j.status === 'nicht-gestartet') {
    return 'nicht gestartet';
  }

  return maskiere(j.status === 'completed' ? (j.conclusion ?? 'unbekannt') : j.status);
}

function fehlerText(code) {
  if (code === null || code === undefined) {
    return 'kein Fehlercode';
  }

  if (code === 'mehrdeutig') {
    return 'mehrere Fehlercodes im Log';
  }

  const k = klartext(code);

  if (k !== null) {
    return `${maskiere(code)}: ${maskiere(k)}`;
  }

  // B1.1a: Name aus der Pipeline bekannt, aber ohne Klartext. Alles andere bleibt "unbekannter Code".
  return nurName(code) ? `${maskiere(code)} (keine Beschreibung hinterlegt)` : 'unbekannter Code';
}

function prText(pr) {
  if (pr === null || pr === undefined) {
    return 'kein Draft-PR';
  }

  if (pr === 'unbekannt') {
    return 'unbekannt';
  }

  if (pr === 'mehrdeutig') {
    return 'mehrere passende PRs, Zuordnung unbekannt';
  }

  if (typeof pr !== 'object') {
    return 'unbekannt';
  }

  const checks = pr.checks.map(c => `${maskiere(c.name)} ${maskiere(c.ergebnis)}`).join(', ');
  return `${link(pr.url, `#${pr.nummer}`)} ${maskiere(pr.zustand)}${checks ? ` (${checks})` : ''}`;
}

// B2.1: Vorpruefung zum aktuellen PR-Kopf. Nie ein Wort fuer ein positives Pruefurteil; "keine Auffaelligkeiten" steht
// immer mit dem Zusatz "keine Freigabe".
const VORPRUEFUNG_TEXT = Object.freeze({
  auffaelligkeiten: 'Auffälligkeiten',
  'keine-auffaelligkeiten': 'keine Auffälligkeiten (keine Freigabe)',
  ausstehend: 'ausstehend (Pflichtchecks nicht fertig)',
  'nicht-pruefbar': 'nicht prüfbar',
});

export function vorpruefungText(pr) {
  if (pr === null || typeof pr !== 'object') {
    return 'kein PR';
  }

  const v = pr.vorpruefung;

  if (v === null || typeof v !== 'object') {
    return 'nicht ermittelt';
  }

  if (v.status === 'aktuell' && Object.hasOwn(VORPRUEFUNG_TEXT, v.ergebnis)) {
    const zahl = x => (Number.isInteger(x) ? x : 'unbekannt');
    const mehr = Number.isInteger(v.anzahl) && v.anzahl > 1 ? `, ${v.anzahl} Prüfläufe zu diesem Kopf, gezeigt der jüngste` : '';
    return `${link(v.url, VORPRUEFUNG_TEXT[v.ergebnis])}: Befunde ${zahl(v.befunde)}, Hinweise ${zahl(v.hinweise)}${mehr}`;
  }

  if (v.status === 'veraltet') {
    return 'veraltet (geprüft wurde ein älterer Kopf)';
  }

  if (v.status === 'nicht-geprueft') {
    return 'nicht geprüft';
  }

  return `unbekannt (${maskiere(v.grund ?? 'unbekannter Wert')})`;
}

function laeufe(b, warnungen = []) {
  const teile = [];

  if (!b.eintraege.length) {
    teile.push('<p>Keine Agentenläufe aus Issue-Ereignissen in den letzten 30 Tagen.</p>');
  } else {
    const zeilen = b.eintraege.map(l => `<tr><td>${link(l.url, String(l.id))}</td>`
      + `<td>${l.issue ? link(l.issue.url, `#${l.issue.nummer}`) : 'Issue unbekannt'}</td><td>${datumZeit(l.start)}</td>`
      + `${[0, 1, 2, 3].map(n => `<td>${jobText(l.jobs[n])}</td>`).join('')}`
      + `<td>${fehlerText(l.code)}</td><td>${Number.isFinite(l.kosten) ? dollar(l.kosten) : l.kostenOffen ? 'unbekannt' : 'keine'}</td><td>${prText(l.pr)}</td><td>${vorpruefungText(l.pr)}</td></tr>`);
    teile.push(`<table><tr><th>Lauf</th><th>Issue</th><th>Start</th><th>Job 0</th><th>Job 1</th><th>Job 2</th><th>Job 3</th><th>Fehler laut Log</th><th>Kosten</th><th>Draft-PR</th><th>Vorprüfung</th></tr>${zeilen.join('')}</table>`);
  }

  // B1.3c: Laufwarnungen am Lauf (dieselben Saetze wie oben auf der Seite).
  for (const w of warnungen.filter(x => Number.isInteger(x.laufId))) {
    teile.push(`<p class="laufwarnung">${laufwarnungText(w)}</p>`);
  }

  if (b.unvollstaendig) {
    teile.push('<p class="hinweis">Nicht alle Läufe konnten geladen werden. Die Liste ist unvollständig.</p>');
  }

  if (b.kandidatenUnvollstaendig) {
    teile.push('<p class="hinweis">Die Issue-Liste konnte nicht vollständig geladen werden. Die Zuordnung Lauf zu Issue ist deshalb unbekannt.</p>');
  }

  teile.push(`<p>Läufe aus Pull Requests (Generalprobe), 30 Tage: ${Number.isInteger(b.generalprobe) ? b.generalprobe : 'unbekannt'}</p>`);
  return teile.join('');
}

function freigaben(b, jetzt) {
  const hinweis = '<p class="hinweis">Maßgeblich ist GitHub. Freigeben geht nur dort.</p>';

  if (!b.eintraege.length) {
    return `<p>Keine wartenden Freigaben.</p>${hinweis}`;
  }

  const zeilen = b.eintraege.map(f => {
    const rest = Number.isFinite(f.restMinuten) ? `noch ${f.restMinuten} min` : 'unbekannt';
    const reserve = f.job === 3 && Number.isFinite(f.restMinuten) ? `, Job 3 braucht 2 min Reserve: praktisch noch ${Math.max(0, f.restMinuten - 2)} min` : '';
    return `<tr><td>${link(f.url, String(f.laufId))}</td><td>${maskiere(f.environment)}</td><td>${Number.isInteger(f.job) ? `Job ${f.job}` : 'unbekannt'}</td>`
      + `<td>${rest}${reserve} (Stand ${uhrzeit(jetzt)})</td></tr>`;
  });
  return `<table><tr><th>Lauf</th><th>Environment</th><th>Job</th><th>Frist bis 60 min nach dem Startlabel</th></tr>${zeilen.join('')}</table>${hinweis}`;
}

// B1.1a: drei ueberschneidungsfreie Zahlen. Laeufe ohne Kostenbeleg (Log gelesen oder Job noch offen) sind kein
// Abruffehler, sie stehen als eigener Hinweis da; die Summe bleibt dann "mindestens ... (unvollstaendig)".
export const KOSTEN_BESCHRIFTUNG = 'Kosten der Agent-Aufträge (Workflow agent-auftrag.yml), nicht der Gesamtverbrauch des '
  + 'Anthropic-Workspace. Der steht in der Anthropic-Konsole.';

function anzahl(n) {
  return Number.isInteger(n) ? String(n) : 'unbekannt';
}

function kosten(b) {
  const summe = b.vollstaendig ? dollar(b.summe) : `mindestens ${dollar(b.summe)} (unvollständig)`;
  const teile = [`<p class="hinweis">${KOSTEN_BESCHRIFTUNG}</p>`,
    `<p>Monat ${maskiere(b.monat)} (UTC): ${summe}, Läufe mit Kosten: ${anzahl(b.mitKosten)}, `
    + `belegt ohne Kosten: ${anzahl(b.belegtOhneKosten)}, Kosten unbekannt: ${anzahl(b.kostenUnbekannt)}</p>`];

  if (Number.isInteger(b.ohneBeleg) && b.ohneBeleg > 0) {
    teile.push(`<p class="hinweis">${b.ohneBeleg} ${b.ohneBeleg === 1 ? 'Lauf' : 'Läufe'} ohne Kostenbeleg, Monatssumme unvollständig.</p>`);
  }

  return teile.join('');
}

function sitzungen(b) {
  if (!b.eintraege.length) {
    return '<p>Keine laufenden Claude-Code-Sitzungen gefunden.</p>';
  }

  const zeilen = b.eintraege.map(s => `<tr><td>${maskiere(s.name)}</td><td>${maskiere(s.cwd)}</td><td>${datumZeit(s.start)}</td>`
    + `<td>${datumZeit(s.aktiv)}</td><td>${maskiere(s.status)}</td><td>${maskiere(s.id8)}</td></tr>`);
  return `<table><tr><th>Name</th><th>Ordner</th><th>Start</th><th>Letzte Aktivität</th><th>Status</th><th>Sitzung</th></tr>${zeilen.join('')}</table>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// B1.3 Fristen: Bereich "0 Fristen" ganz oben, rotes Banner fuer Warnung, dringend und abgelaufen. Jede Angabe nennt ihre
// Herkunft und ihr Alter; was nicht belegt ist, steht als "Ablauf unbekannt" da, nie als ok.
// ---------------------------------------------------------------------------------------------------------------------

const TAG_MS = 24 * 60 * 60 * 1000;
const ROT = Object.freeze(['warnung', 'dringend', 'abgelaufen']);

function nurTag(ms) {
  if (!Number.isFinite(ms)) {
    return 'unbekannt';
  }

  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}

// Tagesgenaue Angaben ohne Uhrzeit, nie eine erfundene Uhrzeit.
function fristDatumText(ms, tagesgenau) {
  return tagesgenau ? nurTag(ms) : `${nurTag(ms)} um ${uhrzeit(ms)}`;
}

function fristText(e) {
  if (e.stufe === 'unbekannt' || !Number.isFinite(e.restMs)) {
    const h = e.historisch;
    const alt = h && Number.isFinite(h.ablauf) && Number.isFinite(h.gemeldetAm)
      ? ` Zuletzt von GitHub gemeldet ${tagUndZeit(h.gemeldetAm)}: Ablauf ${fristDatumText(h.ablauf, false)} (historische Angabe).` : '';
    return `Ablauf unbekannt${e.grund ? `: ${maskiere(e.grund)}` : ''}.${alt}`;
  }

  const d = fristDatumText(e.ablauf, e.tagesgenau);
  const tage = Math.floor(e.restMs / TAG_MS);
  const noch = `noch ${tage} ${tage === 1 ? 'Tag' : 'Tage'}`;

  if (e.stufe === 'abgelaufen') {
    return `abgelaufen seit ${d}`;
  }

  if (e.stufe === 'dringend') {
    const stunden = Math.floor(e.restMs / (60 * 60 * 1000));
    const wann = stunden < 1 ? 'in weniger als einer Stunde' : `in ${stunden} ${stunden === 1 ? 'Stunde' : 'Stunden'}`;
    return `läuft ${wann} ab (am ${d}), jetzt erneuern`;
  }

  const zusatz = e.stufe === 'warnung' ? ', jetzt erneuern' : e.stufe === 'hinweis' ? ', bald erneuern' : '';
  return `läuft am ${d} ab (${noch})${zusatz}`;
}

function herkunftText(e) {
  if (e.quelle === 'github') {
    return Number.isFinite(e.gemeldetAm) && Number.isFinite(e.ablauf) ? `von GitHub gemeldet ${tagUndZeit(e.gemeldetAm)}` : 'Quelle: Antwortkopf der Startprüfung bei GitHub';
  }

  if (!Number.isFinite(e.eingetragenAm)) {
    return 'Quelle: fristen.json (manuell)';
  }

  return `manuell eingetragen am ${nurTag(e.eingetragenAm)}, nicht von der Zentrale geprüft${e.pruefen ? `; Eintrag vom ${nurTag(e.eingetragenAm)}, bitte prüfen` : ''}`;
}

// Ohne Fristenmodell (etwa eine Seite aus einem frueheren Stand): alle drei Zugaenge als unbekannt, nie als ok.
function fristEintraege(fristen) {
  if (fristen && Array.isArray(fristen.eintraege) && fristen.eintraege.length === ZUGAENGE.length) {
    return fristen.eintraege;
  }

  return ZUGAENGE.map(z => ({ ...z, stufe: 'unbekannt', restMs: null, grund: 'nicht ermittelt' }));
}

function fristenBereich(fristen, erzeugt) {
  // Farbklassen statt Stufennamen, damit kein Stufenwort (etwa "abgelaufen") im Quelltext einer Seite steht.
  const farbe = e => (ROT.includes(e.stufe) ? 'frist-rot' : e.stufe === 'hinweis' ? 'frist-gelb' : e.stufe === 'ok' ? 'frist-ok' : 'frist-unbekannt');
  const zeilen = fristEintraege(fristen).map(e => `<tr class="${farbe(e)}"><td>${maskiere(e.name)}</td><td>${fristText(e)}</td>`
    + `<td>${herkunftText(e)}</td><td>${maskiere(e.handgriff ?? '')}</td></tr>`);
  return `<section class="fristen"><h2>0 Fristen</h2><p class="fristen-stand">Gerechnet in UTC ab der Erzeugungszeit ${uhrzeit(erzeugt)}.</p>`
    + `<table><tr><th>Zugang</th><th>Ablauf</th><th>Herkunft</th><th>Handgriff</th></tr>${zeilen.join('')}</table></section>`;
}

function fristenBanner(fristen) {
  const rot = fristEintraege(fristen).filter(e => ROT.includes(e.stufe));

  if (rot.length === 0) {
    return '';
  }

  return `<div class="banner">${rot.map(e => `<p><strong>${maskiere(e.name)}:</strong> ${fristText(e)}. ${maskiere(e.handgriff ?? '')}</p>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// B1.3c Laufwarnungen: oben auf der Seite (wie die Fristwarnungen) und am Lauf. Feste Saetze, Zahlen und Labelnamen nur
// nach festem Muster (daten.mjs); kein anderer Rohtext. Fehlende Daten erscheinen als "nicht pruefbar", nie als
// Entwarnung. Die Saetze behaupten keinen Vergleich des main-Stands mit dem Ausgangscommit eines Laufs.
// ---------------------------------------------------------------------------------------------------------------------

const nummern = prs => prs.map(n => `#${maskiere(n)}`).join(', ');

export function laufwarnungText(w) {
  const an = Number.isInteger(w.issue) ? `an #${maskiere(w.issue)}` : '(Issue unbekannt)';
  const id = maskiere(w.laufId);

  if (w.art === 'label') {
    const welches = typeof w.label === 'string' ? `das Label ${maskiere(w.label)}` : 'ein Label';
    const mehr = Number.isInteger(w.weitere) && w.weitere > 0 ? ` Danach ${w.weitere} weitere ${w.weitere === 1 ? 'Labeländerung' : 'Labeländerungen'}.` : '';
    return `Lauf ${id} ${an}: während des Laufs wurde ${welches} geändert (${datumZeit(w.zeit)}).${mehr} Das kann den Lauf abbrechen. Nichts erneut setzen, erst das Ende abwarten.`;
  }

  if (w.art === 'gemergt') {
    return `Während Lauf ${id} wurde ein PR nach main gemergt (${nummern(w.prs)}). Der Lauf könnte dadurch ungültig sein.`;
  }

  if (w.art === 'offen') {
    return `Lauf ${id} ${an} läuft. Ein Merge könnte den laufenden Auftrag ungültig machen. Offene PRs nach main: ${nummern(w.prs)}.`;
  }

  return `Laufwarnungen nicht prüfbar (${maskiere(w.quelle ?? 'unbekannt')}).`;
}

// Ohne Laufwarnungsmodell (etwa eine Seite aus einem frueheren Stand): nicht pruefbar, nie eine Entwarnung.
function laufwarnungEintraege(lw) {
  return lw && Array.isArray(lw.eintraege) ? lw.eintraege : [{ art: 'nicht-pruefbar', laufId: null, quelle: 'nicht ermittelt' }];
}

function laufwarnungenBanner(lw) {
  const e = laufwarnungEintraege(lw);

  if (e.length === 0) {
    return '';
  }

  return `<div class="banner laufwarnungen">${e.map(w => `<p>${laufwarnungText(w)}</p>`).join('')}</div>`;
}

const STIL = 'body{font-family:system-ui,sans-serif;margin:16px;color:#111;background:#fff}h1{font-size:1.4em}'
  + 'section{border:1px solid #ccc;border-radius:6px;padding:8px 12px;margin:12px 0}section.veraltet{background:#eee;color:#666}'
  + 'section.fehlgeschlagen{border-color:#b00}.fehler{color:#b00}.hinweis{font-style:italic}.stand{color:#555}'
  + 'table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:4px;text-align:left;vertical-align:top}'
  + '.banner{border:2px solid #b00;background:#fde2e2;color:#600;border-radius:6px;padding:4px 12px;margin:12px 0}'
  + 'tr.frist-gelb{background:#fff3c4}tr.frist-rot{background:#fde2e2;color:#600}'
  + '@media (max-width:700px){table,tr,td,th{display:block}th{display:none}tr{border-bottom:2px solid #ccc;padding:4px 0}}';

// Kopf: was diese Datei ist. Ohne Schleife: Momentaufnahme, aktualisiert sich nicht. Mit Schleife: Neuladen und die
// Zeit, bis zu der die naechste Datei faellig ist. Nach dem Ende der Schleife: Hinweis auf das Ende, kein Neuladen.
function momentaufnahme(modell, schleife, beendet) {
  const kopf = `<p class="momentaufnahme"><strong>Momentaufnahme: erzeugt ${tagUndZeit(modell.erzeugt)}.</strong>`;

  if (beendet) {
    return `${kopf} Die Schleife wurde ${tagUndZeit(beendet.um)} beendet${beendet.grund ? ` (${maskiere(beendet.grund)})` : ''}. `
      + 'Diese Seite wird nicht mehr erneuert.</p>';
  }

  if (schleife) {
    return `${kopf} Schleifenbetrieb: eine neue Momentaufnahme ist bis ${uhrzeit(modell.erzeugt + NAECHSTE_FAELLIG_MS)} fällig. `
      + 'Steht danach noch diese Erzeugungszeit da, läuft die Schleife nicht mehr und die Werte sind veraltet.</p>';
  }

  return `${kopf} Die Seite erneuert sich nicht von selbst. Für einen neuen Stand den Befehl erneut ausführen.</p>`;
}

export function seite(modell, jetzt, { schleife = false, beendet = null } = {}) {
  const b = modell.bereiche;
  const uebersicht = typeof modell.sitzungsUebersicht === 'string'
    ? `<p><a href="${maskiere(modell.sitzungsUebersicht)}" rel="noopener noreferrer">Sitzungsübersicht</a></p>` : '';
  return [
    '<!doctype html><html lang="de"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    schleife === true && !beendet ? '<meta http-equiv="refresh" content="60">' : '',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Zentrale (Momentaufnahme ${uhrzeit(modell.erzeugt)})</title><style>${STIL}</style></head><body>`,
    `<h1>Zentrale Agentensystem</h1>${fristenBanner(modell.fristen)}${laufwarnungenBanner(modell.laufwarnungen)}${momentaufnahme(modell, schleife === true, beendet)}${uebersicht}`,
    fristenBereich(modell.fristen, modell.erzeugt),
    rahmen('1 Offene Aufträge', b.auftraege, jetzt, () => auftraege(b.auftraege)),
    rahmen('2 Agentenläufe', b.laeufe, jetzt, () => laeufe(b.laeufe, laufwarnungEintraege(modell.laufwarnungen))),
    rahmen('3 Meine Freigaben', b.freigaben, jetzt, () => freigaben(b.freigaben, jetzt)),
    rahmen('4 Kosten', b.kosten, jetzt, () => kosten(b.kosten)),
    rahmen('5 Laufende Sitzungen', b.sitzungen, jetzt, () => sitzungen(b.sitzungen)),
    '</body></html>\n',
  ].join('');
}

// B1.3: Notseite ohne GitHub-Daten und ohne Neuladen. Ersetzt die alte Seite, damit keine veralteten Werte stehen bleiben.
// art 'abgelehnt' (401 der Startpruefung): nie pauschal "abgelaufen", sondern je nach letzter Meldung
//   (a) wahrscheinlich abgelaufen, (b) abgelehnt obwohl laut letzter Meldung gueltig, (c) Ablauf unbekannt.
// art 'token-datei': Token-Datei fehlt oder ist ungueltig (Grund aus token.mjs).
// art 'start': anderer Fehler der Startpruefung (403, 429, 5xx, Zeitlimit, Netzfehler); kein Token-Fehler.
export function notseite({ erzeugt, art, grund: roh, letzteMeldung = null }) {
  const l = letzteMeldung && Number.isFinite(letzteMeldung.ablauf) && Number.isFinite(letzteMeldung.gemeldetAm) ? letzteMeldung : null;
  // Die festen Gruende aus token.mjs nennen Token-Praefixe wie "(gho_)". In dieser Schreibweise wuerde der
  // Geheimnis-Filter die Notseite verwerfen und die alte Seite stehen lassen; deshalb "Praefix gho". Der Filter bleibt
  // unveraendert fuer alles andere.
  const grund = typeof roh === 'string' ? roh.replace(/\b(gho|ghp|ghs|ghu|github_pat)_/g, 'Präfix $1') : roh;
  const meldung = l ? `laut letzter Meldung von GitHub ${tagUndZeit(l.gemeldetAm)}` : '';
  const leseHandgriff = ZUGAENGE[0].handgriff;
  let text;
  let handgriff;

  if (art === 'abgelehnt') {
    if (l && l.ablauf <= erzeugt) {
      text = `Das Lese-Token wird von GitHub abgelehnt (401). Es ist wahrscheinlich abgelaufen am ${fristDatumText(l.ablauf, false)} (${meldung}).`;
    } else if (l) {
      text = `Das Lese-Token wird von GitHub abgelehnt (401), obwohl es ${meldung} bis ${fristDatumText(l.ablauf, false)} gültig ist. Wurde es widerrufen oder geändert?`;
    } else {
      text = 'Das Lese-Token wird von GitHub abgelehnt (401). Ablauf unbekannt.';
    }

    handgriff = leseHandgriff;
  } else if (art === 'token-datei') {
    text = `Das Lese-Token kann nicht geladen werden: ${maskiere(grund ?? 'unbekannter Grund')}.${l ? ` Letzte Meldung von GitHub (${tagUndZeit(l.gemeldetAm)}): Ablauf ${fristDatumText(l.ablauf, false)}.` : ''}`;
    handgriff = `Token-Datei der Zentrale prüfen. Fehlt sie oder ist das Token ungültig: ${leseHandgriff}`;
  } else {
    text = `Die Startprüfung bei GitHub ist fehlgeschlagen: ${maskiere(grund ?? 'unbekannter Grund')}. Das ist keine Ablehnung der Anmeldung (401).`;
    handgriff = 'Später erneut starten. Bei „keine Berechtigung (403)“ die Rechte des Lese-Tokens prüfen, bei „Rate-Limit erschöpft“ warten.';
  }

  return [
    '<!doctype html><html lang="de"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Zentrale (Notseite ${uhrzeit(erzeugt)})</title><style>${STIL}</style></head><body>`,
    '<h1>Zentrale Agentensystem</h1>',
    `<p class="momentaufnahme"><strong>Notseite: erzeugt ${tagUndZeit(erzeugt)}.</strong> Es werden keine GitHub-Daten angezeigt, die vorherige Seite ist ersetzt. `
      + 'Die Seite erneuert sich nicht von selbst.</p>',
    `<div class="banner"><p>${text}</p><p>Handgriff: ${maskiere(handgriff)}</p></div>`,
    '</body></html>\n',
  ].join('');
}

// Fertige Seite auf Geheimnisse pruefen. Liefert die Liste der Treffer (Namen, nie Werte); leer heisst sauber.
export function geheimnisTreffer(html, token) {
  const treffer = GEHEIM_MUSTER.filter(m => html.includes(m));

  if (typeof token === 'string' && token.length >= 8 && html.includes(token)) {
    treffer.push('token-wert');
  }

  return treffer;
}
