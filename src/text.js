// Textgeruest fuer das Profil js-text (A6.3-1). Spielcode, kein Bezug zu Contract AI.

// Zaehlt die Unicode-Codepoints einer primitiven Zeichenkette. Nicht die UTF-16-Einheiten
// (text.length) und nicht die sichtbaren Graphem-Cluster. Keine Normalisierung, keine
// Typumwandlung: Alles ausser einer primitiven Zeichenkette loest einen TypeError aus.
function zeichenzahl(text) {
  if (typeof text !== 'string') {
    throw new TypeError('zeichenzahl erwartet eine primitive Zeichenkette');
  }

  // Der String-Iterator liefert je Durchlauf genau einen Codepoint.
  let anzahl = 0;

  for (const _codepoint of text) {
    anzahl += 1;
  }

  return anzahl;
}

module.exports = { zeichenzahl };
