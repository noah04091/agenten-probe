// A6.1: Pruefung von Auftragsprofilen, Policy-Entwurf, Claude-Einstellungsentwurf und Issue-Eingaben.
// Ohne Wirkung: Kein Workflow ruft diese Datei auf. Keine Netzwerkzugriffe, keine Zugangsdaten.
// Nur node:-Module. Die harten Obergrenzen stehen hier im Code; eine Policy darf strenger sein,
// nie lockerer.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const PROFILE_SCHEMA = 'agent-profile-v1';
export const POLICY_SCHEMA = 'agent-policy-v1';

export const PROFILE_KEYS = Object.freeze([
  'schema',
  'id',
  'aktiv',
  'dateien',
  'abnahme',
  'modell',
  'budget_usd',
  'max_runden',
  'max_laufzeit_minuten',
  'auftrag_rahmen',
  'pr_titel_praefix',
]);

export const POLICY_KEYS = Object.freeze([
  'schema',
  'modelle',
  'claude_werkzeuge',
  'max_budget_usd',
  'max_runden',
  'max_laufzeit_minuten',
  'max_dateien',
  'max_auftrag_rahmen_zeichen',
  'max_issue_titel_zeichen',
  'max_issue_text_zeichen',
  'gesperrte_praefixe',
  'gesperrte_dateien',
  'reservierte_ids',
  'pr_titel_praefixe',
  'skript_hashes',
]);

// Harte Obergrenzen. Eine Policy darf sie nur unterschreiten.
export const HARD_LIMITS = Object.freeze({
  max_budget_usd: 1.5,
  max_runden: 12,
  max_laufzeit_minuten: 20,
  max_dateien: 4,
  max_auftrag_rahmen_zeichen: 2000,
  max_issue_titel_zeichen: 200,
  max_issue_text_zeichen: 4000,
});

export const MAX_PROFILE_BYTES = 8192;
export const MAX_POLICY_BYTES = 16384;
export const MAX_SETTINGS_BYTES = 16384;

const HARD_MODELS = Object.freeze(['sonnet']);
const HARD_TOOLS = Object.freeze(['Read', 'Edit', 'Write']);
const HARD_PR_PREFIXES = Object.freeze(['feat:', 'fix:', 'test:']);

// Diese Eintraege muss jede Policy mindestens sperren beziehungsweise reservieren.
export const REQUIRED_DENIED_PREFIXES = Object.freeze([
  '.git/',
  '.github/',
  '.claude/',
  'scripts/',
  'agent-profiles/',
  'agent-acceptance/',
  'node_modules/',
]);
export const REQUIRED_DENIED_FILES = Object.freeze([
  'CODEOWNERS',
  'package.json',
  'package-lock.json',
  'CLAUDE.md',
  '.mcp.json',
  '.gitmodules',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
]);
export const REQUIRED_RESERVED_IDS = Object.freeze(['code-pilot', 'test-note']);

// Pflicht-Verbote im Entwurf der Claude-Einstellungen (Wirkung erst durch K1 belegt).
export const REQUIRED_SETTINGS_DENY = Object.freeze([
  'Bash',
  'WebFetch',
  'WebSearch',
  'Task',
  'NotebookEdit',
  'Read(./.git/**)',
  'Edit(./.git/**)',
  'Write(./.git/**)',
  'Read(//proc/**)',
  'Read(~/**)',
  'Edit(~/**)',
  'Write(~/**)',
  'Read(//home/runner/work/_temp/**)',
  'Edit(//home/runner/work/_temp/**)',
  'Write(//home/runner/work/_temp/**)',
  ...['.github', '.claude', 'scripts', 'agent-profiles', 'agent-acceptance'].flatMap(dir => [
    `Read(./${dir}/**)`,
    `Edit(./${dir}/**)`,
    `Write(./${dir}/**)`,
  ]),
]);

// A6: nur bereits vorhandene Dateien direkt unter src/ oder test/, keine Unterordner.
export const PATH_RE = /^(src|test)\/[a-z0-9_-]+(\.test)?\.(js|mjs)$/;
export const ID_RE = /^[a-z][a-z0-9-]{1,29}[a-z0-9]$/;
const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const SCRIPT_PATH_RE = /^scripts\/agent-(code-[a-z-]+|profile)\.mjs$/;
const TREE_LINE_RE = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/s;

// Verbotene Unicode-Kategorien: Cc Steuerzeichen (Zeilenumbruch und Tab werden vorher
// gesondert behandelt), Cf Formatzeichen (unsichtbare Zeichen, Bidi-Steuerung, BOM,
// Tag-Zeichen ab U+E0000), Co private Nutzung, Cn nicht vergeben, Zl und Zp Trenner.
// Einzelne Surrogate (Cs) faengt isWellFormed ab.
const FORBIDDEN_CATEGORIES = ['Cc', 'Cf', 'Co', 'Cn', 'Zl', 'Zp'];
const FORBIDDEN_CATEGORY_RE = new RegExp(
  '[' + FORBIDDEN_CATEGORIES.map(category => '\\' + 'p{' + category + '}').join('') + ']',
  'u'
);

// Unsichtbare oder leer wirkende Zeichen ausserhalb dieser Kategorien.
const FORBIDDEN_RANGES = [
  [0x115f, 0x1160], // Hangul-Fuellzeichen
  [0x17b4, 0x17b5], // unsichtbare Khmer-Vokale
  [0x180b, 0x180f], // mongolische Variationsselektoren
  [0x2800, 0x2800], // leeres Braille-Muster
  [0x3164, 0x3164], // Hangul-Fuellzeichen
  [0xfe00, 0xfe0f], // Variationsselektoren
  [0xffa0, 0xffa0], // halbbreites Hangul-Fuellzeichen
  [0xe0100, 0xe01ef], // ergaenzende Variationsselektoren
  [0x034f, 0x034f], // unsichtbarer Graphem-Verbinder
  [0x16fe4, 0x16fe4], // Khitan-Fuellzeichen
  [0x303f, 0x303f], // ideografisches halbes Fuellleerzeichen
  [0x1d159, 0x1d159], // leerer Notenkopf
  [0xfffc, 0xfffc], // Objekt-Ersatzzeichen
];

// Ein Text gilt nur dann als nicht leer, wenn er mindestens einen Buchstaben, eine Ziffer,
// ein Satz- oder ein Symbolzeichen enthaelt. Leerraum und kombinierende Zeichen allein zaehlen
// nicht. Das faengt auch kuenftige, hier nicht gelistete Fuellzeichen ab.
const VISIBLE_CONTENT_RE = new RegExp(
  '[' + ['L', 'N', 'P', 'S'].map(category => '\\' + 'p{' + category + '}').join('') + ']',
  'u'
);
const codeEscape = code => '\\' + 'u{' + code.toString(16) + '}';
const FORBIDDEN_RANGE_RE = new RegExp(
  '[' + FORBIDDEN_RANGES.map(([from, to]) => `${codeEscape(from)}-${codeEscape(to)}`).join('') + ']',
  'u'
);

// Profil- und Testdateien der Agenten-Werkzeuge darf kein Profil freigeben, auch wenn die
// Pfadregel passt (sonst koennte ein Agent die Wachen in npm test aushoehlen).
const HARD_DENIED_PATH_RE = /^(src|test)\/agent/;

export class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProfileError(code, `Profilpruefung abgelehnt: ${message}`);
}

function failIssue(code, message) {
  throw new ProfileError(code, `Auftragspruefung abgelehnt: ${message}`);
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function sameKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function codePoints(text) {
  return [...text].length;
}

function isUniqueStringList(list) {
  return (
    Array.isArray(list) &&
    list.every(item => typeof item === 'string' && item.length > 0) &&
    new Set(list).size === list.length
  );
}

function isPositiveInteger(value, max) {
  return Number.isInteger(value) && value >= 1 && value <= max;
}

// Nur endliche Zahlen mit hoechstens zwei Nachkommastellen; NaN und Unendlich scheitern an
// den Vergleichen, BigInt am Typ.
function isBudget(value, max) {
  return (
    typeof value === 'number' &&
    value > 0 &&
    value <= max &&
    Math.round(value * 100) / 100 === value
  );
}

// Text darf nur Zeichen enthalten, die ein Pruefer auch sieht.
function checkVisibleText(text, { multiline }) {
  if (!text.isWellFormed()) {
    return 'ungueltige Unicode-Zeichen';
  }

  if (!multiline && /[\n\t]/.test(text)) {
    return 'Zeilenumbruch oder Tab nicht erlaubt';
  }

  const rest = text.replace(/[\n\t]/g, '');

  if (FORBIDDEN_CATEGORY_RE.test(rest) || FORBIDDEN_RANGE_RE.test(rest)) {
    return 'unsichtbare, Steuer- oder Richtungszeichen';
  }

  return null;
}

// Prueft alle Schluessel und Texte eines gelesenen JSON-Werts auf sichtbare Zeichen.
function checkJsonText(value) {
  if (typeof value === 'string') {
    return checkVisibleText(value, { multiline: true });
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      const problem = checkVisibleText(key, { multiline: false }) ?? checkJsonText(inner);

      if (problem) {
        return problem;
      }
    }
  }

  return null;
}

// Liest JSON nur in genau einer Schreibweise: UTF-8 ohne BOM, LF, eingerueckt mit zwei
// Leerzeichen, abschliessender Zeilenumbruch. Damit sind doppelte Schluessel, andere
// Zahlenschreibweisen, unnoetige Escapes und versteckte Formatierung ausgeschlossen.
// Escapes, die JSON.stringify selbst schreibt (Steuerzeichen, einzelne Surrogate), und
// unsichtbare Zeichen faengt danach die Zeichenpruefung aller Schluessel und Texte ab.
export function parseStrictJson(input, maxBytes) {
  if (!Buffer.isBuffer(input)) {
    fail('json-eingabe', 'JSON muss als Bytefolge gelesen werden');
  }

  if (input.length === 0) {
    fail('json-leer', 'leere Datei');
  }

  if (input.length > maxBytes) {
    fail('json-groesse', `Datei groesser als ${maxBytes} Bytes`);
  }

  if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    fail('json-bom', 'BOM am Dateianfang');
  }

  let text;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    fail('json-utf8', 'kein gueltiges UTF-8');
  }

  if (text.includes('\r')) {
    fail('json-zeilenende', 'Wagenruecklauf gefunden, nur LF erlaubt');
  }

  let value;

  try {
    value = JSON.parse(text);
  } catch {
    fail('json-syntax', 'kein gueltiges JSON');
  }

  if (!isPlainObject(value)) {
    fail('json-objekt', 'oberste Ebene muss ein Objekt sein');
  }

  if (JSON.stringify(value, null, 2) + '\n' !== text) {
    fail('json-kanonisch', 'nicht in kanonischer Form (doppelte Schluessel, Escapes oder Formatierung)');
  }

  const textProblem = checkJsonText(value);

  if (textProblem) {
    fail('json-zeichen', `Schluessel oder Text: ${textProblem}`);
  }

  return value;
}

// Pflichteintraege in skript_hashes einer echten Policy. Nur der Entwurf (A6.1) darf leer sein;
// die genaue Gleichheit mit den Dateien in scripts/ prueft erst der Workflow (A6.4).
export const REQUIRED_SCRIPT_HASHES = Object.freeze(['scripts/agent-profile.mjs']);

export function validatePolicy(policy, { entwurf = false } = {}) {
  if (!isPlainObject(policy) || !sameKeys(policy, POLICY_KEYS)) {
    fail('policy-felder', 'Policy hat nicht genau die vorgesehenen Felder');
  }

  if (policy.schema !== POLICY_SCHEMA) {
    fail('policy-schema', 'unbekanntes Policy-Schema');
  }

  if (
    !isUniqueStringList(policy.modelle) ||
    policy.modelle.length === 0 ||
    !policy.modelle.every(model => HARD_MODELS.includes(model))
  ) {
    fail('policy-modelle', 'Modellliste ungueltig oder ausserhalb der harten Grenze');
  }

  if (
    !isUniqueStringList(policy.claude_werkzeuge) ||
    policy.claude_werkzeuge.length === 0 ||
    !policy.claude_werkzeuge.every(tool => HARD_TOOLS.includes(tool))
  ) {
    fail('policy-werkzeuge', 'Werkzeugliste ungueltig, nur Read, Edit und Write sind erlaubt');
  }

  if (!isBudget(policy.max_budget_usd, HARD_LIMITS.max_budget_usd)) {
    fail('policy-budget', 'Budgetgrenze ungueltig oder ueber 1,50');
  }

  for (const key of [
    'max_runden',
    'max_laufzeit_minuten',
    'max_dateien',
    'max_auftrag_rahmen_zeichen',
    'max_issue_titel_zeichen',
    'max_issue_text_zeichen',
  ]) {
    if (!isPositiveInteger(policy[key], HARD_LIMITS[key])) {
      fail('policy-grenze', `${key} ungueltig oder ueber der harten Grenze`);
    }
  }

  if (
    !isUniqueStringList(policy.gesperrte_praefixe) ||
    !REQUIRED_DENIED_PREFIXES.every(prefix => policy.gesperrte_praefixe.includes(prefix)) ||
    !policy.gesperrte_praefixe.every(prefix => prefix.endsWith('/'))
  ) {
    fail('policy-sperrliste', 'gesperrte Praefixe unvollstaendig oder ungueltig');
  }

  if (
    !isUniqueStringList(policy.gesperrte_dateien) ||
    !REQUIRED_DENIED_FILES.every(file => policy.gesperrte_dateien.includes(file))
  ) {
    fail('policy-sperrliste', 'gesperrte Dateien unvollstaendig oder ungueltig');
  }

  if (
    !isUniqueStringList(policy.reservierte_ids) ||
    !REQUIRED_RESERVED_IDS.every(id => policy.reservierte_ids.includes(id)) ||
    !policy.reservierte_ids.every(id => ID_RE.test(id))
  ) {
    fail('policy-reserviert', 'reservierte IDs unvollstaendig oder ungueltig');
  }

  if (
    !isUniqueStringList(policy.pr_titel_praefixe) ||
    policy.pr_titel_praefixe.length === 0 ||
    !policy.pr_titel_praefixe.every(prefix => HARD_PR_PREFIXES.includes(prefix))
  ) {
    fail('policy-praefixe', 'PR-Titel-Praefixe ungueltig');
  }

  if (
    !isPlainObject(policy.skript_hashes) ||
    !Object.entries(policy.skript_hashes).every(
      ([path, hash]) => SCRIPT_PATH_RE.test(path) && typeof hash === 'string' && HEX64_RE.test(hash)
    )
  ) {
    fail('policy-hashes', 'Skript-Hashes ungueltig');
  }

  if (!entwurf && !REQUIRED_SCRIPT_HASHES.every(path => Object.hasOwn(policy.skript_hashes, path))) {
    fail('policy-hashes-fehlen', 'Skript-Hashes fehlen; leer ist nur ein Entwurf');
  }

  return policy;
}

export function isDeniedPath(path, policy) {
  return (
    policy.gesperrte_dateien.some(file => path === file || path.endsWith(`/${file}`)) ||
    policy.gesperrte_praefixe.some(prefix => path.startsWith(prefix) || path.includes(`/${prefix}`))
  );
}

export function validateProfile(profile, { policy, fileName, entwurf = false }) {
  validatePolicy(policy, { entwurf });

  if (!isPlainObject(profile) || !sameKeys(profile, PROFILE_KEYS)) {
    fail('profil-felder', 'Profil hat nicht genau die vorgesehenen Felder');
  }

  if (profile.schema !== PROFILE_SCHEMA) {
    fail('profil-schema', 'unbekanntes Profil-Schema');
  }

  if (typeof profile.id !== 'string' || !ID_RE.test(profile.id) || profile.id.includes('--')) {
    fail('profil-id', 'ID entspricht nicht dem Muster');
  }

  if (policy.reservierte_ids.includes(profile.id)) {
    fail('profil-id-reserviert', `ID ${profile.id} ist reserviert`);
  }

  if (fileName !== `${profile.id}.json`) {
    fail('profil-dateiname', 'ID und Dateiname stimmen nicht ueberein');
  }

  if (typeof profile.aktiv !== 'boolean') {
    fail('profil-aktiv', 'aktiv muss true oder false sein');
  }

  const files = profile.dateien;

  if (!Array.isArray(files) || files.length === 0 || files.length > policy.max_dateien) {
    fail('profil-dateizahl', `1 bis ${policy.max_dateien} Dateien erlaubt`);
  }

  // Ohne diese Pruefung wuerde eine verschachtelte Liste ["src/rechne.js"] von der
  // Pfadregel als Text gelesen und bestehen.
  if (!files.every(file => typeof file === 'string')) {
    fail('profil-pfad-typ', 'Dateipfade muessen Texte sein');
  }

  if (new Set(files).size !== files.length) {
    fail('profil-doppelt', 'Dateipfad doppelt');
  }

  for (const file of files) {
    if (!PATH_RE.test(file)) {
      fail('profil-pfad', `Pfad ${JSON.stringify(file)} entspricht nicht der Pfadregel`);
    }

    if (HARD_DENIED_PATH_RE.test(file) || isDeniedPath(file, policy)) {
      fail('profil-gesperrt', `Pfad ${file} steht auf der Sperrliste`);
    }
  }

  if (!files.some(file => file.startsWith('src/'))) {
    fail('profil-ohne-src', 'mindestens eine Datei unter src/ erforderlich');
  }

  if (profile.abnahme !== 'issue') {
    fail('profil-abnahme', 'abnahme muss "issue" sein');
  }

  if (!policy.modelle.includes(profile.modell)) {
    fail('profil-modell', 'Modell nicht erlaubt');
  }

  if (!isBudget(profile.budget_usd, policy.max_budget_usd)) {
    fail('profil-budget', `Budget ungueltig oder ueber ${policy.max_budget_usd}`);
  }

  if (!isPositiveInteger(profile.max_runden, policy.max_runden)) {
    fail('profil-runden', `max_runden ungueltig oder ueber ${policy.max_runden}`);
  }

  if (!isPositiveInteger(profile.max_laufzeit_minuten, policy.max_laufzeit_minuten)) {
    fail('profil-laufzeit', `max_laufzeit_minuten ungueltig oder ueber ${policy.max_laufzeit_minuten}`);
  }

  const frame = profile.auftrag_rahmen;

  if (
    typeof frame !== 'string' ||
    !VISIBLE_CONTENT_RE.test(frame) ||
    codePoints(frame) > policy.max_auftrag_rahmen_zeichen
  ) {
    fail('profil-rahmen', `auftrag_rahmen leer oder laenger als ${policy.max_auftrag_rahmen_zeichen} Zeichen`);
  }

  const frameProblem = checkVisibleText(frame, { multiline: true });

  if (frameProblem) {
    fail('profil-rahmen-zeichen', `auftrag_rahmen: ${frameProblem}`);
  }

  if (!policy.pr_titel_praefixe.includes(profile.pr_titel_praefix)) {
    fail('profil-praefix', 'PR-Titel-Praefix nicht erlaubt');
  }

  return Object.freeze({ ...profile, dateien: Object.freeze([...files]) });
}

// Liest und prueft ein Profil aus seinen Bytes. Gibt das Profil und den SHA-256 der Bytes zurueck.
export function loadProfile(bytes, { policy, fileName, entwurf = false }) {
  const profile = validateProfile(parseStrictJson(bytes, MAX_PROFILE_BYTES), { policy, fileName, entwurf });
  return { profile, sha256: sha256(bytes) };
}

export function loadPolicy(bytes, { entwurf = false } = {}) {
  return validatePolicy(parseStrictJson(bytes, MAX_POLICY_BYTES), { entwurf });
}

// Liest den vollstaendigen Git-Baum eines Commits. Keine Optionen aus Eingaben, feste Argumente.
export function readTree(root, sha) {
  if (typeof sha !== 'string' || !HEX40_RE.test(sha)) {
    fail('baum-sha', 'ungueltiger Ausgangscommit');
  }

  let output;

  try {
    output = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', sha], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4_000_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    fail('baum-git', 'Git-Baum konnte nicht gelesen werden');
  }

  return parseTreeOutput(output);
}

// Zerlegt die Ausgabe von git ls-tree -r -z. Jede unerwartete Zeile und jeder doppelte Pfad bricht ab.
export function parseTreeOutput(output) {
  if (typeof output !== 'string') {
    fail('baum-format', 'Ausgabe von git ls-tree fehlt');
  }

  const tree = new Map();

  for (const line of output.split('\0')) {
    if (line === '') {
      continue;
    }

    const match = TREE_LINE_RE.exec(line);

    if (!match) {
      fail('baum-format', 'unerwartete Ausgabe von git ls-tree');
    }

    if (tree.has(match[4])) {
      fail('baum-doppelt', `Pfad ${JSON.stringify(match[4])} doppelt im Baum`);
    }

    tree.set(match[4], { mode: match[1], type: match[2] });
  }

  // Kein Eintrag darf zugleich Elternordner eines anderen sein, etwa src als Symlink und
  // src/a.js als Datei. Beim Checkout koennte src sonst als Symlink an einen anderen Ort zeigen.
  for (const path of tree.keys()) {
    const parts = path.split('/');

    for (let depth = 1; depth < parts.length; depth += 1) {
      const parent = parts.slice(0, depth).join('/');

      if (tree.has(parent)) {
        fail('baum-konflikt', `${parent} ist zugleich Eintrag und Ordner`);
      }
    }
  }

  return tree;
}

// Jede Profildatei muss im Baum des Ausgangscommits als gewoehnliche Datei vorhanden sein:
// Modus 100644, Typ blob. Kein Symlink (120000), nicht ausfuehrbar (100755), kein Unterprojekt.
export function checkProfileFiles(profile, tree) {
  if (!(tree instanceof Map)) {
    fail('baum-eingabe', 'Baum fehlt');
  }

  for (const file of profile.dateien) {
    const entry = tree.get(file);

    if (!entry) {
      fail('baum-fehlt', `${file} fehlt im Ausgangscommit`);
    }

    if (entry.mode !== '100644' || entry.type !== 'blob') {
      fail('baum-modus', `${file} ist keine gewoehnliche Datei (Modus ${entry.mode}, Typ ${entry.type})`);
    }
  }

  return true;
}

// Issue-Eingaben sind nicht vertrauenswuerdig. Ergebnis: normalisierte Werte und ihr Hash.
// limits ist die gepruefte Policy oder HARD_LIMITS. Fehlende, falsche oder zu lockere Grenzen
// brechen ab, statt still keine Grenze zu setzen.
export function validateIssueInput(title, body, limits = HARD_LIMITS) {
  if (
    !isPlainObject(limits) ||
    !isPositiveInteger(limits.max_issue_titel_zeichen, HARD_LIMITS.max_issue_titel_zeichen) ||
    !isPositiveInteger(limits.max_issue_text_zeichen, HARD_LIMITS.max_issue_text_zeichen)
  ) {
    failIssue('issue-grenzen', 'Grenzen fehlen, sind ungueltig oder lockerer als erlaubt');
  }

  const maxTitle = limits.max_issue_titel_zeichen;
  const maxBody = limits.max_issue_text_zeichen;

  if (typeof title !== 'string' || typeof body !== 'string') {
    failIssue('issue-typ', 'Titel und Text muessen Texte sein');
  }

  const normalizedTitle = title.replace(/\r\n/g, '\n');
  const normalizedBody = body.replace(/\r\n/g, '\n');

  if (normalizedTitle.includes('\r') || normalizedBody.includes('\r')) {
    failIssue('issue-zeilenende', 'einzelner Wagenruecklauf');
  }

  if (!VISIBLE_CONTENT_RE.test(normalizedTitle) || codePoints(normalizedTitle) > maxTitle) {
    failIssue('issue-titel-laenge', `Titel leer oder laenger als ${maxTitle} Zeichen`);
  }

  if (!VISIBLE_CONTENT_RE.test(normalizedBody) || codePoints(normalizedBody) > maxBody) {
    failIssue('issue-text-laenge', `Text leer oder laenger als ${maxBody} Zeichen`);
  }

  const titleProblem = checkVisibleText(normalizedTitle, { multiline: false });

  if (titleProblem) {
    failIssue('issue-titel-zeichen', `Titel: ${titleProblem}`);
  }

  const bodyProblem = checkVisibleText(normalizedBody, { multiline: true });

  if (bodyProblem) {
    failIssue('issue-text-zeichen', `Text: ${bodyProblem}`);
  }

  return Object.freeze({
    titel: normalizedTitle,
    text: normalizedBody,
    sha256: sha256(JSON.stringify([normalizedTitle, normalizedBody])),
  });
}

// Nur strukturelle Pruefung des Entwurfs. Ob Claude Code die Regeln so durchsetzt, belegt erst K1.
export function validateSettingsDraft(settings) {
  if (!isPlainObject(settings) || !sameKeys(settings, ['permissions'])) {
    fail('einstellungen-felder', 'Einstellungen haben nicht genau das Feld permissions');
  }

  const permissions = settings.permissions;

  if (!isPlainObject(permissions) || !sameKeys(permissions, ['allow', 'deny'])) {
    fail('einstellungen-felder', 'permissions hat nicht genau allow und deny');
  }

  if (!isUniqueStringList(permissions.allow)) {
    fail('einstellungen-allow', 'allow muss eine eindeutige Liste von Texten sein');
  }

  if (!isUniqueStringList(permissions.deny)) {
    fail('einstellungen-deny', 'deny muss eine eindeutige Liste von Texten sein');
  }

  for (const rule of REQUIRED_SETTINGS_DENY) {
    if (!permissions.deny.includes(rule)) {
      fail('einstellungen-deny', `Pflichtverbot fehlt: ${rule}`);
    }
  }

  // Erlaubnisse nur Read oder Edit auf genau eine Datei, die auch ein Profil erlauben duerfte:
  // keine Muster, keine Unterordner, kein Write (A6 legt keine Dateien an), nie Shell oder Netz.
  for (const rule of permissions.allow) {
    const match = SETTINGS_ALLOW_RE.exec(rule);

    if (!match || !PATH_RE.test(match[2]) || HARD_DENIED_PATH_RE.test(match[2])) {
      fail('einstellungen-allow', `Erlaubnis ohne engen Pfad: ${rule}`);
    }
  }

  return settings;
}

const SETTINGS_ALLOW_RE = /^(Read|Edit)\(\.\/([^()]+)\)$/;

// Die Erlaubnisse, die genau zu einem Profil gehoeren: Read und Edit je Profildatei.
export function settingsAllowForProfile(profile) {
  return profile.dateien.flatMap(file => [`Read(./${file})`, `Edit(./${file})`]);
}

// Einstellungen fuer einen Lauf: allow muss genau den Erlaubnissen des Profils entsprechen,
// in derselben Reihenfolge, ohne Zusatz und ohne Luecke.
export function validateSettingsForProfile(settings, profile) {
  validateSettingsDraft(settings);
  const expected = settingsAllowForProfile(profile);

  if (JSON.stringify(settings.permissions.allow) !== JSON.stringify(expected)) {
    fail('einstellungen-profil', 'allow entspricht nicht genau den Dateien des Profils');
  }

  return settings;
}

export function loadSettingsDraft(bytes) {
  return validateSettingsDraft(parseStrictJson(bytes, MAX_SETTINGS_BYTES));
}
