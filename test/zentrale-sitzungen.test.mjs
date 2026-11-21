// B1.1 Command Center: lokale Sitzungen (W7). Nur *.json, nie .key, keine Links, nur die Positivliste der Felder.
globalThis.fetch = () => { throw new Error('W10: Netz in Zentrale-Tests verboten'); };

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { GRENZE_BYTES, leseSitzungen } from '../werkzeuge/zentrale/sitzungen-meta.mjs';

const ORDNER = join(tmpdir(), 'sitzungen-attrappe');
const SITZUNG = {
  pid: 18988, sessionId: '0123abcd-4567-89ef-0123-456789abcdef', cwd: 'C:\\Users\\nutzer\\Documents\\projekt', startedAt: 1795000000000,
  procStart: 'GEHEIM-PROCSTART', version: '2.1.326', peerProtocol: 1, peerFeatures: ['GEHEIM-PEER'], kind: 'interactive', entrypoint: 'cli',
  pidDomain: 'GEHEIM-DOMAIN', messagingSocketPath: '\\\\.\\pipe\\GEHEIM-SOCKET', name: 'b1-zentrale', nameSource: 'user', status: 'busy',
  updatedAt: 1795000600000, statusUpdatedAt: 1795000600000,
};
const VERBOTEN = ['GEHEIM', '18988', '456789abcdef', 'pipe', 'procStart', 'peer', 'messagingSocketPath', 'entrypoint', 'version'];

const dirent = (name, art = 'datei') => ({ name, isFile: () => art === 'datei', isSymbolicLink: () => art === 'link', isDirectory: () => art === 'ordner' });

// Attrappe: wirft bei jedem Zugriff auf eine .key-Datei (W7) und bei unbekannten Pfaden.
function dateien(eintraege, inhalte, { ordnerArt = 'ordner' } = {}) {
  const gelesen = [];
  return {
    gelesen,
    lstatSync(p) {
      if (p.endsWith('.key')) {
        throw new Error('W7: .key-Datei angefasst');
      }

      if (p === ORDNER) {
        return { isSymbolicLink: () => ordnerArt === 'link', isDirectory: () => ordnerArt === 'ordner', isFile: () => false, size: 0 };
      }

      const name = p.slice(ORDNER.length + 1);
      const e = eintraege.find(x => x.name === name);
      return { isSymbolicLink: () => e?.isSymbolicLink(), isFile: () => e?.isFile(), size: inhalte[name]?.groesse ?? Buffer.byteLength(inhalte[name]?.text ?? '') };
    },
    readdirSync(p, opt) {
      assert.equal(p, ORDNER);
      assert.deepEqual(opt, { withFileTypes: true });
      return eintraege;
    },
    readFileSync(p) {
      if (p.endsWith('.key')) {
        throw new Error('W7: .key-Datei geoeffnet');
      }

      gelesen.push(p.slice(ORDNER.length + 1));
      return inhalte[p.slice(ORDNER.length + 1)].text;
    },
  };
}

test('Sitzungen (W7): nur gewoehnliche *.json-Dateien, nur erlaubte Felder, .key wird nie geoeffnet', () => {
  const eintraege = [
    dirent('18988.json'), dirent('18988.5f700023d2abc0a3fcdc0ad60976791033f7bb3b0b242d786307b7a98a24dd00.key'), dirent('notiz.txt'),
    dirent('link.json', 'link'), dirent('ordner.json', 'ordner'), dirent('gross.json'), dirent('kaputt.json'), dirent('liste.json'), dirent('a.b.json'),
  ];
  const inhalte = {
    '18988.json': { text: JSON.stringify(SITZUNG) },
    'gross.json': { text: '{}', groesse: GRENZE_BYTES + 1 },
    'kaputt.json': { text: '{kein json' },
    'liste.json': { text: '[1,2]' },
  };
  const fs = dateien(eintraege, inhalte);
  const r = leseSitzungen({ ordner: ORDNER, fsImpl: fs });
  assert.equal(r.ok, true);
  assert.deepEqual(fs.gelesen.sort(), ['18988.json', 'kaputt.json', 'liste.json']);
  assert.equal(r.uebersprungen, 3);
  assert.deepEqual(r.eintraege, [{ name: 'b1-zentrale', cwd: SITZUNG.cwd, start: SITZUNG.startedAt, aktiv: SITZUNG.updatedAt, status: 'busy', kind: 'interactive', id8: '0123abcd' }]);
  const aus = JSON.stringify(r);

  for (const v of VERBOTEN) {
    assert.ok(!aus.includes(v), `${v} in der Ausgabe`);
  }
});

test('Sitzungen: unbrauchbare Feldwerte werden ersetzt, nie uebernommen', () => {
  const fs = dateien([dirent('1.json')], { '1.json': { text: JSON.stringify({ name: { x: 'GEHEIM' }, cwd: 'x'.repeat(501), startedAt: 'gestern', updatedAt: -1, status: 5, sessionId: 'GEHEIM-ID' }) } });
  const r = leseSitzungen({ ordner: ORDNER, fsImpl: fs });
  assert.deepEqual(r.eintraege, [{ name: '(ohne Namen)', cwd: 'unbekannt', start: null, aktiv: null, status: 'unbekannt', kind: 'unbekannt', id8: 'unbekannt' }]);
  assert.ok(!JSON.stringify(r).includes('GEHEIM'));
});

test('Sitzungen: Ordner als Link oder nicht lesbar ergibt einen Fehler, keine Werte', () => {
  assert.deepEqual(leseSitzungen({ ordner: ORDNER, fsImpl: dateien([], {}, { ordnerArt: 'link' }) }), { ok: false, grund: 'Sitzungsordner ist kein Ordner' });
  assert.deepEqual(leseSitzungen({ ordner: join(tmpdir(), 'gibt-es-nicht-zentrale-b1') }), { ok: false, grund: 'Sitzungsordner nicht lesbar' });
});

test('Sitzungen: echtes Dateisystem mit .key-Datei und fremder Datei', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zentrale-sitzungen-'));

  try {
    writeFileSync(join(dir, '1.json'), JSON.stringify(SITZUNG));
    writeFileSync(join(dir, '1.0123.key'), 'GEHEIM-SCHLUESSEL');
    writeFileSync(join(dir, 'x.txt'), 'GEHEIM-TEXT');
    const r = leseSitzungen({ ordner: dir });
    assert.equal(r.eintraege.length, 1);
    assert.ok(!JSON.stringify(r).includes('GEHEIM'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
