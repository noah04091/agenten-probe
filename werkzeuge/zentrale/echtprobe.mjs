// B1.1 Command Center: Echt-Proben gegen GitHub. Nur lesend, nur von Hand gestartet, nicht in npm test.
//
//   node werkzeuge/zentrale/echtprobe.mjs
//
// Braucht Noahs Lese-Token in %USERPROFILE%\.zentrale\lese-token. Prueft die Antwortklassen an echten 404 und die
// Werte bekannter Laeufe. Gibt nur feste Kennungen, Zahlen und Codes aus, nie den Token-Wert oder Logtext.
// Eine Schreibprobe gibt es in B1.1 nicht (GO vom 21.11.2026); --schreibprobe wird abgelehnt.

import { REPO } from './daten.mjs';
import { erzeugeLeser } from './github-lesen.mjs';
import { ladeToken } from './token.mjs';
import { sammle } from './zentrale.mjs';

export const BEKANNTE_LAEUFE = Object.freeze([44765669207, 44793828526, 44826212314]);

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
  const pruefe = (name, ist, soll) => {
    const ok = ist === soll;
    fehler += ok ? 0 : 1;
    ausgabe(`PROBE ${name}: ${ist} (erwartet ${soll}) ${ok ? 'OK' : 'ABWEICHUNG'}`);
  };

  pruefe('repo', (await leser.holeJson(`/repos/${REPO}`)).klasse, 'ok');
  pruefe('geloeschter-zweig', (await leser.holeJson(`/repos/${REPO}/branches/wp/78-agent-44536520447-1`)).klasse, 'unbekannt');
  pruefe('repo-fehlt', (await leser.holeJson('/repos/noah04091/gibt-es-nicht-b1-zentrale')).klasse, 'fehlt');
  const rate = await leser.holeJson('/rate_limit');
  pruefe('rate-limit', rate.klasse, 'ok');

  const { modell } = await sammle({ leser, jetzt, cache: {}, sitzungen: () => ({ ok: true, eintraege: [] }) });
  const laeufe = modell.bereiche.laeufe;
  ausgabe(`PROBE laeufe: Stand ${laeufe.stand === null ? 'fehlgeschlagen' : 'ok'}, Eintraege ${laeufe.eintraege.length}, teilweise ${laeufe.teilFehler ? 'ja' : 'nein'}`);

  for (const id of BEKANNTE_LAEUFE) {
    const l = laeufe.eintraege.find(x => x.id === id);

    if (!l) {
      ausgabe(`PROBE lauf ${id}: nicht in der Liste (aelter als das Zeitfenster?)`);
      continue;
    }

    const jobs = l.jobs.map(j => (j ? `${j.status}/${j.conclusion}` : 'unbekannt')).join(' ');
    const pr = l.pr && l.pr !== 'unbekannt' ? `#${l.pr.nummer} ${l.pr.zustand} ${l.pr.checks.map(c => `${c.name}=${c.ergebnis}`).join(' ')}` : String(l.pr);
    ausgabe(`PROBE lauf ${id}: issue ${l.issue ? l.issue.nummer : 'unbekannt'} jobs ${jobs} code ${l.code} kosten ${l.kosten} runden ${l.runden} pr ${pr}`);
  }

  const k = modell.bereiche.kosten;
  ausgabe(`PROBE monat ${k.monat ?? 'unbekannt'}: summe ${k.summe} mit ${k.mitKosten} ohne ${k.ohneKosten} vollstaendig ${k.vollstaendig}`);
  ausgabe(`PROBE auftraege: ${modell.bereiche.auftraege.stand === null ? 'fehlgeschlagen' : modell.bereiche.auftraege.eintraege.length}`);
  ausgabe(`PROBE freigaben: ${modell.bereiche.freigaben.stand === null ? 'fehlgeschlagen' : modell.bereiche.freigaben.eintraege.length}`);
  return fehler === 0 ? 0 : 1;
}

if (import.meta.main === true) {
  process.exitCode = await echtprobe(process.argv.slice(2));
}
