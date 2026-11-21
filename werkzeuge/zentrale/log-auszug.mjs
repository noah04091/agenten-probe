// B1.1 Command Center: Auszug aus einem Job-Log. Rein, ohne Netz, ohne Dateien.
//
// Eingabe ist der Logtext eines Jobs. Ausgabe sind nur drei Werte: { code, runden, kosten }. Zeitstempel am
// Zeilenanfang werden entfernt; danach zaehlen nur Zeilen, die vollstaendig auf eines der beiden festen Muster passen.
// Kein anderer Text verlaesst diese Funktion. Der Aufrufer verwirft den Logtext danach.

export const GRENZE_ZEICHEN = 16 * 1024 * 1024;

const ZEITSTEMPEL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z /;
const FEHLER = /^A6-FEHLER ([a-z0-9-]{1,60})$/;
const BEENDET = /^Claude beendet: Runden (\d{1,3}), Kosten (\d{1,6}(?:\.\d{1,30})?) USD$/;

const LEER = Object.freeze({ code: null, runden: null, kosten: null });

export function logAuszug(text) {
  if (typeof text !== 'string' || text.length > GRENZE_ZEICHEN) {
    return LEER;
  }

  const codes = [];
  const beendet = [];

  for (const roh of text.replace(/^﻿/, '').split('\n')) {
    const zeile = roh.replace(/\r$/, '').replace(ZEITSTEMPEL, '');
    const f = FEHLER.exec(zeile);

    if (f) {
      codes.push(f[1]);
      continue;
    }

    const b = BEENDET.exec(zeile);

    if (b) {
      beendet.push({ runden: Number(b[1]), kosten: Number(b[2]) });
    }
  }

  // Mehrere Fehlerzeilen: nicht raten, welche gilt.
  const code = codes.length === 0 ? null : codes.length === 1 ? codes[0] : 'mehrdeutig';
  // Genau eine Zeile "Claude beendet" mit endlichen Zahlen, sonst keine Angabe.
  const eins = beendet.length === 1 && Number.isFinite(beendet[0].kosten) ? beendet[0] : null;
  return Object.freeze({ code, runden: eins ? eins.runden : null, kosten: eins ? eins.kosten : null });
}
