# D-Nummern-Vergleich – Version 3

Diese Version verwendet **kein OpenCV.js** und keine festen Scanbereiche. Die Kamera wird zuerst sichtbar gestartet. Erst danach wird ein einzelner Tesseract-OCR-Worker geladen. Dadurch soll die Seite auf Smartphones nicht mehr beim Kamerastart einfrieren.

## Starten

Im Projektordner:

```powershell
py -m http.server 8000
```

Am Computer öffnen:

```text
http://localhost:8000
```

Für das Smartphone muss die Seite über HTTPS bereitgestellt werden.

## Testreihenfolge

1. Zuerst `camera-test.html` öffnen. Diese Seite startet nur die Kamera und lädt keine OCR-Bibliothek.
2. Wenn dort ein Livebild sichtbar ist, anschließend `index.html` öffnen.
3. Kamera starten und warten, bis unter dem Bild `OCR bereit` erscheint.
4. Beide Etiketten vollständig ins Bild halten. Es gibt keine festen Zielrahmen.

## Warum Version 2 hängen konnte

- OpenCV.js wurde auf dem Hauptthread geladen und initialisiert.
- Gleichzeitig wurde eine hohe Kameraauflösung angefordert.
- Je nach Smartphone wurden zwei OCR-Worker gestartet.
- Das Livebild bekam dadurch teilweise keinen sichtbaren Zeichenzyklus, bevor die rechenintensive Initialisierung begann.

Version 3 behebt dies durch:

- Kameraauflösung 1280 × 720 als Ausgangswert
- automatische Fallbacks für andere Kameraeinstellungen
- zwei Browser-Zeichenzyklen vor dem OCR-Ladevorgang
- nur einen OCR-Worker
- keine OpenCV-Bibliothek
- zweite OCR-Bildvariante nur bei Bedarf

## Dateien

- `index.html` – Hauptanwendung
- `style.css` – Darstellung
- `app.js` – Kamera, OCR und Vergleich
- `camera-test.html` – isolierter Kameratest ohne OCR
