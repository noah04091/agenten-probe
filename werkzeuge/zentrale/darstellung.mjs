// B1.1 Command Center: HTML-Seite aus dem Anzeigemodell. Rein, ohne Netz, ohne Dateien.
//
// Kein Skript, kein externer Inhalt, strenge CSP. Jeder uebernommene Text wird maskiert. Links nur auf
// https://github.com/noah04091/agenten-probe/... (dazu genau ein fester lokaler Link auf die Sitzungsuebersicht).
// Je Bereich "Stand: HH:MM UTC"; aelter als 10 Minuten: grau mit "veraltet"; gescheiterter Abruf: "Abruf
// fehlgeschlagen um ...", nie alte Werte als neu. Die Datei ist statisch: Sie nennt sich oben ausdruecklich
// Momentaufnahme mit Erzeugungszeit und behauptet nie, aktuell zu sein. Neu laden laesst sie den Browser nur im
// Schleifenbetrieb; dann nennt sie die Zeit, bis zu der die naechste Erzeugung faellig ist. Eine Seite nach dem Ende
// der Schleife traegt kein Neuladen mehr und sagt, dass die Schleife beendet ist.

import { klartext } from './fehlercodes.mjs';

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
  return k === null ? 'unbekannter Code' : `${maskiere(code)}: ${maskiere(k)}`;
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

function laeufe(b) {
  const teile = [];

  if (!b.eintraege.length) {
    teile.push('<p>Keine Agentenläufe aus Issue-Ereignissen in den letzten 30 Tagen.</p>');
  } else {
    const zeilen = b.eintraege.map(l => `<tr><td>${link(l.url, String(l.id))}</td>`
      + `<td>${l.issue ? link(l.issue.url, `#${l.issue.nummer}`) : 'Issue unbekannt'}</td><td>${datumZeit(l.start)}</td>`
      + `${[0, 1, 2, 3].map(n => `<td>${jobText(l.jobs[n])}</td>`).join('')}`
      + `<td>${fehlerText(l.code)}</td><td>${Number.isFinite(l.kosten) ? dollar(l.kosten) : l.kostenOffen ? 'unbekannt' : 'keine'}</td><td>${prText(l.pr)}</td></tr>`);
    teile.push(`<table><tr><th>Lauf</th><th>Issue</th><th>Start</th><th>Job 0</th><th>Job 1</th><th>Job 2</th><th>Job 3</th><th>Fehler</th><th>Kosten</th><th>Draft-PR</th></tr>${zeilen.join('')}</table>`);
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

function kosten(b) {
  const summe = b.vollstaendig ? dollar(b.summe) : `mindestens ${dollar(b.summe)} (unvollständig)`;
  return `<p>Monat ${maskiere(b.monat)} (UTC): ${summe}, Läufe mit Kosten: ${b.mitKosten}, Läufe ohne Kostenangabe: ${b.ohneKosten}</p>`;
}

function sitzungen(b) {
  if (!b.eintraege.length) {
    return '<p>Keine laufenden Claude-Code-Sitzungen gefunden.</p>';
  }

  const zeilen = b.eintraege.map(s => `<tr><td>${maskiere(s.name)}</td><td>${maskiere(s.cwd)}</td><td>${datumZeit(s.start)}</td>`
    + `<td>${datumZeit(s.aktiv)}</td><td>${maskiere(s.status)}</td><td>${maskiere(s.id8)}</td></tr>`);
  return `<table><tr><th>Name</th><th>Ordner</th><th>Start</th><th>Letzte Aktivität</th><th>Status</th><th>Sitzung</th></tr>${zeilen.join('')}</table>`;
}

const STIL = 'body{font-family:system-ui,sans-serif;margin:16px;color:#111;background:#fff}h1{font-size:1.4em}'
  + 'section{border:1px solid #ccc;border-radius:6px;padding:8px 12px;margin:12px 0}section.veraltet{background:#eee;color:#666}'
  + 'section.fehlgeschlagen{border-color:#b00}.fehler{color:#b00}.hinweis{font-style:italic}.stand{color:#555}'
  + 'table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:4px;text-align:left;vertical-align:top}'
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
    `<h1>Zentrale Agentensystem</h1>${momentaufnahme(modell, schleife === true, beendet)}${uebersicht}`,
    rahmen('1 Offene Aufträge', b.auftraege, jetzt, () => auftraege(b.auftraege)),
    rahmen('2 Agentenläufe', b.laeufe, jetzt, () => laeufe(b.laeufe)),
    rahmen('3 Meine Freigaben', b.freigaben, jetzt, () => freigaben(b.freigaben, jetzt)),
    rahmen('4 Kosten', b.kosten, jetzt, () => kosten(b.kosten)),
    rahmen('4 Laufende Sitzungen', b.sitzungen, jetzt, () => sitzungen(b.sitzungen)),
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
