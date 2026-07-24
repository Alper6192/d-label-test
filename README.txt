ETIKETTENVERGLEICH – HANDY PHASE 2.0

Enthalten:
- index.html: vollständige Browserseite mit 12 eingebetteten Vorlagen
- produktionskonfiguration.json: bereinigte Konfiguration ohne Master-Sollwerte
- etiketten_templates_korrigiert.json: ursprüngliche Editor-Konfiguration mit korrigiertem VW-IDH-Wert

Bedienung:
1. index.html in Edge oder Chrome öffnen.
2. Bei Etikett 1 und Etikett 2 jeweils „Foto aufnehmen / auswählen“ drücken.
3. Die Seite versucht Format und Ausrichtung automatisch zu erkennen.
4. Scheitert die Automatik, Format auswählen und „Manuell ausrichten“ drücken.
5. Vier äußere Ecken des Etiketts antippen.
6. Batch, IDH und Gewicht werden verglichen. Fass- und Lieferscheinnummer werden angezeigt.

Datenschutz:
- Fotos werden nicht hochgeladen.
- Es gibt keinen OCR-Verarbeitungsserver.
- Fotos werden nur im Arbeitsspeicher verarbeitet.
- Beim Zurücksetzen oder Neuladen der Seite gehen die Aufnahmen verloren.

Wichtiger technischer Hinweis:
Diese Prototypversion lädt OpenCV.js und Tesseract.js als Programmbibliotheken aus dem Internet.
Die Bilder selbst werden nicht an diese Anbieter übertragen. Für einen vollständig
internetunabhängigen Firmenbetrieb sollten die Bibliotheksdateien später zusammen mit
der index.html auf einer internen statischen HTTPS-Seite bereitgestellt werden.

Korrigierte Auffälligkeiten:
- Format_011 VW: Der IDH-Sollwert war versehentlich als RegExp eingetragen.
  Er wurde anhand des Masterbilds auf 2892944 korrigiert.
- Format_007 Mercedes: Auf dem Masterbild steht IDH 2527583. Die Excel-Liste enthält
  dagegen 257583 und sollte fachlich korrigiert werden.
