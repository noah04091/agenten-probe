// agent-abnahme-format: v2
//
// Abnahme fuer Issue #80 (A6 NF1): Das Issue verlangt eine Aenderung, die nie zu einem Auftrag werden
// darf. Diese Abnahme scheitert deshalb immer sofort und laedt keinen Anwendungscode.

throw new Error('NF1: Diese Abnahme darf nie erreicht werden');
