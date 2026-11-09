// Nachweis, welche Workflow-Version ein PR-Lauf wirklich ausgeführt hat. NUR LESEND.
// Aufruf: node nachweis.js <pr-nummer>
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const R = 'noah04091/agenten-probe';
const pr = process.argv[2];
if (!pr) { console.log('Aufruf: node nachweis.js <pr-nummer>'); process.exit(1); }
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const sha256 = t => crypto.createHash('sha256').update(t.replace(/\r/g, '')).digest('hex');

const info = JSON.parse(gh('pr', 'view', pr, '-R', R, '--json', 'headRefName,headRefOid,isDraft,mergeStateStatus'));
console.log(`PR #${pr} · Zweig ${info.headRefName} · Stand ${info.headRefOid.slice(0, 7)} · Entwurf: ${info.isDraft} · Merge-Zustand: ${info.mergeStateStatus}\n`);

const laeufe = JSON.parse(gh('api', `repos/${R}/actions/runs?head_sha=${info.headRefOid}&per_page=20`)).workflow_runs;
if (!laeufe.length) console.log('Keine Läufe für diesen Stand gefunden.');
for (const lauf of laeufe) {
  const datei = lauf.path; // z. B. .github/workflows/tests.yml
  let sollHash = '?';
  try { sollHash = sha256(Buffer.from(JSON.parse(gh('api', `repos/${R}/contents/${datei}?ref=${info.headRefOid}`)).content, 'base64').toString('utf8')); } catch {}
  const jobs = JSON.parse(gh('api', `repos/${R}/actions/runs/${lauf.id}/jobs`)).jobs;
  let log = '';
  try { log = gh('run', 'view', String(lauf.id), '-R', R, '--log'); } catch {}
  const version = (log.match(/Workflow-Version: (\S+ \S+)/) || [])[1] || 'nicht im Protokoll';
  const istHash = (log.match(/\b([0-9a-f]{64})\s+-/) || [])[1] || 'nicht im Protokoll';
  console.log(`== ${lauf.name} (${datei}) · Ereignis ${lauf.event} · ${lauf.status}/${lauf.conclusion || '-'}`);
  console.log(`   Version laut Protokoll : ${version}`);
  console.log(`   Prüfsumme ausgeführt   : ${istHash}`);
  console.log(`   Prüfsumme im Commit    : ${sollHash}`);
  console.log(`   Übereinstimmung        : ${istHash === sollHash ? 'JA' : 'NEIN'}`);
  for (const j of jobs) {
    console.log(`   Job ${j.name}: ${j.status}/${j.conclusion || '-'}${j.conclusion === 'skipped' ? '   <-- ÜBERSPRUNGEN' : ''}`);
    for (const s of j.steps || []) if (/^(Tests|Build|Nur \.md)/.test(s.name)) console.log(`      Schritt "${s.name}": ${s.conclusion}`);
  }
  console.log('');
}
