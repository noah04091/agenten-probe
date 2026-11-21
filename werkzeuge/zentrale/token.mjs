// B1.1 Command Center: Lese-Token aus %USERPROFILE%\.zentrale\lese-token laden und pruefen.
//
// Nur diese Datei, kein gh, keine Umgebungsvariable, kein Git-Credential-Helper: ein Rueckfall auf eine andere
// Anmeldung ist damit ausgeschlossen. Abbruch, wenn die Datei fehlt, leer ist, ein Link ist, groesser als 512 Bytes
// ist, in einem Git-Arbeitsbaum liegt oder nicht mit github_pat_ beginnt. Fehlermeldungen nennen nur die Ursache,
// nie Teile des Werts.

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const GRENZE_BYTES = 512;
export const STANDARD_DATEI = join(homedir(), '.zentrale', 'lese-token');
const FORM = /^github_pat_[A-Za-z0-9_]{20,250}$/;
const ABGELEHNT = Object.freeze([
  ['gho_', 'falscher Typ: gh-Anmeldung (gho_)'],
  ['ghp_', 'falscher Typ: klassisches Token (ghp_)'],
  ['ghs_', 'falscher Typ: App-Token (ghs_)'],
  ['ghu_', 'falscher Typ: App-Token (ghu_)'],
]);

// Liegt der Pfad in einem Git-Arbeitsbaum? Sucht .git in allen Elternordnern.
export function imGitArbeitsbaum(datei, fsImpl = fs) {
  let ordner = dirname(resolve(datei));

  for (let i = 0; i < 256; i += 1) {
    if (fsImpl.existsSync(join(ordner, '.git'))) {
      return true;
    }

    const oben = dirname(ordner);

    if (oben === ordner) {
      return false;
    }

    ordner = oben;
  }

  // Unerwartet tief: im Zweifel ablehnen.
  return true;
}

// Ergebnis: { ok: true, token } oder { ok: false, grund }.
export function ladeToken({ datei = STANDARD_DATEI, fsImpl = fs } = {}) {
  let st;

  try {
    st = fsImpl.lstatSync(datei);
  } catch {
    return { ok: false, grund: 'Token fehlt' };
  }

  if (st.isSymbolicLink()) {
    return { ok: false, grund: 'Token-Datei ist ein Link' };
  }

  if (!st.isFile()) {
    return { ok: false, grund: 'Token-Datei ist keine Datei' };
  }

  if (st.size === 0) {
    return { ok: false, grund: 'Token-Datei ist leer' };
  }

  if (st.size > GRENZE_BYTES) {
    return { ok: false, grund: 'Token-Datei ist zu groß' };
  }

  if (imGitArbeitsbaum(datei, fsImpl)) {
    return { ok: false, grund: 'Token-Datei liegt in einem Git-Arbeitsbaum' };
  }

  let inhalt;

  try {
    inhalt = fsImpl.readFileSync(datei, 'utf8');
  } catch {
    return { ok: false, grund: 'Token-Datei nicht lesbar' };
  }

  if (Buffer.byteLength(inhalt, 'utf8') > GRENZE_BYTES) {
    return { ok: false, grund: 'Token-Datei ist zu groß' };
  }

  const wert = inhalt.replace(/\r?\n$/, '');

  if (wert.length === 0) {
    return { ok: false, grund: 'Token-Datei ist leer' };
  }

  for (const [praefix, grund] of ABGELEHNT) {
    if (wert.startsWith(praefix)) {
      return { ok: false, grund };
    }
  }

  if (!FORM.test(wert)) {
    return { ok: false, grund: 'falscher Typ: kein Fine-grained-Token (github_pat_)' };
  }

  return { ok: true, token: wert };
}
