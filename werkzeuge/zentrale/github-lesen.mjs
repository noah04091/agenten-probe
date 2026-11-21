// B1.1 Command Center: einzige Stelle mit Netzzugriff. Nur GET auf https://api.github.com, Zeitlimit 15 Sekunden.
//
// Antwortklassen (nur hier werden Statuscodes gedeutet):
//   ok         200 mit gueltigem JSON (bei Logs: Text)
//   fehlt      nur 404 UND Koerper mit "message": "Not Found"
//   unbekannt  alles andere: 401, 403, 404 mit anderem Koerper, 409, 5xx, Zeitlimit, Netzfehler, ungueltiges JSON,
//              Rate-Limit erschoepft, unerwartete Weiterleitung, zu grosse Antwort
//
// Logs: GitHub antwortet auf /actions/jobs/{id}/logs mit 302. Geladen wird nur ein HTTPS-Ziel auf
// productionresultssa<n>.blob.core.windows.net, ohne Authorization-Kopf und ohne weitere Weiterleitung. Alles andere
// ist "unbekannt". Der Token-Wert erscheint nie in einem Ergebnis oder einer Meldung.

export const BASIS = 'https://api.github.com';
export const ZEITLIMIT_MS = 15_000;
export const GRENZE_JSON = 20 * 1024 * 1024;
export const GRENZE_LOG = 16 * 1024 * 1024;
export const MAX_SEITEN = 10;
export const PRO_SEITE = 100;
const PFAD = /^\/[A-Za-z0-9_.\/-]{1,300}(\?[A-Za-z0-9_.=&%-]{0,300})?$/;
const LOG_HOST = /^productionresultssa\d{1,3}\.blob\.core\.windows\.net$/;

const unbekannt = grund => ({ klasse: 'unbekannt', grund });

function grundAusStatus(res) {
  if (res.status === 401) {
    return 'nicht angemeldet (401)';
  }

  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    return 'Rate-Limit erschöpft';
  }

  if (res.status === 403) {
    return 'keine Berechtigung (403), Token-Rechte prüfen';
  }

  return `HTTP ${res.status}`;
}

async function begrenzterText(res, grenze) {
  const laenge = Number(res.headers.get('content-length'));

  if (Number.isFinite(laenge) && laenge > grenze) {
    return null;
  }

  const t = await res.text();
  return t.length > grenze ? null : t;
}

export function erzeugeLeser({ token, fetchImpl = globalThis.fetch, zeitlimitMs = ZEITLIMIT_MS } = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Leser ohne Token');
  }

  const kopf = Object.freeze({
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'zentrale-b1',
  });

  async function abruf(pfad) {
    if (typeof pfad !== 'string' || !PFAD.test(pfad) || pfad.includes('..') || pfad.includes('//')) {
      return { fehler: unbekannt('ungültiger Pfad') };
    }

    try {
      const res = await fetchImpl(`${BASIS}${pfad}`, { method: 'GET', headers: kopf, redirect: 'manual', signal: AbortSignal.timeout(zeitlimitMs) });
      return { res };
    } catch (e) {
      return { fehler: unbekannt(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'Zeitlimit' : 'Netzfehler') };
    }
  }

  async function holeJson(pfad) {
    const { res, fehler } = await abruf(pfad);

    if (fehler) {
      return fehler;
    }

    try {
      if (res.status === 200) {
        const t = await begrenzterText(res, GRENZE_JSON);

        if (t === null) {
          return unbekannt('Antwort zu groß');
        }

        try {
          return { klasse: 'ok', daten: JSON.parse(t), status: 200 };
        } catch {
          return unbekannt('ungültiges JSON');
        }
      }

      if (res.status === 404) {
        const t = await begrenzterText(res, 64 * 1024);
        let k = null;

        try {
          k = t === null ? null : JSON.parse(t);
        } catch {
          k = null;
        }

        return k !== null && typeof k === 'object' && k.message === 'Not Found' ? { klasse: 'fehlt', status: 404 } : unbekannt('HTTP 404 ohne Not Found');
      }

      return unbekannt(grundAusStatus(res));
    } catch {
      return unbekannt('Netzfehler');
    }
  }

  // Alle Seiten eines Listen-Endpunkts. feld: Name des Arrays im Objekt (z. B. workflow_runs) oder null fuer eine
  // reine Liste. vollstaendig nur, wenn die letzte Seite kuerzer als PRO_SEITE war und (falls vorhanden) total_count
  // mit der Zahl der Eintraege uebereinstimmt.
  async function holeAlleSeiten(pfad, { feld = null, maxSeiten = MAX_SEITEN } = {}) {
    const daten = [];
    let gesamt = null;

    for (let seite = 1; seite <= maxSeiten; seite += 1) {
      const r = await holeJson(`${pfad}${pfad.includes('?') ? '&' : '?'}page=${seite}`);

      if (r.klasse !== 'ok') {
        return r.klasse === 'fehlt' ? unbekannt('HTTP 404') : r;
      }

      const liste = feld === null ? r.daten : r.daten?.[feld];

      if (!Array.isArray(liste)) {
        return unbekannt('unerwartete Antwort');
      }

      if (feld !== null && Number.isInteger(r.daten.total_count)) {
        gesamt = r.daten.total_count;
      }

      daten.push(...liste);

      if (liste.length < PRO_SEITE) {
        return { klasse: 'ok', daten, vollstaendig: gesamt === null || gesamt === daten.length };
      }
    }

    return { klasse: 'ok', daten, vollstaendig: false };
  }

  async function holeLog(jobId) {
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return unbekannt('ungültige Job-ID');
    }

    const { res, fehler } = await abruf(`/repos/noah04091/agenten-probe/actions/jobs/${jobId}/logs`);

    if (fehler) {
      return fehler;
    }

    if (res.status !== 302) {
      return unbekannt(res.status === 200 ? 'unerwartete Antwort ohne Weiterleitung' : grundAusStatus(res));
    }

    let ziel;

    try {
      ziel = new URL(res.headers.get('location') ?? '');
    } catch {
      return unbekannt('Weiterleitung ohne gültiges Ziel');
    }

    if (ziel.protocol !== 'https:' || !LOG_HOST.test(ziel.hostname) || ziel.port !== '' || ziel.username !== '' || ziel.password !== '') {
      return unbekannt('unerwartete Weiterleitung');
    }

    try {
      // Ohne Authorization: das Token geht nie an einen anderen Host.
      const log = await fetchImpl(ziel.href, { method: 'GET', headers: { 'User-Agent': 'zentrale-b1' }, redirect: 'error', signal: AbortSignal.timeout(zeitlimitMs) });

      if (log.status !== 200) {
        return unbekannt(`Download HTTP ${log.status}`);
      }

      const t = await begrenzterText(log, GRENZE_LOG);
      return t === null ? unbekannt('Log zu groß') : { klasse: 'ok', text: t };
    } catch (e) {
      return unbekannt(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'Zeitlimit' : 'Downloadfehler');
    }
  }

  return Object.freeze({ holeJson, holeAlleSeiten, holeLog });
}
