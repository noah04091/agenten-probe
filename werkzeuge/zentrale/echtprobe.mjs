// B1.1 Command Center: Echt-Proben gegen GitHub. Nur lesend, nur von Hand gestartet, nicht in npm test.
//
//   node werkzeuge/zentrale/echtprobe.mjs
//
// Braucht Noahs Lese-Token in %USERPROFILE%\.zentrale\lese-token. Prueft die Antwortklassen an echten 404 und die
// Werte der drei bekannten Laeufe gegen feste Sollwerte. Gibt nur feste Kennungen, Zahlen und Codes aus, nie den
// Token-Wert oder Logtext. Eine Schreibprobe gibt es in B1.1 nicht (GO vom 21.11.2026); --schreibprobe wird abgelehnt.
//
// Exitcode 0 nur, wenn jede Probe stimmt UND die Daten vollstaendig sind: kein Teilfehler, vollstaendige Laufliste,
// vollstaendige Monatssumme, jeder Sollwert-Lauf vorhanden. Jede Abweichung, jeder fehlende oder nicht pruefbare
// Lauf und jede Luecke ergibt Exitcode 1.

import { REPO } from './daten.mjs';
import { erzeugeLeser } from './github-lesen.mjs';
import { ladeToken } from './token.mjs';
import { sammle } from './zentrale.mjs';

const TAG_MS = 24 * 60 * 60 * 1000;
export const KOSTEN_TOLERANZ = 1e-6;

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

// Fensteranfang wie in sammle(): der fruehere Zeitpunkt aus "vor 30 Tagen" und "Monatsanfang", auf den Tag gerundet.
export function fensterAnfang(jetzt) {
  const d = new Date(jetzt);
  const tag = new Date(Math.min(jetzt - 30 * TAG_MS, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
  return Date.UTC(tag.getUTCFullYear(), tag.getUTCMonth(), tag.getUTCDate());
}

const jobText = j => (j ? `${j.status}/${j.conclusion}` : 'unbekannt');

function kostenText(l) {
  if (Number.isFinite(l.kosten)) {
    return String(l.kosten);
  }

  return l.kostenOffen === false ? 'keine' : 'unbekannt';
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

export async function echtprobe(argv, { tokenLaden = ladeToken, leserBauen = erzeugeLeser, ausgabe = t => process.stdout.write(`${t}\n`), jetzt = Date.now() } = {}) {
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

  const leser = leserBauen({ token: t.token });
  let fehler = 0;
  const melde = (name, ok, text) => {
    fehler += ok ? 0 : 1;
    ausgabe(`PROBE ${name}: ${text} ${ok ? 'OK' : 'ABWEICHUNG'}`);
  };
  const pruefe = (name, ist, soll) => melde(name, ist === soll, `${ist} (erwartet ${soll})`);

  pruefe('repo', (await leser.holeJson(`/repos/${REPO}`)).klasse, 'ok');
  pruefe('geloeschter-zweig', (await leser.holeJson(`/repos/${REPO}/branches/wp/78-agent-44536520447-1`)).klasse, 'unbekannt');
  pruefe('repo-fehlt', (await leser.holeJson('/repos/noah04091/gibt-es-nicht-b1-zentrale')).klasse, 'fehlt');
  pruefe('rate-limit', (await leser.holeJson('/rate_limit')).klasse, 'ok');

  const { modell } = await sammle({ leser, jetzt, cache: {}, sitzungen: () => ({ ok: true, eintraege: [] }) });
  const laeufe = modell.bereiche.laeufe;
  const geladen = laeufe.stand !== null;

  // Vollstaendigkeit: ohne vollstaendige Daten kein Abnahmenachweis.
  melde('laeufe-abruf', geladen, geladen ? `${laeufe.eintraege.length} Laeufe` : `fehlgeschlagen (${laeufe.grund ?? 'unbekannt'})`);
  melde('laeufe-vollstaendig', geladen && !laeufe.unvollstaendig && !laeufe.kandidatenUnvollstaendig && laeufe.teilFehler === null,
    geladen ? `Liste ${laeufe.unvollstaendig ? 'unvollstaendig' : 'vollstaendig'}, Issue-Kandidaten ${laeufe.kandidatenUnvollstaendig ? 'unvollstaendig' : 'vollstaendig'}, Teilfehler ${laeufe.teilFehler === null ? 'nein' : 'ja'}` : 'keine Daten');

  const anfang = fensterAnfang(jetzt);

  for (const soll of SOLL) {
    const startSoll = Date.parse(soll.start);

    if (startSoll < anfang) {
      melde(`lauf ${soll.name} ${soll.id}`, false, `nicht pruefbar: Start ${soll.start} liegt vor dem Zeitfenster ab ${new Date(anfang).toISOString().slice(0, 10)}`);
      continue;
    }

    const l = geladen ? laeufe.eintraege.find(x => x.id === soll.id) : undefined;

    if (!l) {
      melde(`lauf ${soll.name} ${soll.id}`, false, geladen ? 'fehlt in der Laufliste, obwohl er im Zeitfenster liegt' : 'nicht pruefbar, Laufliste fehlgeschlagen');
      continue;
    }

    const ab = vergleicheLauf(l, soll);
    const pr = l.pr && typeof l.pr === 'object' ? `#${l.pr.nummer} ${l.pr.zustand} ${l.pr.checks.map(c => `${c.name}=${c.ergebnis}`).join(' ')}` : String(l.pr ?? 'kein PR');
    const ist = `issue ${l.issue ? l.issue.nummer : 'unbekannt'} jobs ${l.jobs.map(jobText).join(' ')} code ${l.code} kosten ${kostenText(l)} runden ${l.runden} pr ${pr}`;
    melde(`lauf ${soll.name} ${soll.id}`, ab.length === 0, ab.length === 0 ? ist : `${ist}; Abweichung: ${ab.join('; ')}`);
  }

  const k = modell.bereiche.kosten;
  melde(`monat ${k.monat ?? 'unbekannt'}`, k.stand !== null && k.vollstaendig === true,
    k.stand === null ? 'fehlgeschlagen' : `summe ${k.summe} mit ${k.mitKosten} ohne ${k.ohneKosten} vollstaendig ${k.vollstaendig} (Summe nachrechnen gegen gh run view --log)`);
  ausgabe(`INFO auftraege: ${modell.bereiche.auftraege.stand === null ? 'fehlgeschlagen' : modell.bereiche.auftraege.eintraege.length}`);
  ausgabe(`INFO freigaben: ${modell.bereiche.freigaben.stand === null ? 'fehlgeschlagen' : modell.bereiche.freigaben.eintraege.length}`);
  ausgabe(fehler === 0 ? 'ECHTPROBE BESTANDEN' : `ECHTPROBE NICHT BESTANDEN: ${fehler} Abweichungen`);
  return fehler === 0 ? 0 : 1;
}

if (import.meta.main === true) {
  process.exitCode = await echtprobe(process.argv.slice(2));
}
