// Spielcode für den Ablauftest. Kein Bezug zu Contract AI.
//
// Vorgabe fuer Issue #38: multipliziere(a, b) gibt exakt das Ergebnis
// von a * b zurueck, einschliesslich -0 (0 * -9 ergibt -0, nicht 0).
// Keine zusaetzliche Normalisierung. Auch eigene Tests unterscheiden
// 0 und -0: assert.strictEqual(multipliziere(0, -9), -0).
function addiere(a, b) {
  return a + b;
}

function subtrahiere(a, b) {
  return a - b;
}

function multipliziere(a, b) {
  return a * b;
}

module.exports = { addiere, subtrahiere, multipliziere };

// T14
// T16 a
// T16 b
// T13: Test nachtraeglicher Aenderungen
