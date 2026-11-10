// A6.1: Tests fuer scripts/agent-profile.mjs.
// Rein lokal: keine Netzwerkanfragen, keine GitHub-Zugriffe, keine Zugangsdaten, kein Agentenstart.
// Git-Baeume entstehen nur in eigenen temporaeren Verzeichnissen ueber Plumbing-Befehle
// (keine Hooks) und werden danach entfernt. Das echte Repository wird nur ueber das
// Dateisystem gelesen, nie ueber Git.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_PROFILE_BYTES,
  PROFILE_KEYS,
  ProfileError,
  checkProfileFiles,
  isDeniedPath,
  loadPolicy,
  loadProfile,
  loadSettingsDraft,
  parseStrictJson,
  parseTreeOutput,
  settingsAllowForProfile,
  validateSettingsForProfile,
  readTree,
  validateIssueInput,
  validatePolicy,
  validateProfile,
  validateSettingsDraft,
} from '../scripts/agent-profile.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const POLICY_BYTES = readFileSync(join(ROOT, 'test/fixtures/agent-policy.entwurf.json'));
const SETTINGS_BYTES = readFileSync(join(ROOT, 'test/fixtures/claude-settings.entwurf.json'));

const canon = value => Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const DRAFT = Object.freeze({ entwurf: true });
const policy = () => clone(loadPolicy(POLICY_BYTES, DRAFT));
const settings = () => clone(loadSettingsDraft(SETTINGS_BYTES));

function baseProfile() {
  return {
    schema: 'agent-profile-v1',
    id: 'js-rechner',
    aktiv: true,
    dateien: ['src/rechne.js', 'test/rechne.test.js'],
    abnahme: 'issue',
    modell: 'sonnet',
    budget_usd: 1.5,
    max_runden: 8,
    max_laufzeit_minuten: 15,
    auftrag_rahmen: 'Erweitere den Rechner um die beschriebene Funktion.',
    pr_titel_praefix: 'feat:',
  };
}

function withChange(change) {
  const profile = baseProfile();
  change(profile);
  return profile;
}

function rejects(fn, code, prefix = 'Profilpruefung abgelehnt: ') {
  assert.throws(fn, error => {
    assert.ok(error instanceof ProfileError, `falscher Fehlertyp: ${error}`);
    assert.equal(error.code, code, `falscher Fehlercode, Meldung: ${error.message}`);
    assert.ok(error.message.startsWith(prefix), `falsche Meldung: ${error.message}`);
    return true;
  });
}

const rejectsIssue = (fn, code) => rejects(fn, code, 'Auftragspruefung abgelehnt: ');

const profileCheck = (profile, fileName = 'js-rechner.json', usedPolicy = policy()) =>
  () => validateProfile(profile, { policy: usedPolicy, fileName, entwurf: true });

// Temporaeres Repository, Baum nur aus Plumbing-Befehlen. Keine Hooks, keine Arbeitskopie.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(dir, args, input) {
  return execFileSync('git', args, {
    cwd: dir,
    env: GIT_ENV,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

function withTree(entries, check) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-profile-test-'));

  try {
    git(dir, ['init', '-q']);

    for (const { path, mode = '100644', content = 'x\n' } of entries) {
      const sha = mode === '160000'
        ? '1'.repeat(40)
        : git(dir, ['hash-object', '-w', '--stdin'], content);
      git(dir, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`]);
    }

    const tree = git(dir, ['write-tree']);
    const commit = git(dir, ['commit-tree', tree, '-m', 'Testbaum']);
    return check(dir, commit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Echte Dateien: die zwei Profile, die Entwuerfe, die Wirkungslosigkeit
// ---------------------------------------------------------------------------

test('Echte Profile: genau js-rechner und js-text, beide gueltig, js-text inaktiv', () => {
  const names = readdirSync(join(ROOT, 'agent-profiles')).sort();
  assert.deepEqual(names, ['js-rechner.json', 'js-text.json']);

  const loaded = Object.fromEntries(names.map(fileName => {
    const bytes = readFileSync(join(ROOT, 'agent-profiles', fileName));
    const { profile, sha256 } = loadProfile(bytes, { policy: policy(), fileName, entwurf: true });
    assert.match(sha256, /^[0-9a-f]{64}$/);
    return [profile.id, profile];
  }));

  assert.equal(loaded['js-rechner'].aktiv, true);
  assert.deepEqual([...loaded['js-rechner'].dateien], ['src/rechne.js', 'test/rechne.test.js']);
  assert.equal(loaded['js-text'].aktiv, false);
  assert.deepEqual([...loaded['js-text'].dateien], ['src/text.js', 'test/text.test.js']);
  assert.ok(!Object.hasOwn(loaded['js-rechner'], 'werkzeuge'));
});

test('Echte Dateien von js-rechner bestehen die Baumpruefung, js-text noch nicht', () => {
  const files = ['src/rechne.js', 'test/rechne.test.js'].map(path => ({
    path,
    content: readFileSync(join(ROOT, path), 'utf8'),
  }));
  const p = policy();
  const rechner = loadProfile(readFileSync(join(ROOT, 'agent-profiles/js-rechner.json')),
    { policy: p, fileName: 'js-rechner.json', entwurf: true }).profile;
  const text = loadProfile(readFileSync(join(ROOT, 'agent-profiles/js-text.json')),
    { policy: p, fileName: 'js-text.json', entwurf: true }).profile;

  withTree(files, (dir, sha) => {
    const tree = readTree(dir, sha);
    assert.equal(checkProfileFiles(rechner, tree), true);
    rejects(() => checkProfileFiles(text, tree), 'baum-fehlt');
  });
});

test('Entwuerfe: Policy und Claude-Einstellungen sind gueltig', () => {
  const p = loadPolicy(POLICY_BYTES, DRAFT);
  assert.equal(p.max_budget_usd, 1.5);
  assert.deepEqual(p.claude_werkzeuge, ['Read', 'Edit', 'Write']);
  assert.deepEqual(p.skript_hashes, {});
  const s = loadSettingsDraft(SETTINGS_BYTES);
  assert.ok(s.permissions.deny.includes('Bash'));
});

test('Ohne Wirkung: kein Workflow ruft die Profilpruefung auf', () => {
  const dir = join(ROOT, '.github/workflows');
  const workflows = readdirSync(dir).filter(name => name.endsWith('.yml'));
  assert.ok(workflows.length > 0, 'keine Workflows gefunden');

  for (const name of workflows) {
    const text = readFileSync(join(dir, name), 'utf8');
    assert.ok(!text.includes('agent-profile'), `${name} verweist auf agent-profile`);
    assert.ok(!text.includes('agent-profiles/'), `${name} verweist auf agent-profiles/`);
  }
});

test('Ohne Seiteneffekte: das Modul nutzt kein Netz, keine Umgebung, schreibt keine Dateien', () => {
  const source = readFileSync(join(ROOT, 'scripts/agent-profile.mjs'), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['node:child_process', 'node:crypto']);
  assert.ok(source.includes("import { execFileSync } from 'node:child_process';"));
  assert.equal(source.split('execFileSync(').length - 1, 1, 'genau ein Git-Aufruf erwartet');
  assert.ok(source.includes("execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', sha], {"));

  for (const word of ['fetch(', 'process.env', 'writeFile', 'appendFile', 'http', 'spawn', 'execSync', 'child_process.exec']) {
    assert.ok(!source.includes(word), `verbotenes Wort im Modul: ${word}`);
  }
});

// ---------------------------------------------------------------------------
// Kanonisches JSON
// ---------------------------------------------------------------------------

test('JSON: kanonische Form wird gelesen', () => {
  assert.deepEqual(parseStrictJson(canon({ a: 1, b: ['x'] }), 100), { a: 1, b: ['x'] });
});

test('JSON: Eingabe ohne Bytes, leer, zu gross, BOM, ungueltiges UTF-8 und CR werden abgelehnt', () => {
  rejects(() => parseStrictJson('{"a": 1}\n', 100), 'json-eingabe');
  rejects(() => parseStrictJson(Buffer.alloc(0), 100), 'json-leer');
  rejects(() => parseStrictJson(canon({ a: 'x'.repeat(200) }), 100), 'json-groesse');
  rejects(() => parseStrictJson(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canon({ a: 1 })]), 100), 'json-bom');
  rejects(() => parseStrictJson(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]), 100), 'json-utf8');
  rejects(() => parseStrictJson(Buffer.from('{\r\n  "a": 1\r\n}\r\n'), 100), 'json-zeilenende');
});

test('JSON: Syntaxfehler und Nicht-Objekte werden abgelehnt', () => {
  rejects(() => parseStrictJson(Buffer.from('{\n  "a": 1,\n}\n'), 100), 'json-syntax');
  rejects(() => parseStrictJson(Buffer.from('[]\n'), 100), 'json-objekt');
  rejects(() => parseStrictJson(Buffer.from('null\n'), 100), 'json-objekt');
});

test('JSON: doppelte Schluessel, Escapes, Zahlenschreibweisen und Formatierung werden abgelehnt', () => {
  const cases = [
    '{\n  "a": 1,\n  "a": 2\n}\n',
    '{\n  "a": "\\u0041"\n}\n',
    '{\n  "a": 1.50\n}\n',
    '{\n  "a": 1e0\n}\n',
    '{"a": 1}\n',
    '{\n  "a": 1\n}',
    '{\n    "a": 1\n}\n',
    '{\n  "a": 1\n}\n\n',
    '{\n  "a" : 1\n}\n',
  ];

  for (const text of cases) {
    rejects(() => parseStrictJson(Buffer.from(text), 100), 'json-kanonisch');
  }
});

test('JSON: Profil ueber der Groessengrenze wird abgelehnt', () => {
  const profile = baseProfile();
  profile.auftrag_rahmen = 'a'.repeat(MAX_PROFILE_BYTES);
  rejects(() => loadProfile(canon(profile), { policy: policy(), fileName: 'js-rechner.json', entwurf: true }), 'json-groesse');
});

// ---------------------------------------------------------------------------
// Profilstruktur
// ---------------------------------------------------------------------------

test('Profil: Grundfall und Grenzwerte sind gueltig', () => {
  assert.equal(profileCheck(baseProfile())().id, 'js-rechner');

  const edge = withChange(p => {
    p.budget_usd = 1.5;
    p.max_runden = 12;
    p.max_laufzeit_minuten = 20;
    p.dateien = ['src/a.js', 'src/b.mjs', 'test/a.test.js', 'test/b.test.mjs'];
    p.auftrag_rahmen = 'ä'.repeat(2000);
  });
  assert.equal(profileCheck(edge)().dateien.length, 4);
  assert.equal(profileCheck(withChange(p => { p.budget_usd = 0.01; }))().budget_usd, 0.01);
});

test('Profil: Ergebnis ist eingefroren', () => {
  const result = profileCheck(baseProfile())();
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.dateien));
});

test('Profil: zusaetzliches, fehlendes oder getarntes Feld wird abgelehnt', () => {
  rejects(profileCheck(withChange(p => { p.werkzeuge = ['Read']; })), 'profil-felder');
  rejects(profileCheck(withChange(p => { delete p.modell; })), 'profil-felder');
  rejects(profileCheck(withChange(p => {
    p.model = p.modell;
    delete p.modell;
  })), 'profil-felder');
  rejects(profileCheck(null), 'profil-felder');
  rejects(profileCheck(undefined), 'profil-felder');
  rejects(profileCheck([]), 'profil-felder');
  rejects(profileCheck(Object.assign(Object.create(null), baseProfile())), 'profil-felder');

  // "__proto__" wird von JSON.parse als eigenes Feld angelegt und muss auffallen.
  const text = canon(baseProfile()).toString().replace('"schema"', '"__proto__": {},\n  "schema"');
  rejects(() => loadProfile(Buffer.from(text), { policy: policy(), fileName: 'js-rechner.json', entwurf: true }), 'profil-felder');

  assert.equal(PROFILE_KEYS.length, 11);
});

test('Profil: falsches Schema wird abgelehnt', () => {
  rejects(profileCheck(withChange(p => { p.schema = 'agent-profile-v2'; })), 'profil-schema');
});

test('Profil: ungueltige IDs werden abgelehnt', () => {
  for (const id of ['JS-rechner', 'ab', '-abc', 'abc-', 'a--b', '1abc', 'a_bc', 'a'.repeat(32), 7]) {
    rejects(profileCheck(withChange(p => { p.id = id; }), `${id}.json`), 'profil-id');
  }

  // Eine Liste wuerde als Text "js-rechner" gelesen und sonst ueberall bestehen.
  rejects(profileCheck(withChange(p => { p.id = ['js-rechner']; }), 'js-rechner.json'), 'profil-id');
});

test('Profil: reservierte IDs werden abgelehnt', () => {
  for (const id of ['code-pilot', 'test-note']) {
    rejects(profileCheck(withChange(p => { p.id = id; }), `${id}.json`), 'profil-id-reserviert');
  }
});

test('Profil: ID und Dateiname muessen uebereinstimmen', () => {
  rejects(profileCheck(baseProfile(), 'js-text.json'), 'profil-dateiname');
  rejects(profileCheck(baseProfile(), 'agent-profiles/js-rechner.json'), 'profil-dateiname');
  rejects(profileCheck(baseProfile(), null), 'profil-dateiname');
  rejects(profileCheck(baseProfile(), 'js-rechner.JSON'), 'profil-dateiname');
});

test('Profil: aktiv muss ein Wahrheitswert sein', () => {
  for (const value of ['true', 1, null]) {
    rejects(profileCheck(withChange(p => { p.aktiv = value; })), 'profil-aktiv');
  }
});

test('Profil: Dateizahl 0, 5 und keine Liste werden abgelehnt', () => {
  rejects(profileCheck(withChange(p => { p.dateien = []; })), 'profil-dateizahl');
  rejects(profileCheck(withChange(p => {
    p.dateien = ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js', 'src/e.js'];
  })), 'profil-dateizahl');
  rejects(profileCheck(withChange(p => { p.dateien = 'src/rechne.js'; })), 'profil-dateizahl');
  rejects(profileCheck(withChange(p => { p.dateien = 'ab'; })), 'profil-dateizahl');
});

test('Profil: unzulaessige Pfade werden abgelehnt', () => {
  const bad = [
    'src/../x.js',
    './src/rechne.js',
    '/src/rechne.js',
    'src\\rechne.js',
    'src/*.js',
    'src/**',
    'src/sub/x.js',
    'SRC/x.js',
    'src/X.js',
    'src/x.ts',
    'src/x.json',
    'src/.hidden.js',
    'src/rechne.js ',
    'src/rechne.js\n',
    'scripts/x.mjs',
    '.github/x.js',
    'agent-profiles/x.js',
    'agent-acceptance/issue-1.mjs',
    'package.json',
    'src/',
    '',
  ];

  for (const file of bad) {
    rejects(profileCheck(withChange(p => { p.dateien = [file, 'src/rechne.js']; })), 'profil-pfad');
  }

  rejects(profileCheck(withChange(p => { p.dateien = [7]; })), 'profil-pfad-typ');
  rejects(profileCheck(withChange(p => { p.dateien = [['src/rechne.js']]; })), 'profil-pfad-typ');
});

test('Profil: doppelter Pfad wird abgelehnt', () => {
  rejects(profileCheck(withChange(p => { p.dateien = ['src/rechne.js', 'src/rechne.js']; })), 'profil-doppelt');
});

test('Profil: Pfad auf der Sperrliste der Policy wird abgelehnt, auch wenn die Pfadregel passt', () => {
  const p = policy();
  p.gesperrte_dateien.push('src/geheim.js');
  rejects(profileCheck(withChange(x => { x.dateien = ['src/geheim.js']; }), 'js-rechner.json', p), 'profil-gesperrt');

  assert.equal(isDeniedPath('scripts/x.mjs', policy()), true);
  assert.equal(isDeniedPath('src/CODEOWNERS', policy()), true);
  assert.equal(isDeniedPath('src/.git/config', policy()), true);
  assert.equal(isDeniedPath('src/rechne.js', policy()), false);
});

test('Profil: ohne Datei unter src/ wird abgelehnt', () => {
  rejects(profileCheck(withChange(p => { p.dateien = ['test/rechne.test.js']; })), 'profil-ohne-src');
});

test('Profil: Abnahme, Modell und PR-Praefix ausserhalb der Liste werden abgelehnt', () => {
  rejects(profileCheck(withChange(p => { p.abnahme = 'scripts/agent-code-acceptance.mjs'; })), 'profil-abnahme');
  rejects(profileCheck(withChange(p => { p.abnahme = 'npm test'; })), 'profil-abnahme');
  rejects(profileCheck(withChange(p => { p.modell = 'opus'; })), 'profil-modell');
  rejects(profileCheck(withChange(p => { p.modell = ['sonnet']; })), 'profil-modell');
  rejects(profileCheck(withChange(p => { p.pr_titel_praefix = 'chore:'; })), 'profil-praefix');
  rejects(profileCheck(withChange(p => { p.pr_titel_praefix = 'feat: [skip ci]'; })), 'profil-praefix');
});

test('Profil: Budget ueber der Grenze, null, negativ, als Text oder mit drei Nachkommastellen wird abgelehnt', () => {
  for (const value of [1.51, 2, 0, -1, '1.5', 1.234, null, true, [1], -0, 1n]) {
    rejects(profileCheck(withChange(p => { p.budget_usd = value; })), 'profil-budget');
  }
});

test('Profil: Runden und Laufzeit ausserhalb der Grenzen werden abgelehnt', () => {
  for (const value of [13, 0, 2.5, '8', -1]) {
    rejects(profileCheck(withChange(p => { p.max_runden = value; })), 'profil-runden');
  }

  for (const value of [21, 0, 7.5, '15']) {
    rejects(profileCheck(withChange(p => { p.max_laufzeit_minuten = value; })), 'profil-laufzeit');
  }
});

test('Profil: eine strengere Policy wird eingehalten', () => {
  const strict = policy();
  strict.max_budget_usd = 1;
  strict.max_runden = 5;
  strict.max_laufzeit_minuten = 10;
  strict.max_dateien = 1;
  strict.max_auftrag_rahmen_zeichen = 10;

  rejects(profileCheck(baseProfile(), 'js-rechner.json', strict), 'profil-dateizahl');
  rejects(profileCheck(withChange(p => { p.dateien = ['src/rechne.js']; }), 'js-rechner.json', strict), 'profil-budget');
  rejects(profileCheck(withChange(p => {
    p.dateien = ['src/rechne.js'];
    p.budget_usd = 1;
  }), 'js-rechner.json', strict), 'profil-runden');
  rejects(profileCheck(withChange(p => {
    p.dateien = ['src/rechne.js'];
    p.budget_usd = 1;
    p.max_runden = 5;
  }), 'js-rechner.json', strict), 'profil-laufzeit');
  rejects(profileCheck(withChange(p => {
    p.dateien = ['src/rechne.js'];
    p.budget_usd = 1;
    p.max_runden = 5;
    p.max_laufzeit_minuten = 10;
  }), 'js-rechner.json', strict), 'profil-rahmen');
});

test('Profil: Auftragsrahmen leer, zu lang oder mit versteckten Zeichen wird abgelehnt', () => {
  for (const value of ['', '   \n ', 'a'.repeat(2001), 7]) {
    rejects(profileCheck(withChange(p => { p.auftrag_rahmen = value; })), 'profil-rahmen');
  }

  for (const value of ['a\u0000b', 'a\u001bb', 'a\u202Eb', 'a\u2066b', 'a\u2028b', 'a\u200Fb', 'a\uFEFFb', 'a\uD800b']) {
    rejects(profileCheck(withChange(p => { p.auftrag_rahmen = value; })), 'profil-rahmen-zeichen');
  }

  // Ein Escape im kanonischen JSON besteht die Formpruefung, faellt aber hier auf.
  const text = canon(withChange(p => { p.auftrag_rahmen = 'a\u0007b'; }));
  assert.ok(text.toString().includes('\\u0007'));
  rejects(() => loadProfile(text, { policy: policy(), fileName: 'js-rechner.json', entwurf: true }), 'json-zeichen');
});

test('Profil: Pruefung lehnt eine ungueltige Policy ab, bevor das Profil zaehlt', () => {
  const broken = policy();
  broken.max_budget_usd = 5;
  rejects(profileCheck(baseProfile(), 'js-rechner.json', broken), 'policy-budget');
});

// ---------------------------------------------------------------------------
// Policy-Entwurf
// ---------------------------------------------------------------------------

test('Policy: Werte ueber den harten Grenzen werden abgelehnt', () => {
  const cases = [
    [p => { p.max_budget_usd = 1.51; }, 'policy-budget'],
    [p => { p.max_budget_usd = '1.5'; }, 'policy-budget'],
    [p => { p.max_runden = 13; }, 'policy-grenze'],
    [p => { p.max_laufzeit_minuten = 21; }, 'policy-grenze'],
    [p => { p.max_dateien = 5; }, 'policy-grenze'],
    [p => { p.max_auftrag_rahmen_zeichen = 2001; }, 'policy-grenze'],
    [p => { p.max_issue_titel_zeichen = 201; }, 'policy-grenze'],
    [p => { p.max_issue_text_zeichen = 4001; }, 'policy-grenze'],
    [p => { p.max_dateien = 0; }, 'policy-grenze'],
  ];

  for (const [change, code] of cases) {
    const p = policy();
    change(p);
    rejects(() => validatePolicy(p, DRAFT), code);
  }
});

test('Policy: Modelle, Werkzeuge und Praefixe ausserhalb der harten Listen werden abgelehnt', () => {
  const cases = [
    [p => { p.modelle = ['opus']; }, 'policy-modelle'],
    [p => { p.modelle = []; }, 'policy-modelle'],
    [p => { p.claude_werkzeuge = ['Read', 'Bash']; }, 'policy-werkzeuge'],
    [p => { p.claude_werkzeuge = ['Read', 'Read']; }, 'policy-werkzeuge'],
    [p => { p.claude_werkzeuge = ['WebFetch']; }, 'policy-werkzeuge'],
    [p => { p.pr_titel_praefixe = ['chore:']; }, 'policy-praefixe'],
    [p => { p.pr_titel_praefixe = []; }, 'policy-praefixe'],
    [p => { p.claude_werkzeuge = []; }, 'policy-werkzeuge'],
    [p => { p.claude_werkzeuge = 'Read'; }, 'policy-werkzeuge'],
    [p => { p.modelle = [['sonnet']]; }, 'policy-modelle'],
  ];

  for (const [change, code] of cases) {
    const p = policy();
    change(p);
    rejects(() => validatePolicy(p, DRAFT), code);
  }
});

test('Policy: unvollstaendige Sperrlisten und reservierte IDs werden abgelehnt', () => {
  const cases = [
    [p => { p.gesperrte_praefixe = p.gesperrte_praefixe.filter(x => x !== 'scripts/'); }, 'policy-sperrliste'],
    [p => { p.gesperrte_praefixe = p.gesperrte_praefixe.filter(x => x !== '.git/'); }, 'policy-sperrliste'],
    [p => { p.gesperrte_praefixe.push('src'); }, 'policy-sperrliste'],
    [p => { p.gesperrte_praefixe = []; }, 'policy-sperrliste'],
    [p => { p.gesperrte_dateien = p.gesperrte_dateien.filter(x => x !== 'CODEOWNERS'); }, 'policy-sperrliste'],
    [p => { p.gesperrte_dateien = p.gesperrte_dateien.filter(x => x !== 'package.json'); }, 'policy-sperrliste'],
    [p => { p.reservierte_ids = ['code-pilot']; }, 'policy-reserviert'],
    [p => { p.reservierte_ids.push('Gross'); }, 'policy-reserviert'],
    [p => { p.gesperrte_dateien.push(''); }, 'policy-sperrliste'],
    [p => { p.gesperrte_dateien.push('CODEOWNERS'); }, 'policy-sperrliste'],
  ];

  for (const [change, code] of cases) {
    const p = policy();
    change(p);
    rejects(() => validatePolicy(p, DRAFT), code);
  }
});

test('Policy: jeder Pflichteintrag der Sperrlisten und reservierten IDs ist einzeln erzwungen', () => {
  // Eigene Listen im Test, damit eine Kuerzung der Pflichtlisten im Modul auffaellt.
  const lists = [
    ['gesperrte_praefixe', ['.git/', '.github/', '.claude/', 'scripts/', 'agent-profiles/',
      'agent-acceptance/', 'node_modules/'], 'policy-sperrliste'],
    ['gesperrte_dateien', ['CODEOWNERS', 'package.json', 'package-lock.json', 'CLAUDE.md', '.mcp.json',
      '.gitmodules', '.gitattributes', '.gitignore', '.npmrc'], 'policy-sperrliste'],
    ['reservierte_ids', ['code-pilot', 'test-note'], 'policy-reserviert'],
  ];

  for (const [key, required, code] of lists) {
    for (const entry of required) {
      const p = policy();
      p[key] = p[key].filter(x => x !== entry);
      rejects(() => validatePolicy(p, DRAFT), code);
    }
  }
});

test('Policy: Felder, Schema und Skript-Hashes werden streng geprueft', () => {
  const cases = [
    [p => { p.extra = true; }, 'policy-felder'],
    [p => { delete p.skript_hashes; }, 'policy-felder'],
    [p => { p.schema = 'agent-policy-v0'; }, 'policy-schema'],
    [p => { p.skript_hashes = { 'scripts/agent-code-publish.mjs': 'abc' }; }, 'policy-hashes'],
    [p => { p.skript_hashes = { 'src/rechne.js': 'a'.repeat(64) }; }, 'policy-hashes'],
    [p => { p.skript_hashes = []; }, 'policy-hashes'],
    [p => { p.skript_hashes = { 'scripts/agent-profile.mjs': ['a'.repeat(64)] }; }, 'policy-hashes'],
  ];

  for (const [change, code] of cases) {
    const p = policy();
    change(p);
    rejects(() => validatePolicy(p, DRAFT), code);
  }

  const ok = policy();
  ok.skript_hashes = { 'scripts/agent-profile.mjs': 'a'.repeat(64) };
  assert.equal(validatePolicy(ok), ok);
});

test('Policy: leere Skript-Hashes sind nur im Entwurf erlaubt', () => {
  assert.deepEqual(policy().skript_hashes, {});
  rejects(() => validatePolicy(policy()), 'policy-hashes-fehlen');
  rejects(() => loadPolicy(POLICY_BYTES), 'policy-hashes-fehlen');
  rejects(() => validateProfile(baseProfile(), { policy: policy(), fileName: 'js-rechner.json' }), 'policy-hashes-fehlen');

  const other = policy();
  other.skript_hashes = { 'scripts/agent-code-publish.mjs': 'a'.repeat(64) };
  rejects(() => validatePolicy(other), 'policy-hashes-fehlen');
});

test('Profil: Dateien der Agenten-Werkzeuge unter src/ und test/ sind hart gesperrt', () => {
  for (const file of ['test/agent-profile.test.mjs', 'test/agent-code-publish.test.mjs', 'src/agent-x.js', 'test/agent_profile.test.mjs', 'src/agentprofile.js']) {
    rejects(profileCheck(withChange(p => { p.dateien = ['src/rechne.js', file]; })), 'profil-gesperrt');
  }
});

test('JSON: unsichtbare Zeichen in Schluesseln und Texten werden abgelehnt, auch als Escape', () => {
  const cases = [
    `{\n  "a${cp(0x202e)}": 1\n}\n`,
    `{\n  "a": "x${cp(0x200b)}y"\n}\n`,
    '{\n  "a": "x\\u001by"\n}\n',
    '{\n  "a": "x\\ud800y"\n}\n',
    `{\n  "a": [\n    "x${cp(0xe0049)}"\n  ]\n}\n`,
  ];

  for (const text of cases) {
    rejects(() => parseStrictJson(Buffer.from(text, 'utf8'), 200), 'json-zeichen');
  }
});

// ---------------------------------------------------------------------------
// Git-Baum des Ausgangscommits
// ---------------------------------------------------------------------------

test('Baum: gewoehnliche Dateien bestehen', () => {
  withTree([
    { path: 'src/rechne.js' },
    { path: 'test/rechne.test.js' },
  ], (dir, sha) => {
    assert.equal(checkProfileFiles(profileCheck(baseProfile())(), readTree(dir, sha)), true);
  });
});

test('Baum: fehlende Datei, Symlink, ausfuehrbare Datei, Unterprojekt und Verzeichnis werden abgelehnt', () => {
  const variants = [
    [[{ path: 'test/rechne.test.js' }], 'baum-fehlt'],
    [[{ path: 'src/rechne.js', mode: '120000', content: '../../etc/passwd' }, { path: 'test/rechne.test.js' }], 'baum-modus'],
    [[{ path: 'src/rechne.js', mode: '100755' }, { path: 'test/rechne.test.js' }], 'baum-modus'],
    [[{ path: 'src/rechne.js', mode: '160000' }, { path: 'test/rechne.test.js' }], 'baum-modus'],
    [[{ path: 'src/rechne.js/x.js' }, { path: 'test/rechne.test.js' }], 'baum-fehlt'],
  ];

  for (const [entries, code] of variants) {
    withTree(entries, (dir, sha) => {
      rejects(() => checkProfileFiles(profileCheck(baseProfile())(), readTree(dir, sha)), code);
    });
  }
});

test('Baum: ungueltiger oder unbekannter Ausgangscommit wird abgelehnt', () => {
  withTree([{ path: 'src/rechne.js' }], (dir, sha) => {
    rejects(() => readTree(dir, sha.toUpperCase()), 'baum-sha');
    rejects(() => readTree(dir, `--output=${sha}`), 'baum-sha');
    rejects(() => readTree(dir, 'HEAD'), 'baum-sha');
    rejects(() => readTree(dir, 'f'.repeat(40)), 'baum-git');
  });

  rejects(() => checkProfileFiles(profileCheck(baseProfile())(), {}), 'baum-eingabe');
});

test('Baum: Liste statt Text als Commit wird abgelehnt', () => {
  rejects(() => readTree('.', ['a'.repeat(40)]), 'baum-sha');
});

test('Baum: unerwartete oder doppelte Zeilen von git ls-tree werden abgelehnt', () => {
  const ok = `100644 blob ${'a'.repeat(40)}\tsrc/rechne.js\0`;
  assert.deepEqual([...parseTreeOutput(ok).keys()], ['src/rechne.js']);
  rejects(() => parseTreeOutput(undefined), 'baum-format');
  rejects(() => parseTreeOutput('kaputt\0'), 'baum-format');
  rejects(() => parseTreeOutput(`100644 blob ${'a'.repeat(40)} src/rechne.js\0`), 'baum-format');
  rejects(() => parseTreeOutput(ok + ok), 'baum-doppelt');
});

test('Baum: ein Eintrag, der zugleich Elternordner ist, wird abgelehnt', () => {
  const blob = 'a'.repeat(40);
  rejects(() => parseTreeOutput(`120000 blob ${blob}\tsrc\x00100644 blob ${blob}\tsrc/a.js\0`), 'baum-konflikt');
  rejects(() => parseTreeOutput(`100644 blob ${blob}\tsrc/a.js\x00100644 blob ${blob}\tsrc\0`), 'baum-konflikt');
  rejects(() => parseTreeOutput(`160000 commit ${blob}\ttest\x00100644 blob ${blob}\ttest/b.test.js\0`), 'baum-konflikt');

  // Echter Git-Baum: src ist Symlink und Ordner zugleich (git mktree nimmt das an).
  const dir = mkdtempSync(join(tmpdir(), 'agent-profile-test-'));

  try {
    git(dir, ['init', '-q']);
    const file = git(dir, ['hash-object', '-w', '--stdin'], 'x\n');
    const link = git(dir, ['hash-object', '-w', '--stdin'], 'scripts');
    const sub = git(dir, ['mktree'], `100644 blob ${file}\ta.js\n`);
    const root = git(dir, ['mktree'], `120000 blob ${link}\tsrc\n040000 tree ${sub}\tsrc\n`);
    const commit = git(dir, ['commit-tree', root, '-m', 'Konflikt']);
    rejects(() => readTree(dir, commit), 'baum-konflikt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Baum: Eintrag mit richtigem Modus, aber falschem Typ wird abgelehnt', () => {
  const tree = new Map([
    ['src/rechne.js', { mode: '100644', type: 'tree' }],
    ['test/rechne.test.js', { mode: '100644', type: 'blob' }],
  ]);
  rejects(() => checkProfileFiles(profileCheck(baseProfile())(), tree), 'baum-modus');
});

// ---------------------------------------------------------------------------
// Issue-Eingaben
// ---------------------------------------------------------------------------

test('Issue: CRLF wird normalisiert, Umlaute bleiben, Hash ist stabil', () => {
  const a = validateIssueInput('Division für den Rechner', 'Zeile eins\r\nZeile zwei mit Tab\tund ä');
  const b = validateIssueInput('Division für den Rechner', 'Zeile eins\nZeile zwei mit Tab\tund ä');
  assert.equal(a.text, 'Zeile eins\nZeile zwei mit Tab\tund ä');
  assert.equal(a.sha256, b.sha256);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(validateIssueInput('Titel', 'Text').sha256, validateIssueInput('Titel', 'Text ').sha256);
  assert.ok(Object.isFrozen(a));
});

test('Issue: Grenzwerte 200 und 4000 Zeichen bestehen, auch mit mehrteiligen Zeichen', () => {
  assert.equal(validateIssueInput('t'.repeat(200), 'x'.repeat(4000)).text.length, 4000);
  assert.equal([...validateIssueInput('😀'.repeat(200), '😀'.repeat(4000)).text].length, 4000);
});

test('Issue: falsche Typen, einzelnes CR und Laengen werden abgelehnt', () => {
  rejectsIssue(() => validateIssueInput('Titel', null), 'issue-typ');
  rejectsIssue(() => validateIssueInput(undefined, 'Text'), 'issue-typ');
  rejectsIssue(() => validateIssueInput('Titel', 'a\rb'), 'issue-zeilenende');
  rejectsIssue(() => validateIssueInput('Ti\rtel', 'Text'), 'issue-zeilenende');
  // CRLF im Titel wird zuerst zu LF und faellt dann als Zeilenumbruch auf.
  rejectsIssue(() => validateIssueInput('Ti\r\ntel', 'Text'), 'issue-titel-zeichen');
  rejectsIssue(() => validateIssueInput('', 'Text'), 'issue-titel-laenge');
  rejectsIssue(() => validateIssueInput('   ', 'Text'), 'issue-titel-laenge');
  rejectsIssue(() => validateIssueInput('t'.repeat(201), 'Text'), 'issue-titel-laenge');
  rejectsIssue(() => validateIssueInput('Titel', ''), 'issue-text-laenge');
  rejectsIssue(() => validateIssueInput('Titel', ' \n\t '), 'issue-text-laenge');
  rejectsIssue(() => validateIssueInput('Titel', 'x'.repeat(4001)), 'issue-text-laenge');
});

test('Issue: Steuer-, Richtungs- und Trennzeichen werden abgelehnt', () => {
  for (const value of ['a\nb', 'a\tb', 'a\u0000b', 'a\u202Eb']) {
    rejectsIssue(() => validateIssueInput(value, 'Text'), 'issue-titel-zeichen');
  }

  for (const value of ['a\u0000b', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\u202Eb', 'a\u2066b',
    'a\u2069b', 'a\u2028b', 'a\u2029b', 'a\u200Eb', 'a\u061Cb', 'a\uFEFFb', 'a\uD800b']) {
    rejectsIssue(() => validateIssueInput('Titel', value), 'issue-text-zeichen');
  }
});

test('Issue: eine strengere Policy-Grenze gilt, eine lockerere nicht', () => {
  const strict = { max_issue_titel_zeichen: 5, max_issue_text_zeichen: 10 };
  rejectsIssue(() => validateIssueInput('sechs!', 'Text', strict), 'issue-titel-laenge');
  rejectsIssue(() => validateIssueInput('Titel', 'elf Zeichen', strict), 'issue-text-laenge');

  // Zu lockere, fehlende oder falsche Grenzen brechen ab, statt still keine Grenze zu setzen.
  for (const limits of [
    { max_issue_titel_zeichen: 999, max_issue_text_zeichen: 4000 },
    { max_issue_titel_zeichen: 200, max_issue_text_zeichen: 99_999 },
    {},
    null,
    baseProfile(),
    { max_issue_titel_zeichen: 'abc', max_issue_text_zeichen: 4000 },
    { max_issue_titel_zeichen: 200, max_issue_text_zeichen: 0 },
    Object.create({ max_issue_titel_zeichen: 200, max_issue_text_zeichen: 4000 }),
  ]) {
    rejectsIssue(() => validateIssueInput('Titel', 'Text', limits), 'issue-grenzen');
  }

  assert.equal(validateIssueInput('Titel', 'Text', policy()).titel, 'Titel');
});

// Zeichen ueber ihren Codepunkt, damit kein Werkzeug sie unterwegs umwandelt.
const cp = code => String.fromCodePoint(code);

test('Issue und Rahmen: unsichtbare Zeichen jeder verbotenen Kategorie werden abgelehnt', () => {
  const invisible = [
    0x200b, // Cf: Breite null
    0x200d, // Cf: Verbinder
    0x2060, // Cf: Wortverbinder
    0x00ad, // Cf: weiches Trennzeichen
    0xfff9, // Cf: Interlinear-Anmerkung
    0x180e, // Cf: mongolischer Vokaltrenner
    0xe0049, // Cf: Tag-Zeichen (ASCII-Schmuggel)
    0xe000, // Co: private Nutzung
    0x0378, // Cn: nicht vergeben
    0x001b, // Cc
    0x2028, // Zl
    0x2029, // Zp
    0x115f, // Hangul-Fuellzeichen
    0x17b4, // Khmer, unsichtbar
    0x180b, // mongolischer Variationsselektor
    0x2800, // leeres Braille-Muster
    0x3164, // Hangul-Fuellzeichen
    0xfe0f, // Variationsselektor
    0xffa0, // halbbreites Hangul-Fuellzeichen
    0xe0100, // ergaenzender Variationsselektor
  ];

  for (const code of invisible) {
    const value = `a${cp(code)}b`;
    rejectsIssue(() => validateIssueInput(value, 'Text'), 'issue-titel-zeichen');
    rejectsIssue(() => validateIssueInput('Titel', value), 'issue-text-zeichen');
    rejects(profileCheck(withChange(p => { p.auftrag_rahmen = value; })), 'profil-rahmen-zeichen');
  }

  // Weitere leer wirkende Zeichen ausserhalb der Kategorien.
  for (const code of [0x034f, 0x16fe4, 0x303f, 0x1d159, 0xfffc]) {
    rejectsIssue(() => validateIssueInput('Titel', `a${cp(code)}b`), 'issue-text-zeichen');
  }

  // Titel, Text oder Rahmen ohne einen einzigen sichtbaren Buchstaben, Ziffer, Satz- oder
  // Symbolzeichen gelten als leer, auch wenn die Zeichen selbst nicht verboten sind.
  for (const empty of [cp(0x200b), `${cp(0x301)}${cp(0x301)}${cp(0x301)}`, cp(0x3000), `${cp(0xa0)} ${cp(0x2003)}`]) {
    rejectsIssue(() => validateIssueInput(empty, 'Text'), 'issue-titel-laenge');
    rejectsIssue(() => validateIssueInput('Titel', empty), 'issue-text-laenge');
    rejects(profileCheck(withChange(p => { p.auftrag_rahmen = empty; })), 'profil-rahmen');
  }

  // Ein einzelnes Satz- oder Symbolzeichen oder eine Ziffer reicht.
  assert.equal(validateIssueInput('?', '+').titel, '?');
  assert.equal(validateIssueInput('7', '8').text, '8');

  // Sichtbare Zeichen ausserhalb von ASCII bleiben erlaubt.
  assert.equal(validateIssueInput(`Gr${cp(0xfc)}${cp(0xdf)}e ${cp(0x1f600)}`, `Caf${cp(0xe9)}`).text, `Caf${cp(0xe9)}`);
});

// ---------------------------------------------------------------------------
// Entwurf der Claude-Einstellungen (nur Struktur, Wirkung erst durch K1)
// ---------------------------------------------------------------------------

test('Einstellungen: genau die Erlaubnisse eines Profils sind gueltig', () => {
  const allow = settingsAllowForProfile(profileCheck(baseProfile())());
  assert.deepEqual(allow, ['Read(./src/rechne.js)', 'Edit(./src/rechne.js)',
    'Read(./test/rechne.test.js)', 'Edit(./test/rechne.test.js)']);
  const s = settings();
  s.permissions.allow = allow;
  assert.equal(validateSettingsDraft(s), s);
  assert.equal(validateSettingsForProfile(s, profileCheck(baseProfile())()), s);
});

test('Einstellungen: allow muss genau zum Profil passen', () => {
  const profile = profileCheck(baseProfile())();
  const variants = [
    ['Edit(./src/other.js)'],
    [],
    ['Read(./src/rechne.js)', 'Edit(./src/rechne.js)', 'Read(./test/rechne.test.js)'],
    ['Edit(./src/rechne.js)', 'Read(./src/rechne.js)', 'Read(./test/rechne.test.js)', 'Edit(./test/rechne.test.js)'],
    [...settingsAllowForProfile(profile), 'Read(./src/other.js)'],
  ];

  for (const allow of variants) {
    const s = settings();
    s.permissions.allow = allow;
    rejects(() => validateSettingsForProfile(s, profile), 'einstellungen-profil');
  }

  // Die allgemeine Pruefung laeuft vorher mit.
  const broken = settings();
  broken.permissions.allow = settingsAllowForProfile(profile);
  broken.permissions.deny = broken.permissions.deny.filter(x => x !== 'Bash');
  rejects(() => validateSettingsForProfile(broken, profile), 'einstellungen-deny');
});

test('Einstellungen: fehlende Pflichtverbote werden abgelehnt', () => {
  // Eigene Liste im Test, damit eine Kuerzung der Pflichtliste im Modul auffaellt.
  for (const rule of ['Bash', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
    'Read(./.git/**)', 'Edit(./.git/**)', 'Write(./.git/**)', 'Read(//proc/**)',
    'Read(~/**)', 'Edit(~/**)', 'Write(~/**)', 'Read(//home/runner/work/_temp/**)',
    'Edit(//home/runner/work/_temp/**)', 'Write(//home/runner/work/_temp/**)',
    ...['.github', '.claude', 'scripts', 'agent-profiles', 'agent-acceptance'].flatMap(dir =>
      [`Read(./${dir}/**)`, `Edit(./${dir}/**)`, `Write(./${dir}/**)`])]) {
    const s = settings();
    s.permissions.deny = s.permissions.deny.filter(x => x !== rule);
    rejects(() => validateSettingsDraft(s), 'einstellungen-deny');
  }
});

test('Einstellungen: ganze Werkzeuge, Shell, Netz und Pfade ausserhalb werden als Erlaubnis abgelehnt', () => {
  for (const rule of ['Read', 'Edit', 'Write', 'Bash', 'Bash(npm test)', 'WebFetch', 'Read(//proc/**)',
    'Read(~/**)', 'Read(./.git/config)', 'Read(./src/../.git/config)', 'Read(./scripts/**)', 'Edit(src/rechne.js)',
    'Edit(./src/**)', 'Read(./src/*.js)', 'Write(./test/rechne.test.js)', 'Write(./test/**)',
    'Edit(./src/.git/config)', 'Edit(./src/**/.claude/**)', 'Read(./src/sub/a.js)', 'Edit(./test/fixtures/x.json)',
    'Edit(./test/agent-profile.test.mjs)', 'Edit(./src/agent-x.js)', 'Edit(./src/rechne.js) ', 'Edit(./src/(a).js)']) {
    const s = settings();
    s.permissions.allow = [rule];
    rejects(() => validateSettingsDraft(s), 'einstellungen-allow');
  }
});

test('Einstellungen: zusaetzliche Felder und falsche Typen werden abgelehnt', () => {
  const extra = settings();
  extra.env = { ANTHROPIC_BASE_URL: 'https://example.invalid' };
  rejects(() => validateSettingsDraft(extra), 'einstellungen-felder');

  const mode = settings();
  mode.permissions.defaultMode = 'bypassPermissions';
  rejects(() => validateSettingsDraft(mode), 'einstellungen-felder');

  const dup = settings();
  dup.permissions.deny.push('Bash');
  rejects(() => validateSettingsDraft(dup), 'einstellungen-deny');

  const nested = settings();
  nested.permissions.deny.push(['Bash']);
  rejects(() => validateSettingsDraft(nested), 'einstellungen-deny');

  const allowText = settings();
  allowText.permissions.allow = 'Read(./src/rechne.js)';
  rejects(() => validateSettingsDraft(allowText), 'einstellungen-allow');

  const allowNumber = settings();
  allowNumber.permissions.allow = [7];
  rejects(() => validateSettingsDraft(allowNumber), 'einstellungen-allow');

  const allowDup = settings();
  allowDup.permissions.allow = ['Edit(./src/rechne.js)', 'Edit(./src/rechne.js)'];
  rejects(() => validateSettingsDraft(allowDup), 'einstellungen-allow');
});
