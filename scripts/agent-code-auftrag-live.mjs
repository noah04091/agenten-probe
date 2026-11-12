// A6.2-2: Sichere Live-Zustandspruefung eines festgelegten Auftrags (agent-auftrag-v1).
//
// Wirkungslos bis A6.4: Kein Workflow und kein anderes Skript ruft dieses Modul auf. Es hat keinen
// Einstiegspunkt, liest keine Prozessumgebung, hat keine Zugangsdaten und stellt selbst keine
// Netzanfragen. Jede GitHub-Anfrage laeuft ueber eine ausdruecklich uebergebene Transportfunktion,
// und zwar nur als GET auf sechs fest gebaute Pfade.
//
// Aufbau:
// - readLiveState() liest den Live-Zustand: Workflow-Lauf, main, Issue, vollstaendigen
//   Ereignisverlauf, Branches wp/<n>- und alle PRs. Es prueft Form und Vollstaendigkeit, filtert
//   aber nichts. Die Ereignisse gehen roh an resolveOrder (auch renamed von fremden Konten).
// - checkLiveOrder() prueft nur, was resolveOrder nicht kennt (Laufidentitaet, main, Branches,
//   fruehere PRs), ruft dann resolveOrder aus agent-code-auftrag.mjs mit den frischen Daten und der
//   Original-Nutzlast erneut auf und vergleicht den neuen Auftrag mit sameOrder gegen den erwarteten
//   vollen SHA-256. Alle K3-Regeln zu Issue, Labels, Freigaben, renamed, Laufversuch und Frist
//   kommen damit unveraendert aus resolveOrder. Hier gibt es keine zweite Fassung davon.
//
// Vertrag der Transportfunktion (wird erst in A6.4 gebaut):
// - Aufruf transport({ method: 'GET', path }) mit path relativ zu https://api.github.com, zum
//   Beispiel /repos/noah04091/agenten-probe/issues/38. Ergebnis (auch als Promise):
//   { status: Zahl, headers: einfaches Objekt mit Text-Werten, body: Text }.
// - Der Transport darf Weiterleitungen NICHT selbst verfolgen (fetch mit redirect: 'manual') und
//   muss die Antwortgroesse beim Lesen und die Wartezeit je Anfrage begrenzen (Timeout); dieses Modul
//   wartet sonst unbegrenzt. Kopfzeilen kommen als einfaches Objekt, nicht als fetch-Headers, und
//   mehrfache Kopfzeilen nicht als Liste. Dieses Modul lehnt jede sichtbare 3xx-Antwort ab,
//   kann aber nicht pruefen, ob ein Transport heimlich gefolgt ist. Die Unit-Tests belegen nur das
//   Verhalten bei sichtbaren 3xx-Antworten, nicht eine sichere produktive Transportkonfiguration.
//
// Paginierung (gemessen am 11.11.2026 in diesem Repository):
// - Eine einzige Seite hat keinen Link-Header. Seite 1 von mehreren hat next und last, mittlere
//   Seiten prev, next, last und first, die letzte Seite prev und first, eine Seite hinter dem Ende
//   ist leer mit prev, last und first.
// - Die URLs im Link-Header lauten https://api.github.com/repositories/<id>/..., nicht
//   /repos/<owner>/<name>/. Sie werden weder aufgerufen noch verglichen, nur die rel-Werte zaehlen.
// - Ende nur ueber rel="next": Eine Seite mit next muss genau 100 Eintraege haben. Eine Seite ohne
//   next ist die letzte. Hat sie genau 100 Eintraege, wird die naechste Seite selbst gebaut abgerufen
//   und muss leer sein und darf kein next tragen. Eine Seite mit last, aber ohne next, muss leer
//   sein (nur die Seite hinter dem Ende sieht so aus). Mehr als zehn Seiten werden nie abgerufen; laesst
//   Seite 10 eine Fortsetzung offen (next oder genau 100 Eintraege), bricht die Pruefung ab. Damit
//   sind hoechstens 999 Ereignisse und 999 PRs pruefbar; ab 1000 PRs im Repository scheitert jede
//   Pruefung dauerhaft (falsches Nein), dann muss A6.4 die Suche neu planen.
// - Verschwindet waehrend des Blaetterns ein frueherer Eintrag (etwa ein von GitHub entfernter PR),
//   kann ein Eintrag ueber die Seitengrenze rutschen und unbemerkt fehlen. Das ist ein Teil der
//   fehlenden atomaren Momentaufnahme (siehe unten), sehr selten und hier nicht erkennbar.
//
// Grenzen, die dieses Modul nicht schliessen kann und die A6.4 tragen muss:
// - Herkunft von erwartetem Hash und Original-Nutzlast: Beide muessen zwischen den Jobs
//   vertrauenswuerdig uebergeben werden. Der Hash allein belegt nicht, wer ihn geliefert hat.
// - Keine atomare Momentaufnahme: Die PR-Liste und die Branches koennen sich zwischen Lesen und
//   Pruefen und zwischen Pruefen und Schreiben aendern. Zwei gleichzeitige Laeufe koennten dieselbe
//   Freigabe nutzen. Dagegen helfen nur concurrency je Issue, Einmalverwendung je Freigabe und eine
//   erneute Live-Pruefung direkt vor dem ersten Schreibzugriff. Das schliesst den Push des eigenen
//   Branches wp/<n>-... ein: Liegt er schon vor der letzten Pruefung, scheitert sie an
//   live-branch-vorhanden.
// - Das Repository ist oeffentlich. Ein PR irgendeines Kontos aus einem Fork mit Branch wp/<n>-...
//   sperrt Issue n nach der strengen K3-Regel dauerhaft (falsches Nein, keine Luecke).
// - resolveOrder verlangt, dass updated_at des Live-Issues sekundengleich mit der Startfreigabe ist.
//   Jede spaetere Aenderung am Issue, auch ein Kommentar eines fremden Kontos waehrend des Laufs,
//   bricht jede weitere Pruefung ab (bewusst Fail-Closed). Der Workflow darf deshalb vor der letzten
//   Live-Pruefung keinen eigenen Kommentar auf das Issue schreiben, sonst macht er seinen eigenen
//   Auftrag ungueltig. Der Satz "ohne erneutes Lesen des Issues" im Kopf von agent-code-auftrag.mjs
//   ist damit fuer die erneute Pruefung so zu lesen: erneutes Lesen ist erlaubt, nur nichts darf das
//   Issue veraendern.
// - Die Annahme zum Webhook-Schnappschuss (Kopf von agent-code-auftrag.mjs) bleibt offen und muss
//   im ersten Trockenlauf von A6.4 gemessen werden. K3 ist mit diesem Modul nicht abgeschlossen.
// - Ein Zustand aus readLiveState gilt genau fuer einen Aufruf von checkLiveOrder im selben Prozess.
//   Ein frueheres positives Ergebnis ist keine dauerhafte Freigabe; jede Pruefung liest neu.
//   "Frisch" heisst hier nur "unbenutzt": Der Zustand traegt keinen Lesezeitpunkt, und now liefert
//   der Aufrufer. A6.4 muss readLiveState unmittelbar vor checkLiveOrder aufrufen.
// - Status und Ergebnis des Laufs (status, conclusion) werden nicht geprueft. Ein schon beendeter Lauf
//   mit derselben ID besteht die Laufidentitaet; A6.4 muss die Lauf-ID aus dem eigenen Lauf nehmen.
// - Ein Ablehnungsgrund ist immer ein Fehler mit code: OrderError (live-... aus diesem Modul,
//   auftrag-... aus resolveOrder) oder ProfileError aus agent-profile.mjs.

import { types } from 'node:util';

import { MAX_ISSUE_NUMBER, OWNER, OrderError, REPOSITORY, resolveOrder, sameOrder } from './agent-code-auftrag.mjs';

export const WORKFLOW_PATH = '.github/workflows/code-pilot-claude-stufe.yml';
export const PER_PAGE = 100;
export const MAX_PAGES = 10;
// Gemessen: 43 PRs ergeben rund 740 KB, 100 PRs also rund 1,8 MB. Die Grenze laesst lange PR-Texte zu.
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

const API_PREFIX = `/repos/${REPOSITORY}/`;
const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const RUN_ID_RE = /^[1-9][0-9]{0,15}$/;
const ISSUE_RE = '[1-9][0-9]{0,7}';
const PAGE_RE = '(?:[1-9]|10)';
const PATH_PATTERNS = Object.freeze([
  new RegExp(`^issues/${ISSUE_RE}$`),
  new RegExp(`^issues/${ISSUE_RE}/events\\?per_page=100&page=${PAGE_RE}$`),
  /^git\/ref\/heads\/main$/,
  new RegExp(`^git/matching-refs/heads/wp/${ISSUE_RE}-$`),
  new RegExp(`^pulls\\?state=all&sort=created&direction=asc&per_page=100&page=${PAGE_RE}$`),
  /^actions\/runs\/[1-9][0-9]{0,15}$/,
]);
const LINK_PART_RE = /^\s*<[^<>\s]*>\s*;\s*rel="(next|prev|first|last)"\s*$/;
const READ_KEYS = Object.freeze(['transport', 'repository', 'issueNumber', 'runId']);
const CHECK_KEYS = Object.freeze(['expectedSha256', 'event', 'state', 'root', 'baseSha', 'gitEnv', 'now', 'runId']);
const LIVE_STATES = new WeakSet();

function fail(code, message) {
  throw new OrderError(code, `Live-Pruefung abgelehnt: ${message}`);
}

// Wie in agent-code-auftrag.mjs: nur einfache Objekte ohne Proxy, nur eigene Dateneigenschaften.
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(value, key) {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every(key => actual.includes(key));
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(value[key]);
    }

    Object.freeze(value);
  }

  return value;
}

const isPositiveSafeInteger = value => Number.isSafeInteger(value) && value > 0;

function isValidRunId(runId) {
  return typeof runId === 'string' && RUN_ID_RE.test(runId) && Number.isSafeInteger(Number(runId));
}

// ---------------------------------------------------------------------------
// Request-Grenze
// ---------------------------------------------------------------------------

// Einzige Pruefung vor jedem Aufruf des Transports: nur GET, nur die sechs festen Pfade unter
// /repos/noah04091/agenten-probe/, keine anderen Parameter und keine anderen Seiten.
export function checkApiRequest(method, path) {
  if (method !== 'GET') {
    fail('live-methode', 'nur GET ist erlaubt');
  }

  if (typeof path !== 'string' || !path.startsWith(API_PREFIX)) {
    fail('live-pfad', 'Pfad liegt ausserhalb des Repositorys');
  }

  const rest = path.slice(API_PREFIX.length);

  if (!PATH_PATTERNS.some(pattern => pattern.test(rest))) {
    fail('live-pfad', 'Pfad gehoert zu keinem der sechs erlaubten Endpunkte');
  }

  if (/^actions\/runs\//.test(rest) && !isValidRunId(rest.slice('actions/runs/'.length))) {
    // Eigener Code, damit sich diese zweite Schicht im Test vom Pfadmuster unterscheiden laesst.
    fail('live-pfad-lauf-id', 'Lauf-ID im Pfad ist keine sichere Ganzzahl');
  }

  return true;
}

function readHeaders(headers) {
  if (!isPlainObject(headers)) {
    fail('live-antwort-format', 'Kopfzeilen fehlen oder sind kein Objekt');
  }

  const result = new Map();

  for (const key of Reflect.ownKeys(headers)) {
    const value = own(headers, key);

    if (typeof key !== 'string' || typeof value !== 'string') {
      fail('live-antwort-format', 'Kopfzeile ist kein Text');
    }

    const name = key.toLowerCase();

    if (result.has(name)) {
      fail('live-header-doppelt', `Kopfzeile ${name} doppelt`);
    }

    result.set(name, value);
  }

  return result;
}

// Ruft den Transport genau einmal auf und liefert { json, headers } oder wirft.
async function callApi(transport, path) {
  checkApiRequest('GET', path);
  let response;

  try {
    response = await transport(Object.freeze({ method: 'GET', path }));
  } catch {
    // Die Nachricht des Transports wird nicht uebernommen: Sie koennte selbst werfen oder Zugangsdaten
    // enthalten, die so in ein Protokoll gelangen wuerden.
    fail('live-transport-fehler', 'Anfrage an GitHub gescheitert');
  }

  // own() liest nur eigene Dateneigenschaften einfacher Objekte: Proxy, Getter und andere Typen
  // ergeben undefined und scheitern unten an der Statuspruefung.
  const status = own(response, 'status');
  const body = own(response, 'body');

  if (!Number.isInteger(status)) {
    fail('live-antwort-format', 'Status fehlt');
  }

  const headers = readHeaders(own(response, 'headers'));

  if (status >= 300 && status < 400) {
    fail('live-umleitung', `Weiterleitung ${status} wird nicht verfolgt`);
  }

  if (status !== 200) {
    fail('live-http-status', `unerwarteter Status ${status}`);
  }

  if (typeof body !== 'string') {
    fail('live-antwort-format', 'Antworttext fehlt');
  }

  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    fail('live-antwort-gross', `Antwort groesser als ${MAX_BODY_BYTES} Bytes`);
  }

  let json;

  try {
    json = JSON.parse(body);
  } catch {
    fail('live-antwort-json', 'Antwort ist kein vollstaendiges JSON');
  }

  return { json, headers };
}

// ---------------------------------------------------------------------------
// Paginierung
// ---------------------------------------------------------------------------

// Liest nur die rel-Werte. Die URLs werden nie verwendet und nie verglichen.
function readLinkRels(headers) {
  const rels = new Set();

  if (!headers.has('link')) {
    return rels;
  }

  for (const part of headers.get('link').split(',')) {
    const match = LINK_PART_RE.exec(part);

    if (match === null || rels.has(match[1])) {
      fail('live-link-format', 'Link-Header fehlerhaft oder mehrdeutig');
    }

    rels.add(match[1]);
  }

  return rels;
}

function readList(json) {
  // json stammt immer aus JSON.parse und ist daher nie ein Proxy.
  if (!Array.isArray(json)) {
    fail('live-liste-format', 'Antwort ist keine Liste');
  }

  if (!json.every(item => isPlainObject(item))) {
    fail('live-liste-format', 'Listeneintrag ist kein Objekt');
  }

  return json;
}

// Liest alle Seiten von basePath + page=<k>. Vollstaendig nur bei zuverlaessig festgestelltem Ende.
async function readAllPages(transport, basePath) {
  const items = [];
  let announced = false;
  let confirming = false;

  for (let page = 1; ; page += 1) {
    if (page > MAX_PAGES) {
      fail('live-seiten-grenze', `mehr als ${MAX_PAGES} Seiten oder Ende nicht feststellbar`);
    }

    const { json, headers } = await callApi(transport, `${basePath}&page=${page}`);
    const list = readList(json);
    const rels = readLinkRels(headers);

    if (page === 1 && (rels.has('prev') || rels.has('first'))) {
      fail('live-seite-widerspruch', 'Seite 1 verweist auf eine vorherige Seite');
    }

    if (list.length > PER_PAGE) {
      fail('live-seite-widerspruch', `Seite ${page} hat mehr als ${PER_PAGE} Eintraege`);
    }

    // Bestaetigungsseite nach einer vollen letzten Seite: muss leer sein und darf nicht weitergehen.
    if (confirming) {
      if (list.length !== 0 || rels.has('next')) {
        fail('live-seite-widerspruch', 'hinter der letzten Seite folgen weitere Eintraege');
      }

      return items;
    }

    // last ohne next gibt es nur auf der leeren Seite hinter dem Ende, und die ist oben schon als
    // Bestaetigungsseite behandelt. Jede andere Seite mit last ohne next widerspricht sich, auch eine
    // leere Seite 1 (sie wuerde sonst eine leere Liste vortaeuschen).
    if (!rels.has('next') && rels.has('last')) {
      fail('live-seite-widerspruch', `Seite ${page} nennt eine letzte Seite, aber keine naechste`);
    }

    if (rels.has('next')) {
      if (list.length !== PER_PAGE) {
        fail('live-seite-widerspruch', `Seite ${page} hat rel="next", aber nicht ${PER_PAGE} Eintraege`);
      }

      items.push(...list);
      announced = true;
      continue;
    }

    if (announced && list.length === 0) {
      fail('live-seite-widerspruch', `angekuendigte Seite ${page} ist leer`);
    }

    items.push(...list);

    if (list.length < PER_PAGE) {
      return items;
    }

    // Genau 100 Eintraege ohne rel="next": Ende erst nach einer leeren Folgeseite belegt.
    confirming = true;
  }
}

// ---------------------------------------------------------------------------
// Einzelne Endpunkte
// ---------------------------------------------------------------------------

function readEvents(list) {
  const seen = new Set();

  for (const event of list) {
    const id = own(event, 'id');

    if (!isPositiveSafeInteger(id)) {
      fail('live-ereignis-id', 'Ereignis ohne gueltige ID');
    }

    if (seen.has(id)) {
      fail('live-ereignis-doppelt', `Ereignis ${id} doppelt`);
    }

    seen.add(id);
  }

  // Roh und ungefiltert, in der Reihenfolge der Seiten.
  return list;
}

function readPulls(list) {
  const seen = new Set();
  const result = [];

  for (const pull of list) {
    const number = own(pull, 'number');
    const head = own(pull, 'head');
    const ref = own(head, 'ref');

    if (!isPositiveSafeInteger(number) || typeof ref !== 'string' || ref.length === 0) {
      fail('live-pr-format', 'PR ohne gueltige Nummer oder ohne head.ref');
    }

    if (seen.has(number)) {
      fail('live-pr-doppelt', `PR ${number} doppelt`);
    }

    seen.add(number);
    result.push({ number, head_ref: ref });
  }

  return result;
}

function readMain(json) {
  const object = own(json, 'object');
  const sha = own(object, 'sha');

  if (
    own(json, 'ref') !== 'refs/heads/main' ||
    own(object, 'type') !== 'commit' ||
    typeof sha !== 'string' ||
    !HEX40_RE.test(sha)
  ) {
    fail('live-main-format', 'main-Ref fehlt oder ist ungueltig');
  }

  return sha;
}

function readRefs(json, headers, issueNumber) {
  if (headers.has('link')) {
    fail('live-ref-link', 'Branch-Abfrage ist seitenweise, das ist nicht dokumentiert');
  }

  const prefix = `refs/heads/wp/${issueNumber}-`;
  const result = [];

  for (const item of readList(json)) {
    const name = own(item, 'ref');
    const object = own(item, 'object');
    const sha = own(object, 'sha');

    if (
      typeof name !== 'string' ||
      !name.startsWith(prefix) ||
      own(object, 'type') !== 'commit' ||
      typeof sha !== 'string' ||
      !HEX40_RE.test(sha)
    ) {
      fail('live-ref-format', 'unerwarteter oder unvollstaendiger Ref');
    }

    result.push(name);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Live-Zustand lesen
// ---------------------------------------------------------------------------

// input: { transport, repository, issueNumber, runId }, genau diese Felder.
// issueNumber: Zahl 1 bis MAX_ISSUE_NUMBER. runId: Lauf-ID als Ziffernfolge (sichere Ganzzahl).
// Ergebnis: tief eingefrorener Zustand fuer genau einen Aufruf von checkLiveOrder.
export async function readLiveState(input) {
  if (!isPlainObject(input) || !hasExactKeys(input, READ_KEYS)) {
    fail('live-eingabe', `Eingabe braucht genau ${READ_KEYS.join(', ')}`);
  }

  const transport = own(input, 'transport');
  const issueNumber = own(input, 'issueNumber');
  const runId = own(input, 'runId');

  if (typeof transport !== 'function') {
    fail('live-transport', 'Transportfunktion fehlt');
  }

  if (own(input, 'repository') !== REPOSITORY) {
    fail('live-repository', `nur ${REPOSITORY} ist erlaubt`);
  }

  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || issueNumber > MAX_ISSUE_NUMBER) {
    fail('live-issue-nummer', 'Issue-Nummer ungueltig');
  }

  if (!isValidRunId(runId)) {
    fail('live-lauf-id', 'Lauf-ID ungueltig');
  }

  const run = (await callApi(transport, `${API_PREFIX}actions/runs/${runId}`)).json;

  if (!isPlainObject(run)) {
    fail('live-lauf-format', 'Laufdaten sind kein Objekt');
  }

  const mainSha = readMain((await callApi(transport, `${API_PREFIX}git/ref/heads/main`)).json);
  const issue = (await callApi(transport, `${API_PREFIX}issues/${issueNumber}`)).json;

  if (!isPlainObject(issue)) {
    fail('live-issue-format', 'Live-Issue ist kein Objekt');
  }

  if (own(issue, 'number') !== issueNumber) {
    fail('live-issue-abweichung', 'Live-Issue traegt eine andere Nummer');
  }

  const events = readEvents(await readAllPages(transport, `${API_PREFIX}issues/${issueNumber}/events?per_page=${PER_PAGE}`));
  const refsResponse = await callApi(transport, `${API_PREFIX}git/matching-refs/heads/wp/${issueNumber}-`);
  const branches = readRefs(refsResponse.json, refsResponse.headers, issueNumber);
  const pulls = readPulls(await readAllPages(transport, `${API_PREFIX}pulls?state=all&sort=created&direction=asc&per_page=${PER_PAGE}`));

  const state = deepFreeze({ repository: REPOSITORY, issueNumber, runId, run, mainSha, issue, events, branches, pulls });
  LIVE_STATES.add(state);
  return state;
}

// ---------------------------------------------------------------------------
// Auftrag mit frischen Daten erneut pruefen
// ---------------------------------------------------------------------------

function isOwnerUser(value) {
  return isPlainObject(value) && own(value, 'login') === OWNER && own(value, 'type') === 'User';
}

function checkRunIdentity(run, runId, baseSha) {
  const id = own(run, 'id');

  // GitHub liefert eine JSON-Zahl. Nur sichere Ganzzahlen sind exakt; alles andere waere still gerundet.
  if (!isPositiveSafeInteger(id) || String(id) !== runId) {
    fail('live-lauf-id-abweichung', 'Lauf-ID der Antwort passt nicht zur erwarteten Lauf-ID');
  }

  if (own(run, 'event') !== 'issues') {
    fail('live-lauf-ereignis', 'Lauf wurde nicht durch ein issues-Ereignis ausgeloest');
  }

  // Gemessen an Lauf 42783596004: Pfad ohne Zusatz. Andere Formen werden bewusst nicht erlaubt.
  if (own(run, 'path') !== WORKFLOW_PATH) {
    fail('live-lauf-workflow', `Lauf gehoert nicht zu ${WORKFLOW_PATH}`);
  }

  if (own(run, 'head_branch') !== 'main') {
    fail('live-lauf-branch', 'Lauf laeuft nicht auf main');
  }

  if (
    own(own(run, 'repository'), 'full_name') !== REPOSITORY ||
    own(own(run, 'head_repository'), 'full_name') !== REPOSITORY
  ) {
    fail('live-lauf-repository', `Lauf gehoert nicht zu ${REPOSITORY}`);
  }

  if (!isOwnerUser(own(run, 'actor')) || !isOwnerUser(own(run, 'triggering_actor'))) {
    fail('live-lauf-akteur', `Lauf nicht von ${OWNER} ausgeloest`);
  }

  if (own(run, 'head_sha') !== baseSha) {
    fail('live-lauf-sha', 'Lauf laeuft nicht auf dem Ausgangscommit');
  }
}

// input: { expectedSha256, event, state, root, baseSha, gitEnv, now, runId }, genau diese Felder.
// expectedSha256: voller SHA-256 des urspruenglich festgelegten Auftrags (64 kleine Hex-Zeichen).
// event: Original-Nutzlast von issues.labeled. state: frisch aus readLiveState, noch unbenutzt.
// runId: vertrauenswuerdig uebergebene Lauf-ID. Ergebnis: neuer, von resolveOrder gebildeter und
// per sameOrder bestaetigter Auftrag. Jeder Fehler wirft.
export function checkLiveOrder(input) {
  // Jeder Zustand gilt fuer genau eine Pruefung, auch wenn sie scheitert, schon an der Eingabe. Das
  // gilt, wenn die Eingabe den Zustand als eigene Dateneigenschaft traegt; hinter Getter oder Proxy
  // bleibt er unverbraucht, die Pruefung scheitert dann aber in jedem Fall.
  const fresh = LIVE_STATES.delete(own(input, 'state'));

  if (!isPlainObject(input) || !hasExactKeys(input, CHECK_KEYS)) {
    fail('live-eingabe', `Eingabe braucht genau ${CHECK_KEYS.join(', ')}`);
  }

  const fields = Object.fromEntries(CHECK_KEYS.map(key => [key, own(input, key)]));
  const expectedSha256 = fields.expectedSha256;
  const state = fields.state;
  const runId = fields.runId;

  if (typeof expectedSha256 !== 'string' || !HEX64_RE.test(expectedSha256)) {
    fail('live-hash-format', 'erwarteter Auftrags-Hash muss aus 64 kleinen Hex-Zeichen bestehen');
  }

  if (!fresh) {
    fail('live-zustand-ungeprueft', 'Zustand stammt nicht frisch aus readLiveState oder wurde schon verwendet');
  }

  if (!isValidRunId(runId)) {
    fail('live-lauf-id', 'Lauf-ID ungueltig');
  }

  if (state.runId !== runId) {
    fail('live-lauf-zuordnung', 'Zustand wurde fuer einen anderen Lauf gelesen');
  }

  checkRunIdentity(state.run, runId, fields.baseSha);

  if (state.mainSha !== fields.baseSha) {
    fail('live-main-geaendert', 'main steht nicht mehr auf dem Ausgangscommit');
  }

  if (state.branches.length > 0) {
    fail('live-branch-vorhanden', `Branch ${state.branches[0]} existiert bereits`);
  }

  const prefix = `wp/${state.issueNumber}-`;
  const earlier = state.pulls.find(pull => pull.head_ref.startsWith(prefix));

  if (earlier !== undefined) {
    fail('live-pr-vorhanden', `frueherer PR #${earlier.number} mit Branch ${earlier.head_ref}`);
  }

  // Alle uebrigen K3-Regeln: unveraendert aus resolveOrder, mit frischen Daten und neuem now.
  const order = resolveOrder({
    root: fields.root,
    baseSha: fields.baseSha,
    gitEnv: fields.gitEnv,
    repository: REPOSITORY,
    event: fields.event,
    issue: state.issue,
    events: state.events,
    run: { id: runId, attempt: own(state.run, 'run_attempt'), createdAt: own(state.run, 'created_at') },
    now: fields.now,
  });

  sameOrder(order, expectedSha256);
  return order;
}
