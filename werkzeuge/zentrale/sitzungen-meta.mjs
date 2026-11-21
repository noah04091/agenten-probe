// B1.1 Command Center: laufende lokale Claude-Code-Sitzungen, nur Metadaten.
//
// Liest im Ordner %USERPROFILE%\.claude\sessions\ nur gewoehnliche Dateien *.json (nie *.key, nie andere, nie
// symbolische Links), je hoechstens 64 KB. Uebernommen werden nur name, cwd, startedAt, updatedAt, status, kind und
// die ersten 8 Zeichen von sessionId. Alle anderen Felder (messagingSocketPath, peerFeatures, pid, procStart, ...)
// werden verworfen. Gespraechsverlaeufe werden nie gelesen.

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STANDARD_ORDNER = join(homedir(), '.claude', 'sessions');
export const GRENZE_BYTES = 64 * 1024;
export const MAX_DATEIEN = 200;
const DATEINAME = /^[A-Za-z0-9_-]{1,80}\.json$/;

const kurz = (x, max) => (typeof x === 'string' && x.length <= max ? x : null);
const zahl = x => (Number.isFinite(x) && x > 0 ? x : null);

function feldAuszug(o) {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) {
    return null;
  }

  const id = kurz(o.sessionId, 100);
  return {
    name: kurz(o.name, 200) ?? '(ohne Namen)',
    cwd: kurz(o.cwd, 500) ?? 'unbekannt',
    start: zahl(o.startedAt),
    aktiv: zahl(o.updatedAt),
    status: kurz(o.status, 40) ?? 'unbekannt',
    kind: kurz(o.kind, 40) ?? 'unbekannt',
    id8: id !== null && /^[0-9a-f-]{8}/.test(id) ? id.slice(0, 8) : 'unbekannt',
  };
}

// Ergebnis: { ok: true, eintraege, uebersprungen } oder { ok: false, grund }.
export function leseSitzungen({ ordner = STANDARD_ORDNER, fsImpl = fs } = {}) {
  let liste;

  try {
    const st = fsImpl.lstatSync(ordner);

    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { ok: false, grund: 'Sitzungsordner ist kein Ordner' };
    }

    liste = fsImpl.readdirSync(ordner, { withFileTypes: true });
  } catch {
    return { ok: false, grund: 'Sitzungsordner nicht lesbar' };
  }

  const eintraege = [];
  let uebersprungen = 0;

  for (const d of liste.slice(0, MAX_DATEIEN)) {
    if (!DATEINAME.test(d.name) || !d.isFile() || d.isSymbolicLink()) {
      continue;
    }

    const pfad = join(ordner, d.name);

    try {
      const st = fsImpl.lstatSync(pfad);

      if (!st.isFile() || st.isSymbolicLink() || st.size > GRENZE_BYTES) {
        uebersprungen += 1;
        continue;
      }

      const auszug = feldAuszug(JSON.parse(fsImpl.readFileSync(pfad, 'utf8')));

      if (auszug === null) {
        uebersprungen += 1;
        continue;
      }

      eintraege.push(auszug);
    } catch {
      uebersprungen += 1;
    }
  }

  eintraege.sort((a, b) => (b.aktiv ?? 0) - (a.aktiv ?? 0));
  return { ok: true, eintraege, uebersprungen };
}
