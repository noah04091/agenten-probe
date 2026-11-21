// B1.1 Command Center: Lese-Token (W3). Fehlend, leer, falscher Typ, zu gross, Link, im Git-Arbeitsbaum: Abbruch,
// keine Seite. Kein Rueckfall auf eine andere Anmeldung.
globalThis.fetch = () => { throw new Error('W10: Netz in Zentrale-Tests verboten'); };

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { GRENZE_BYTES, imGitArbeitsbaum, ladeToken } from '../werkzeuge/zentrale/token.mjs';
import { main } from '../werkzeuge/zentrale/zentrale.mjs';

const GUELTIG = 'github_pat_TESTNURATTRAPPE_0000000000';
const ORDNER = resolve('nutzer-attrappe', 'test', '.zentrale');
const DATEI = join(ORDNER, 'lese-token');

// Datei-Attrappe: genau eine Datei oder ein Link; .git nur, wenn angegeben.
function dateien({ inhalt = `${GUELTIG}\n`, art = 'datei', groesse, git = [] } = {}) {
  return {
    lstatSync(p) {
      if (p !== DATEI || art === 'fehlt') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }

      return { isSymbolicLink: () => art === 'link', isFile: () => art === 'datei', size: groesse ?? Buffer.byteLength(inhalt) };
    },
    existsSync: p => git.includes(p),
    readFileSync(p) {
      if (p !== DATEI) {
        throw new Error('fremde Datei gelesen');
      }

      return inhalt;
    },
  };
}

const lade = opt => ladeToken({ datei: DATEI, fsImpl: dateien(opt) });

test('Token: gueltiges Fine-grained-Token wird ohne Zeilenende geladen', () => {
  assert.deepEqual(lade(), { ok: true, token: GUELTIG });
  assert.deepEqual(lade({ inhalt: `${GUELTIG}\r\n` }), { ok: true, token: GUELTIG });
  assert.deepEqual(lade({ inhalt: GUELTIG }), { ok: true, token: GUELTIG });
});

test('Token (W3): jeder ungueltige Fall bricht ab und nennt nur die Ursache', () => {
  const faelle = [
    [{ art: 'fehlt' }, 'Token fehlt'],
    [{ art: 'link' }, 'Token-Datei ist ein Link'],
    [{ art: 'ordner' }, 'Token-Datei ist keine Datei'],
    [{ inhalt: '' }, 'Token-Datei ist leer'],
    [{ inhalt: '\n' }, 'Token-Datei ist leer'],
    [{ groesse: GRENZE_BYTES + 1 }, 'Token-Datei ist zu groß'],
    [{ inhalt: `github_pat_${'A'.repeat(GRENZE_BYTES)}` }, 'Token-Datei ist zu groß'],
    [{ git: [join(ORDNER, '.git')] }, 'Token-Datei liegt in einem Git-Arbeitsbaum'],
    [{ git: [resolve('nutzer-attrappe', '.git')] }, 'Token-Datei liegt in einem Git-Arbeitsbaum'],
    [{ inhalt: 'gho_TESTNURATTRAPPE00000000000000' }, 'falscher Typ: gh-Anmeldung (gho_)'],
    [{ inhalt: 'ghp_TESTNURATTRAPPE00000000000000' }, 'falscher Typ: klassisches Token (ghp_)'],
    [{ inhalt: 'ghs_TESTNURATTRAPPE00000000000000' }, 'falscher Typ: App-Token (ghs_)'],
    [{ inhalt: 'ghu_TESTNURATTRAPPE00000000000000' }, 'falscher Typ: App-Token (ghu_)'],
    [{ inhalt: 'github_pat_kurz' }, 'falscher Typ: kein Fine-grained-Token (github_pat_)'],
    [{ inhalt: `${GUELTIG} zweiter-teil` }, 'falscher Typ: kein Fine-grained-Token (github_pat_)'],
    [{ inhalt: `${GUELTIG}\n${GUELTIG}\n` }, 'falscher Typ: kein Fine-grained-Token (github_pat_)'],
    [{ inhalt: ` ${GUELTIG}` }, 'falscher Typ: kein Fine-grained-Token (github_pat_)'],
    [{ inhalt: 'sk-ant-TESTNURATTRAPPE' }, 'falscher Typ: kein Fine-grained-Token (github_pat_)'],
  ];

  for (const [opt, grund] of faelle) {
    const r = lade(opt);
    assert.deepEqual(r, { ok: false, grund }, JSON.stringify(opt).slice(0, 80));
    assert.ok(!grund.includes('TESTNURATTRAPPE'));
  }
});

test('Token: Git-Pruefung bis zur Wurzel, Muss-Treffer und Gegenprobe', () => {
  const tief = resolve('a', 'b', 'c', 'lese-token');
  assert.equal(imGitArbeitsbaum(tief, { existsSync: p => p === resolve('a', '.git') }), true);
  assert.equal(imGitArbeitsbaum(tief, { existsSync: () => false }), false);
});

test('Token: bei jedem Fehler Exitcode 1, keine Seite, kein Netz, kein Rueckfall', async () => {
  for (const grund of ['Token fehlt', 'falscher Typ: gh-Anmeldung (gho_)']) {
    const ausgaben = [];
    let leserGebaut = false;
    let geschrieben = false;
    const code = await main([], {
      tokenLaden: () => ({ ok: false, grund }),
      leserBauen: () => { leserGebaut = true; return {}; },
      ausgabe: t => ausgaben.push(t),
      fsImpl: { writeFileSync: () => { geschrieben = true; }, renameSync: () => { geschrieben = true; }, mkdirSync: () => {}, existsSync: () => false, readFileSync: () => '{}' },
    });
    assert.equal(code, 1);
    assert.equal(leserGebaut, false);
    assert.equal(geschrieben, false);
    assert.deepEqual(ausgaben, [`Abbruch: ${grund}. Keine Seite geschrieben.`]);
  }
});
