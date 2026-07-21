(() => {
  "use strict";

  const DEFAULTS = Object.freeze({
    expectedDigits: 9,
    requiredMatches: 2,
    scanInterval: 2200,
    ocrWidth: 1280,
    showDebug: false,
  });

  const STORAGE_KEY = "d-label-scanner-v3-settings";
  const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js";

  const elements = {};
  let settings = { ...DEFAULTS };
  let mediaStream = null;
  let worker = null;
  let running = false;
  let processing = false;
  let scanTimer = null;
  let torchEnabled = false;
  let latestFrameSize = { width: 0, height: 0 };
  let latestCandidates = [];
  let lastSuccessSignature = null;

  const trackers = [createTracker(), createTracker()];

  document.addEventListener("DOMContentLoaded", initialize);
  window.addEventListener("resize", drawCandidateBoxes);
  window.addEventListener("pagehide", shutdown);

  function initialize() {
    cacheElements();
    loadSettings();
    applySettingsToControls();
    bindEvents();
    resetUi();

    if (!navigator.mediaDevices?.getUserMedia) {
      setScannerState("error", "Dieser Browser unterstützt keinen Kamerazugriff.");
      elements.startButton.disabled = true;
    }
  }

  function cacheElements() {
    const ids = [
      "scanner",
      "video",
      "overlayCanvas",
      "scannerMessage",
      "statusBadge",
      "cameraInfo",
      "ocrInfo",
      "firstValue",
      "firstMeta",
      "firstCounter",
      "secondValue",
      "secondMeta",
      "secondCounter",
      "startButton",
      "stopButton",
      "torchButton",
      "expectedDigits",
      "requiredMatches",
      "scanInterval",
      "ocrWidth",
      "zoomRow",
      "zoomRange",
      "showDebug",
      "debugPanel",
      "debugCanvas",
      "resetSettings",
      "frameCanvas",
    ];

    for (const id of ids) elements[id] = document.getElementById(id);
  }

  function bindEvents() {
    elements.startButton.addEventListener("click", startScanner);
    elements.stopButton.addEventListener("click", stopScanner);
    elements.torchButton.addEventListener("click", toggleTorch);
    elements.zoomRange.addEventListener("input", applyCameraZoom);
    elements.resetSettings.addEventListener("click", resetSettings);

    for (const id of ["expectedDigits", "requiredMatches", "scanInterval", "ocrWidth"]) {
      elements[id].addEventListener("change", () => {
        settings[id] = Number(elements[id].value);
        saveSettings();
        resetRecognition();
      });
    }

    elements.showDebug.addEventListener("change", () => {
      settings.showDebug = elements.showDebug.checked;
      elements.debugPanel.hidden = !settings.showDebug;
      saveSettings();
    });
  }

  async function startScanner() {
    if (running) return;

    elements.startButton.disabled = true;
    elements.stopButton.disabled = false;
    setScannerState("loading", "Kamera wird gestartet …");
    elements.statusBadge.textContent = "Kamera startet";

    try {
      await stopCameraOnly();
      mediaStream = await requestCameraWithFallback();

      const video = elements.video;
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.srcObject = mediaStream;

      await startVideoPlayback(video);
      running = true;
      configureCameraControls();
      updateCameraInfo();
      setScannerState("loading", "Kamera läuft – OCR wird geladen …");
      elements.statusBadge.textContent = "Kamera aktiv";

      // Zwei Browser-Zeichenzyklen abwarten. Dadurch wird das Livebild sichtbar,
      // bevor die OCR-Bibliothek und das Sprachmodell geladen werden.
      await nextPaint();
      await nextPaint();
      await delay(250);

      await ensureOcrReady();
      if (!running) return;

      resetRecognition();
      setScannerState("scanning", "Beide Etiketten vollständig ins Bild halten");
      elements.statusBadge.textContent = "Bereit zum Lesen";
      scheduleNextScan(300);
    } catch (error) {
      console.error("Startfehler:", error);
      await stopCameraOnly();
      running = false;
      elements.startButton.disabled = false;
      elements.stopButton.disabled = true;
      setScannerState("error", readableError(error));
      elements.statusBadge.textContent = "Fehler";
      elements.cameraInfo.textContent = error?.message || "Kamera konnte nicht gestartet werden";
    }
  }

  async function requestCameraWithFallback() {
    const attempts = [
      {
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
        },
      },
      {
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      },
      {
        audio: false,
        video: true,
      },
    ];

    let lastError = null;
    for (const constraints of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        lastError = error;
        if (error?.name === "NotAllowedError" || error?.name === "SecurityError") throw error;
      }
    }

    throw lastError || new Error("Keine Kamera verfügbar.");
  }

  async function startVideoPlayback(video) {
    const metadataPromise = waitForVideoEvent(video, ["loadedmetadata", "canplay"], 12000);

    // play() direkt aufrufen; auf einigen mobilen Browsern kommt loadedmetadata erst danach zuverlässig.
    const playPromise = video.play().catch((error) => {
      if (error?.name === "NotAllowedError") throw error;
      return null;
    });

    await metadataPromise;
    await playPromise;

    const startedAt = Date.now();
    while ((!video.videoWidth || !video.videoHeight || video.readyState < 2) && Date.now() - startedAt < 8000) {
      await delay(100);
    }

    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("Die Kamera liefert kein sichtbares Bild.");
    }
  }

  function waitForVideoEvent(video, eventNames, timeoutMs) {
    if (video.readyState >= 2 && video.videoWidth) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        for (const name of eventNames) video.removeEventListener(name, onReady);
        video.removeEventListener("error", onError);
        clearTimeout(timeout);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onReady = () => finish(resolve);
      const onError = () => finish(reject, new Error("Fehler beim Anzeigen des Kamerabilds."));
      const timeout = window.setTimeout(
        () => finish(reject, new Error("Kamera-Timeout: Es wurde kein Videobild empfangen.")),
        timeoutMs,
      );

      for (const name of eventNames) video.addEventListener(name, onReady, { once: true });
      video.addEventListener("error", onError, { once: true });
    });
  }

  async function ensureOcrReady() {
    if (worker) return;

    elements.ocrInfo.textContent = "OCR-Bibliothek wird geladen";
    elements.statusBadge.textContent = "OCR wird geladen";
    await loadScriptOnce(TESSERACT_URL, "tesseract-script", 30000);

    if (!window.Tesseract) throw new Error("Tesseract.js konnte nicht geladen werden.");

    worker = await window.Tesseract.createWorker("eng", 1, {
      logger(message) {
        if (!running) return;
        const percent = Math.round((message.progress || 0) * 100);
        if (message.status === "loading tesseract core") {
          elements.ocrInfo.textContent = `OCR-Kern ${percent}%`;
        } else if (message.status === "loading language traineddata") {
          elements.ocrInfo.textContent = `Sprachmodell ${percent}%`;
        } else if (message.status === "recognizing text") {
          elements.ocrInfo.textContent = `Texterkennung ${percent}%`;
        }
      },
    });

    await worker.setParameters({
      tessedit_pageseg_mode: window.Tesseract.PSM?.SPARSE_TEXT ?? "11",
      preserve_interword_spaces: "1",
      user_defined_dpi: "220",
    });

    elements.ocrInfo.textContent = "OCR bereit";
  }

  function loadScriptOnce(src, id, timeoutMs) {
    if (document.getElementById(id)) {
      return window.Tesseract ? Promise.resolve() : waitForGlobal("Tesseract", timeoutMs);
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = id;
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("OCR-Bibliothek konnte nicht aus dem Internet geladen werden."));
      document.head.appendChild(script);
      window.setTimeout(() => reject(new Error("Timeout beim Laden der OCR-Bibliothek.")), timeoutMs);
    });
  }

  async function waitForGlobal(name, timeoutMs) {
    const started = Date.now();
    while (!window[name]) {
      if (Date.now() - started > timeoutMs) throw new Error(`${name} wurde nicht geladen.`);
      await delay(100);
    }
  }

  function scheduleNextScan(delayMs = settings.scanInterval) {
    clearTimeout(scanTimer);
    if (!running) return;
    scanTimer = window.setTimeout(scanOnce, delayMs);
  }

  async function scanOnce() {
    if (!running || processing || !worker) {
      scheduleNextScan();
      return;
    }

    processing = true;
    elements.statusBadge.textContent = "Lese Etiketten";

    try {
      const original = captureVideoFrame();
      const prepared = prepareOcrCanvas(original, false);
      updateDebugCanvas(prepared);

      let candidates = await recognizeCandidates(prepared);

      // Zweite, stärker kontrastierte Variante nur dann ausführen, wenn die erste
      // Erkennung noch nicht zwei D-Nummern geliefert hat. Das spart Rechenleistung.
      if (running && candidates.length < 2) {
        const binary = prepareOcrCanvas(original, true);
        updateDebugCanvas(binary);
        const secondPass = await recognizeCandidates(binary);
        candidates = mergeCandidates(candidates, secondPass);
      }

      if (!running) return;

      latestCandidates = selectTwoOccurrences(candidates);
      drawCandidateBoxes();
      updateRecognition(latestCandidates);
    } catch (error) {
      console.error("OCR-Fehler:", error);
      setScannerState("error", "Fehler bei der Texterkennung – erneut versuchen");
      elements.ocrInfo.textContent = error?.message || "OCR-Fehler";
    } finally {
      processing = false;
      if (running) {
        if (elements.scanner.dataset.state === "scanning") elements.statusBadge.textContent = "Kamera aktiv";
        scheduleNextScan();
      }
    }
  }

  function captureVideoFrame() {
    const video = elements.video;
    if (!video.videoWidth || !video.videoHeight) throw new Error("Noch kein Kamerabild verfügbar.");

    const targetWidth = Math.min(Number(settings.ocrWidth), video.videoWidth);
    const targetHeight = Math.max(1, Math.round(video.videoHeight * targetWidth / video.videoWidth));
    const canvas = elements.frameCanvas;
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    context.drawImage(video, 0, 0, targetWidth, targetHeight);
    latestFrameSize = { width: targetWidth, height: targetHeight };
    return canvas;
  }

  function prepareOcrCanvas(source, binary) {
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    context.drawImage(source, 0, 0);

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const histogram = new Uint32Array(256);
    const grayscale = new Uint8Array(canvas.width * canvas.height);

    let pixel = 0;
    for (let index = 0; index < data.length; index += 4) {
      const gray = Math.round(0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2]);
      grayscale[pixel] = gray;
      histogram[gray] += 1;
      pixel += 1;
    }

    const low = percentileFromHistogram(histogram, grayscale.length, 0.02);
    const high = percentileFromHistogram(histogram, grayscale.length, 0.98);
    const range = Math.max(35, high - low);
    const threshold = binary ? otsuThreshold(histogram, grayscale.length) : 0;

    pixel = 0;
    for (let index = 0; index < data.length; index += 4) {
      let value = clamp(Math.round((grayscale[pixel] - low) * 255 / range), 0, 255);
      value = clamp(Math.round((value - 128) * 1.18 + 128), 0, 255);
      if (binary) value = value >= threshold ? 255 : 0;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
      pixel += 1;
    }

    context.putImageData(imageData, 0, 0);
    return canvas;
  }

  async function recognizeCandidates(canvas) {
    const response = await worker.recognize(canvas, {}, { text: true, tsv: true });
    return extractCandidates(response.data, settings.expectedDigits, canvas.width, canvas.height);
  }

  function extractCandidates(data, expectedDigits, imageWidth, imageHeight) {
    const lines = parseTsvLines(data.tsv);
    const candidates = [];

    for (const line of lines) {
      const lineCandidates = findCodesInText(line.text, expectedDigits);
      for (const codeInfo of lineCandidates) {
        candidates.push({
          code: codeInfo.code,
          method: codeInfo.method,
          confidence: line.confidence,
          rect: expandRect(line.rect, imageWidth, imageHeight),
          sourceText: line.text,
        });
      }
    }

    if (!candidates.length && data.text) {
      const rawCandidates = findCodesInText(String(data.text), expectedDigits);
      for (const codeInfo of rawCandidates) {
        candidates.push({
          code: codeInfo.code,
          method: `${codeInfo.method} (ohne Position)`,
          confidence: Number.isFinite(data.confidence) ? Math.round(data.confidence) : 0,
          rect: null,
          sourceText: String(data.text).trim(),
        });
      }
    }

    return candidates;
  }

  function parseTsvLines(tsv) {
    if (!tsv || typeof tsv !== "string") return [];

    const groups = new Map();
    const rows = tsv.split(/\r?\n/).slice(1);

    for (const row of rows) {
      if (!row.trim()) continue;
      const columns = row.split("\t");
      if (columns.length < 12 || columns[0] !== "5") continue;

      const text = columns.slice(11).join("\t").trim();
      if (!text) continue;

      const key = `${columns[1]}-${columns[2]}-${columns[3]}-${columns[4]}`;
      const left = Number(columns[6]);
      const top = Number(columns[7]);
      const width = Number(columns[8]);
      const height = Number(columns[9]);
      const confidence = Number(columns[10]);

      if (![left, top, width, height].every(Number.isFinite)) continue;

      const group = groups.get(key) || {
        words: [],
        confidences: [],
        left: Infinity,
        top: Infinity,
        right: 0,
        bottom: 0,
      };

      group.words.push(text);
      if (Number.isFinite(confidence) && confidence >= 0) group.confidences.push(confidence);
      group.left = Math.min(group.left, left);
      group.top = Math.min(group.top, top);
      group.right = Math.max(group.right, left + width);
      group.bottom = Math.max(group.bottom, top + height);
      groups.set(key, group);
    }

    return [...groups.values()].map((group) => ({
      text: group.words.join(" "),
      confidence: group.confidences.length
        ? Math.round(group.confidences.reduce((sum, value) => sum + value, 0) / group.confidences.length)
        : 0,
      rect: {
        x: group.left,
        y: group.top,
        width: Math.max(1, group.right - group.left),
        height: Math.max(1, group.bottom - group.top),
      },
    }));
  }

  function findCodesInText(text, expectedDigits) {
    const source = String(text || "").toUpperCase();
    const compact = source.replace(/[^A-Z0-9]/g, "");
    const digitLike = "0-9OQILSZGB";
    const results = [];

    // Sicherster Fall: echtes D, danach genau die erwartete Anzahl Ziffern/ähnliche Zeichen.
    const direct = new RegExp(`D([${digitLike}]{${expectedDigits}})`, "g");
    let match;
    while ((match = direct.exec(compact)) !== null) {
      const digits = normalizeDigitRun(match[1]);
      if (digits.length === expectedDigits) results.push({ code: `D${digits}`, method: "D-Präfix erkannt" });
    }

    // Häufiger OCR-Fehler: D wird als 0, O oder Q gelesen.
    const confusedPrefix = new RegExp(`(?:^|[^0-9])([0OQ])([${digitLike}]{${expectedDigits}})(?:$|[^0-9])`, "g");
    while ((match = confusedPrefix.exec(source.replace(/\s+/g, ""))) !== null) {
      const digits = normalizeDigitRun(match[2]);
      if (digits.length === expectedDigits) results.push({ code: `D${digits}`, method: "D als 0/O/Q gelesen" });
    }

    // Nur in typischem Kontext eine nackte Ziffernfolge akzeptieren.
    if (/BATCH|CHARG|CHARGE|LOT|BATCHNO|CHARGEN/.test(compact)) {
      const bare = new RegExp(`(^|\D)(\d{${expectedDigits}})(?=\D|$)`, "g");
      while ((match = bare.exec(source)) !== null) {
        results.push({ code: `D${match[2]}`, method: "Ziffernfolge im Chargenkontext" });
      }
    }

    return dedupeCodes(results);
  }

  function normalizeDigitRun(value) {
    const replacements = { O: "0", Q: "0", I: "1", L: "1", Z: "2", S: "5", G: "6", B: "8" };
    return String(value)
      .toUpperCase()
      .replace(/[^0-9OQILSZGB]/g, "")
      .split("")
      .map((character) => replacements[character] || character)
      .join("");
  }

  function dedupeCodes(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.code}|${item.method}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function mergeCandidates(first, second) {
    const merged = [...first];

    for (const candidate of second) {
      const duplicate = merged.some((existing) => {
        if (existing.code !== candidate.code) return false;
        if (!existing.rect || !candidate.rect) return true;
        return intersectionOverUnion(existing.rect, candidate.rect) > 0.3;
      });
      if (!duplicate) merged.push(candidate);
    }

    return merged;
  }

  function selectTwoOccurrences(candidates) {
    const positioned = candidates
      .filter((candidate) => candidate.rect)
      .sort((a, b) => {
        const yDifference = centerY(a.rect) - centerY(b.rect);
        if (Math.abs(yDifference) > Math.min(a.rect.height, b.rect.height) * 0.5) return yDifference;
        return a.rect.x - b.rect.x;
      });

    const selected = [];
    for (const candidate of positioned) {
      const overlapsExisting = selected.some((existing) => intersectionOverUnion(existing.rect, candidate.rect) > 0.35);
      if (!overlapsExisting) selected.push(candidate);
      if (selected.length === 2) break;
    }

    if (selected.length < 2) {
      for (const candidate of candidates.filter((item) => !item.rect)) {
        selected.push(candidate);
        if (selected.length === 2) break;
      }
    }

    return selected.slice(0, 2);
  }

  function updateRecognition(candidates) {
    const ordered = [...candidates].sort((a, b) => {
      if (!a.rect && !b.rect) return 0;
      if (!a.rect) return 1;
      if (!b.rect) return -1;
      return centerY(a.rect) - centerY(b.rect);
    });

    const stable = [null, null];
    for (let index = 0; index < 2; index += 1) {
      const candidate = ordered[index] || null;
      stable[index] = updateTracker(trackers[index], candidate?.code || null);
      renderResult(index, candidate);
    }

    if (ordered.length < 2) {
      lastSuccessSignature = null;
      setScannerState(
        "scanning",
        ordered.length === 1
          ? "Eine D-Nummer erkannt – beide Etiketten vollständig zeigen"
          : "Noch keine zwei D-Nummern erkannt – etwas näher herangehen",
      );
      elements.ocrInfo.textContent = ordered.length === 1 ? "1 von 2 Nummern erkannt" : "Keine D-Nummer erkannt";
      return;
    }

    if (!stable[0] || !stable[1]) {
      lastSuccessSignature = null;
      setScannerState("scanning", "Zwei Nummern erkannt – Handy kurz ruhig halten");
      elements.ocrInfo.textContent = "Nummern werden bestätigt";
      return;
    }

    if (stable[0] === stable[1]) {
      const signature = `${stable[0]}|${stable[1]}`;
      setScannerState("success", `Übereinstimmung: ${stable[0]}`);
      elements.statusBadge.textContent = "Übereinstimmung";
      elements.ocrInfo.textContent = "Beide Nummern bestätigt";

      if (signature !== lastSuccessSignature) {
        lastSuccessSignature = signature;
        if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      }
    } else {
      lastSuccessSignature = null;
      setScannerState("error", `Abweichung: ${stable[0]} ≠ ${stable[1]}`);
      elements.statusBadge.textContent = "Abweichung";
      elements.ocrInfo.textContent = "Beide Nummern bestätigt";
    }
  }

  function renderResult(index, candidate) {
    const tracker = trackers[index];
    const value = index === 0 ? elements.firstValue : elements.secondValue;
    const meta = index === 0 ? elements.firstMeta : elements.secondMeta;
    const counter = index === 0 ? elements.firstCounter : elements.secondCounter;

    value.textContent = candidate?.code || tracker.candidate || "—";
    counter.textContent = `${Math.min(tracker.count, settings.requiredMatches)}/${settings.requiredMatches}`;

    if (!candidate) {
      meta.textContent = tracker.candidate ? "Warte auf erneute Erkennung" : "Noch nicht erkannt";
    } else if (tracker.stable) {
      meta.textContent = `Bestätigt · ${candidate.method} · OCR ${candidate.confidence}%`;
    } else {
      meta.textContent = `Erkannt · ${candidate.method} · OCR ${candidate.confidence}%`;
    }
  }

  function createTracker() {
    return { candidate: null, count: 0, stable: null, misses: 0 };
  }

  function updateTracker(tracker, code) {
    if (!code) {
      tracker.misses += 1;
      if (tracker.misses >= 2) Object.assign(tracker, createTracker());
      return tracker.stable;
    }

    tracker.misses = 0;
    if (tracker.candidate === code) {
      tracker.count += 1;
    } else {
      tracker.candidate = code;
      tracker.count = 1;
      tracker.stable = null;
    }

    if (tracker.count >= settings.requiredMatches) tracker.stable = code;
    return tracker.stable;
  }

  function drawCandidateBoxes() {
    const canvas = elements.overlayCanvas;
    const scannerRect = elements.scanner.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(scannerRect.width * dpr));
    canvas.height = Math.max(1, Math.round(scannerRect.height * dpr));

    const context = canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, scannerRect.width, scannerRect.height);

    if (!latestFrameSize.width || !latestCandidates.length) return;

    const state = elements.scanner.dataset.state;
    const stroke = state === "success" ? "#22c55e" : state === "error" ? "#ef4444" : "#f59e0b";
    context.lineWidth = 3;
    context.font = "700 13px system-ui, sans-serif";

    latestCandidates.forEach((candidate, index) => {
      if (!candidate.rect) return;
      const mapped = mapSourceRectToPreview(candidate.rect, scannerRect.width, scannerRect.height);
      context.strokeStyle = stroke;
      context.strokeRect(mapped.x, mapped.y, mapped.width, mapped.height);

      const label = `Etikett ${index + 1}: ${candidate.code}`;
      const textWidth = context.measureText(label).width;
      const labelX = mapped.x;
      const labelY = Math.max(4, mapped.y - 24);
      context.fillStyle = "rgba(2, 6, 23, 0.9)";
      context.fillRect(labelX, labelY, textWidth + 14, 21);
      context.fillStyle = "#fff";
      context.fillText(label, labelX + 7, labelY + 15);
    });
  }

  function mapSourceRectToPreview(rect, previewWidth, previewHeight) {
    const scale = Math.min(previewWidth / latestFrameSize.width, previewHeight / latestFrameSize.height);
    const displayedWidth = latestFrameSize.width * scale;
    const displayedHeight = latestFrameSize.height * scale;
    const offsetX = (previewWidth - displayedWidth) / 2;
    const offsetY = (previewHeight - displayedHeight) / 2;

    return {
      x: offsetX + rect.x * scale,
      y: offsetY + rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    };
  }

  function updateDebugCanvas(source) {
    if (!settings.showDebug) return;
    const target = elements.debugCanvas;
    target.width = source.width;
    target.height = source.height;
    target.getContext("2d").drawImage(source, 0, 0);
  }

  function expandRect(rect, maximumWidth, maximumHeight) {
    const padX = Math.max(8, rect.width * 0.12);
    const padY = Math.max(6, rect.height * 0.45);
    const x = clamp(rect.x - padX, 0, maximumWidth - 1);
    const y = clamp(rect.y - padY, 0, maximumHeight - 1);
    const right = clamp(rect.x + rect.width + padX, x + 1, maximumWidth);
    const bottom = clamp(rect.y + rect.height + padY, y + 1, maximumHeight);
    return { x, y, width: right - x, height: bottom - y };
  }

  function intersectionOverUnion(a, b) {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const union = a.width * a.height + b.width * b.height - intersection;
    return union > 0 ? intersection / union : 0;
  }

  function centerY(rect) {
    return rect.y + rect.height / 2;
  }

  function percentileFromHistogram(histogram, total, percentile) {
    const target = total * percentile;
    let cumulative = 0;
    for (let value = 0; value < 256; value += 1) {
      cumulative += histogram[value];
      if (cumulative >= target) return value;
    }
    return 255;
  }

  function otsuThreshold(histogram, total) {
    let sum = 0;
    for (let value = 0; value < 256; value += 1) sum += value * histogram[value];

    let sumBackground = 0;
    let weightBackground = 0;
    let maximumVariance = 0;
    let threshold = 128;

    for (let value = 0; value < 256; value += 1) {
      weightBackground += histogram[value];
      if (!weightBackground) continue;
      const weightForeground = total - weightBackground;
      if (!weightForeground) break;

      sumBackground += value * histogram[value];
      const meanBackground = sumBackground / weightBackground;
      const meanForeground = (sum - sumBackground) / weightForeground;
      const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

      if (variance > maximumVariance) {
        maximumVariance = variance;
        threshold = value;
      }
    }

    return threshold;
  }

  function configureCameraControls() {
    const track = mediaStream?.getVideoTracks()[0];
    if (!track?.getCapabilities) return;

    const capabilities = track.getCapabilities();
    elements.torchButton.hidden = !capabilities.torch;
    elements.torchButton.disabled = false;

    if (capabilities.zoom && Number.isFinite(capabilities.zoom.min) && Number.isFinite(capabilities.zoom.max)) {
      elements.zoomRange.min = String(capabilities.zoom.min);
      elements.zoomRange.max = String(capabilities.zoom.max);
      elements.zoomRange.step = String(capabilities.zoom.step || 0.1);
      elements.zoomRange.value = String(track.getSettings?.().zoom ?? capabilities.zoom.min);
      elements.zoomRow.hidden = false;
    } else {
      elements.zoomRow.hidden = true;
    }
  }

  async function applyCameraZoom() {
    const track = mediaStream?.getVideoTracks()[0];
    if (!track?.applyConstraints) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: Number(elements.zoomRange.value) }] });
    } catch (error) {
      console.warn("Zoom konnte nicht gesetzt werden:", error);
    }
  }

  async function toggleTorch() {
    const track = mediaStream?.getVideoTracks()[0];
    if (!track?.applyConstraints) return;

    try {
      torchEnabled = !torchEnabled;
      await track.applyConstraints({ advanced: [{ torch: torchEnabled }] });
      elements.torchButton.textContent = torchEnabled ? "Licht ausschalten" : "Licht einschalten";
    } catch (error) {
      torchEnabled = false;
      elements.torchButton.textContent = "Licht nicht verfügbar";
      elements.torchButton.disabled = true;
      console.warn("Kameralicht konnte nicht geschaltet werden:", error);
    }
  }

  function updateCameraInfo() {
    const track = mediaStream?.getVideoTracks()[0];
    const trackSettings = track?.getSettings?.() || {};
    const width = elements.video.videoWidth || trackSettings.width || "?";
    const height = elements.video.videoHeight || trackSettings.height || "?";
    const cameraName = track?.label ? ` · ${track.label}` : "";
    elements.cameraInfo.textContent = `Kamera ${width} × ${height}${cameraName}`;
  }

  async function stopScanner() {
    running = false;
    processing = false;
    clearTimeout(scanTimer);
    scanTimer = null;
    await stopCameraOnly();
    resetUi();
  }

  async function stopCameraOnly() {
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) track.stop();
    }
    mediaStream = null;
    elements.video.pause();
    elements.video.srcObject = null;
    torchEnabled = false;
  }

  async function shutdown() {
    await stopScanner();
    if (worker) {
      try {
        await worker.terminate();
      } catch (error) {
        console.warn("OCR-Worker konnte nicht beendet werden:", error);
      }
      worker = null;
    }
  }

  function resetRecognition() {
    trackers.forEach((tracker) => Object.assign(tracker, createTracker()));
    latestCandidates = [];
    lastSuccessSignature = null;
    elements.firstValue.textContent = "—";
    elements.secondValue.textContent = "—";
    elements.firstMeta.textContent = "Noch nicht erkannt";
    elements.secondMeta.textContent = "Noch nicht erkannt";
    elements.firstCounter.textContent = `0/${settings.requiredMatches}`;
    elements.secondCounter.textContent = `0/${settings.requiredMatches}`;
    drawCandidateBoxes();
  }

  function resetUi() {
    resetRecognition();
    elements.startButton.disabled = false;
    elements.stopButton.disabled = true;
    elements.torchButton.hidden = true;
    elements.torchButton.textContent = "Licht einschalten";
    elements.zoomRow.hidden = true;
    elements.cameraInfo.textContent = "Noch keine Kamera aktiv";
    elements.ocrInfo.textContent = worker ? "OCR geladen" : "OCR nicht geladen";
    elements.statusBadge.textContent = "Bereit";
    setScannerState("idle", "Kamera starten und beide Etiketten vollständig ins Bild halten");
  }

  function setScannerState(state, message) {
    elements.scanner.dataset.state = state;
    elements.scannerMessage.textContent = message;
    drawCandidateBoxes();
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      settings = saved && typeof saved === "object" ? { ...DEFAULTS, ...saved } : { ...DEFAULTS };
    } catch (error) {
      settings = { ...DEFAULTS };
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function applySettingsToControls() {
    for (const [key, value] of Object.entries(settings)) {
      const control = elements[key];
      if (!control) continue;
      if (control.type === "checkbox") control.checked = Boolean(value);
      else control.value = String(value);
    }
    elements.debugPanel.hidden = !settings.showDebug;
  }

  function resetSettings() {
    settings = { ...DEFAULTS };
    saveSettings();
    applySettingsToControls();
    resetRecognition();
  }

  function readableError(error) {
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
      return "Kamerazugriff wurde blockiert. In den Browser-Einstellungen die Kamera erlauben.";
    }
    if (error?.name === "NotFoundError") return "Keine Kamera gefunden.";
    if (error?.name === "NotReadableError") return "Die Kamera wird bereits von einer anderen App verwendet.";
    if (error?.name === "OverconstrainedError") return "Die angeforderte Kameraauflösung wird nicht unterstützt.";
    return error?.message || "Kamera oder OCR konnten nicht gestartet werden.";
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function nextPaint() {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }
})();
