"use strict";

(() => {
  const VERSION = "13.0";

  const SETTINGS = Object.freeze({
    /*
     * Es werden ausschließlich Querformatfotos akzeptiert.
     */
    requireLandscape: true,

    /*
     * Kleinere Bilder beschleunigen OCR und Bildvergleich.
     */
    maximumWidth: 1400,
    maximumHeight: 900,

    /*
     * Rein visuell nur fast identische Bilder blockieren.
     */
    visualOnlyDuplicate: 0.995,

    /*
     * Textvergleich nach der OCR.
     */
    strongTextSimilarity: 0.92,
    visualWithStrongText: 0.64,
    requiredStrongIdentifiers: 2,

    mediumTextSimilarity: 0.82,
    visualWithMediumText: 0.72,
    requiredMediumIdentifiers: 3
  });


  /*
   * Alle Buchstaben müssen zugelassen sein.
   *
   * Andernfalls könnte Tesseract beispielsweise
   * ein A zwangsweise als D ausgeben.
   */
  const CODE_OCR_PARAMETERS = Object.freeze({
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",

    tessedit_pageseg_mode: "11",

    preserve_interword_spaces: "1",

    user_defined_dpi: "220"
  });


  const GENERIC_WORDS = new Set([
    "AG",
    "BATCH",
    "BATCHNO",
    "CHARGE",
    "CHARGENNUMMER",
    "CO",
    "DATE",
    "DATUM",
    "DELIVERY",
    "DELIVERYNOTE",
    "ETIKETT",
    "GEWICHT",
    "GROSS",
    "HENKEL",
    "KG",
    "LABEL",
    "LIEFERSCHEIN",
    "LOT",
    "LOTNO",
    "MADE",
    "MATERIAL",
    "MENGE",
    "NET",
    "NOTE",
    "NUMBER",
    "NUMMER",
    "PACKING",
    "PRODUCT",
    "PRODUKT",
    "QUANTITY",
    "WEIGHT"
  ]);


  /*
   * =========================================================
   * ALLGEMEINE HILFSFUNKTIONEN
   * =========================================================
   */

  function normalizeTextInput(value) {
    if (value == null) {
      return "";
    }

    if (typeof value === "string") {
      return value;
    }

    if (Array.isArray(value)) {
      return value
        .map(item =>
          normalizeTextInput(item)
        )
        .filter(Boolean)
        .join("\n");
    }

    if (typeof value === "object") {
      if (
        typeof value.text === "string"
      ) {
        return value.text;
      }

      if (
        typeof value.rawText === "string"
      ) {
        return value.rawText;
      }

      if (
        typeof value.ocrText === "string"
      ) {
        return value.ocrText;
      }

      if (
        typeof value.identityText === "string"
      ) {
        return value.identityText;
      }

      if (
        value.data &&
        typeof value.data.text === "string"
      ) {
        return value.data.text;
      }

      if (
        Array.isArray(value.passes)
      ) {
        return normalizeTextInput(
          value.passes
        );
      }

      if (
        Array.isArray(value.results)
      ) {
        return normalizeTextInput(
          value.results
        );
      }
    }

    return String(value);
  }


  function isCanvasLike(value) {
    return Boolean(
      value &&
      typeof value.getContext === "function" &&
      Number(value.width) > 0 &&
      Number(value.height) > 0
    );
  }


  function isBlobLike(value) {
    return Boolean(
      value &&
      typeof value.arrayBuffer === "function" &&
      Number.isFinite(
        Number(value.size)
      )
    );
  }


  function extractCanvas(input) {
    if (isCanvasLike(input)) {
      return input;
    }

    if (
      input &&
      typeof input === "object"
    ) {
      const candidates = [
        input.canvas,
        input.sourceCanvas,
        input.preparedCanvas,
        input.ocrCanvas,
        input.imageCanvas
      ];

      for (
        const candidate
        of candidates
      ) {
        if (
          isCanvasLike(candidate)
        ) {
          return candidate;
        }
      }
    }

    return null;
  }


  /*
   * =========================================================
   * D-NUMMERN
   * =========================================================
   *
   * Die Regel lautet:
   *
   * D muss unmittelbar von mindestens einer Ziffer
   * gefolgt werden.
   *
   * Die Zahlenfolge endet beim nächsten Leerzeichen,
   * Tab oder Zeilenumbruch.
   *
   * Verschiedene OCR-Blöcke werden niemals verbunden.
   *
   * Gültig:
   *
   * D123
   * D562708020
   * D123456789012345
   *
   * Ungültig:
   *
   * D 123
   * D-123
   * DA123
   * D123A
   * A0059897120
   */

  function extractStrictDCodes(value) {
    const tokens =
      normalizeTextInput(value)
        .toUpperCase()
        .replace(/\r/g, "")
        .split(/\s+/)
        .filter(Boolean);

    const results =
      new Set();

    for (const token of tokens) {
      /*
       * Der vollständige OCR-Block muss passen.
       *
       * Es werden weder Buchstaben ersetzt noch
       * benachbarte Zahlen angehängt.
       */
      if (
        /^D[0-9]+$/.test(token)
      ) {
        results.add(token);
      }
    }

    return [...results];
  }


  function normalizeManualCode(value) {
    /*
     * Fehler werden nicht automatisch entfernt.
     *
     * D 123 bleibt D 123 und ist ungültig.
     */
    return String(value || "")
      .toUpperCase()
      .trim();
  }


  function isValidCode(value) {
    return /^D[0-9]+$/.test(
      normalizeManualCode(value)
    );
  }


  function getCodeOcrParameters() {
    return {
      ...CODE_OCR_PARAMETERS
    };
  }


  async function configureCodeWorker(
    worker
  ) {
    if (
      !worker ||
      typeof worker.setParameters !==
        "function"
    ) {
      throw new Error(
        "Der OCR-Worker ist nicht verfügbar."
      );
    }

    await worker.setParameters(
      getCodeOcrParameters()
    );
  }


  /*
   * =========================================================
   * BILD LADEN
   * =========================================================
   */

  async function createCanvasFromFile(
    file
  ) {
    if (!file) {
      throw new Error(
        "Keine Bilddatei vorhanden."
      );
    }

    let image = null;

    if (
      typeof createImageBitmap ===
      "function"
    ) {
      try {
        image =
          await createImageBitmap(
            file,
            {
              imageOrientation:
                "from-image"
            }
          );
      } catch (error) {
        console.warn(
          "createImageBitmap fehlgeschlagen.",
          error
        );
      }
    }

    if (!image) {
      image =
        await loadImageElement(file);
    }

    const width =
      Number(
        image.width ||
        image.naturalWidth
      );

    const height =
      Number(
        image.height ||
        image.naturalHeight
      );

    if (
      !width ||
      !height
    ) {
      throw new Error(
        "Die Bildgröße konnte nicht ermittelt werden."
      );
    }

    const canvas =
      document.createElement(
        "canvas"
      );

    canvas.width = width;
    canvas.height = height;

    const context =
      canvas.getContext(
        "2d",
        {
          willReadFrequently: true
        }
      );

    if (!context) {
      throw new Error(
        "Das Foto konnte nicht vorbereitet werden."
      );
    }

    context.drawImage(
      image,
      0,
      0,
      width,
      height
    );

    if (
      typeof image.close ===
      "function"
    ) {
      image.close();
    }

    return canvas;
  }


  function loadImageElement(file) {
    return new Promise(
      (resolve, reject) => {
        const image =
          new Image();

        const url =
          URL.createObjectURL(file);

        image.onload = () => {
          URL.revokeObjectURL(url);
          resolve(image);
        };

        image.onerror = () => {
          URL.revokeObjectURL(url);

          reject(
            new Error(
              "Das Foto konnte nicht geöffnet werden."
            )
          );
        };

        image.src = url;
      }
    );
  }


  /*
   * =========================================================
   * QUERFORMAT UND BILDGRÖSSE
   * =========================================================
   */

  function isLandscape(input) {
    const canvas =
      extractCanvas(input);

    if (!canvas) {
      return false;
    }

    return (
      Number(canvas.width) >=
      Number(canvas.height)
    );
  }


  function normalizeLandscapeCanvas(
    input
  ) {
    const sourceCanvas =
      extractCanvas(input);

    if (!sourceCanvas) {
      throw new Error(
        "Kein gültiger Bildbereich vorhanden."
      );
    }

    const originalWidth =
      Number(
        sourceCanvas.width
      );

    const originalHeight =
      Number(
        sourceCanvas.height
      );

    if (
      SETTINGS.requireLandscape &&
      originalHeight > originalWidth
    ) {
      throw new Error(
        "Bitte das Handy quer halten und das Etikett erneut fotografieren."
      );
    }

    const scale =
      Math.min(
        1,

        SETTINGS.maximumWidth /
        originalWidth,

        SETTINGS.maximumHeight /
        originalHeight
      );

    const width =
      Math.max(
        1,
        Math.round(
          originalWidth * scale
        )
      );

    const height =
      Math.max(
        1,
        Math.round(
          originalHeight * scale
        )
      );

    const canvas =
      document.createElement(
        "canvas"
      );

    canvas.width = width;
    canvas.height = height;

    const context =
      canvas.getContext(
        "2d",
        {
          willReadFrequently: true
        }
      );

    if (!context) {
      throw new Error(
        "Das Foto konnte nicht skaliert werden."
      );
    }

    context.imageSmoothingEnabled =
      true;

    context.imageSmoothingQuality =
      "high";

    context.drawImage(
      sourceCanvas,

      0,
      0,
      originalWidth,
      originalHeight,

      0,
      0,
      width,
      height
    );

    return canvas;
  }


  /*
   * =========================================================
   * DATEI-PRÜFSUMME
   * =========================================================
   */

  async function calculateFileDigest(
    file
  ) {
    if (!file) {
      return null;
    }

    if (
      window.crypto &&
      window.crypto.subtle &&
      typeof file.arrayBuffer ===
        "function"
    ) {
      const buffer =
        await file.arrayBuffer();

      const digest =
        await window.crypto.subtle.digest(
          "SHA-256",
          buffer
        );

      return Array.from(
        new Uint8Array(digest)
      )
        .map(byte =>
          byte
            .toString(16)
            .padStart(2, "0")
        )
        .join("");
    }

    return [
      file.name || "",
      file.size || "",
      file.lastModified || "",
      file.type || ""
    ].join("|");
  }


  /*
   * =========================================================
   * SCHNELLE OCR-DURCHLÄUFE
   * =========================================================
   *
   * Es werden nur drei Durchläufe verwendet:
   *
   * 1. Gesamtbild
   * 2. linke 62 Prozent
   * 3. rechte 62 Prozent
   *
   * Dadurch wird das gesamte Etikett abgedeckt,
   * ohne viele überlappende Bereiche zu prüfen.
   */

  function createRecognitionPasses(
    inputCanvas
  ) {
    const sourceCanvas =
      normalizeLandscapeCanvas(
        inputCanvas
      );

    const width =
      sourceCanvas.width;

    const height =
      sourceCanvas.height;

    return [
      {
        name:
          "Gesamtbild",

        canvas:
          createFastOcrCrop(
            sourceCanvas,
            {
              x: 0,
              y: 0,
              width,
              height
            },
            1400
          )
      },

      {
        name:
          "Linker Bereich",

        canvas:
          createFastOcrCrop(
            sourceCanvas,
            {
              x: 0,
              y: 0,
              width:
                width * 0.62,
              height
            },
            1100
          )
      },

      {
        name:
          "Rechter Bereich",

        canvas:
          createFastOcrCrop(
            sourceCanvas,
            {
              x:
                width * 0.38,
              y: 0,
              width:
                width * 0.62,
              height
            },
            1100
          )
      }
    ];
  }


  function createFastOcrCrop(
    sourceCanvas,
    region,
    maximumWidth
  ) {
    const scale =
      Math.min(
        1,

        maximumWidth /
        region.width
      );

    const width =
      Math.max(
        1,
        Math.round(
          region.width * scale
        )
      );

    const height =
      Math.max(
        1,
        Math.round(
          region.height * scale
        )
      );

    const canvas =
      document.createElement(
        "canvas"
      );

    canvas.width = width;
    canvas.height = height;

    const context =
      canvas.getContext(
        "2d",
        {
          willReadFrequently: true
        }
      );

    context.imageSmoothingEnabled =
      true;

    context.imageSmoothingQuality =
      "high";

    context.drawImage(
      sourceCanvas,

      region.x,
      region.y,
      region.width,
      region.height,

      0,
      0,
      width,
      height
    );

    /*
     * Leichte Graustufen- und Kontrastanpassung.
     * Keine harte Schwarz-Weiß-Umwandlung.
     */
    const imageData =
      context.getImageData(
        0,
        0,
        width,
        height
      );

    const data =
      imageData.data;

    for (
      let index = 0;
      index < data.length;
      index += 4
    ) {
      let gray =
        data[index] * 0.299 +
        data[index + 1] * 0.587 +
        data[index + 2] * 0.114;

      gray =
        (
          gray - 128
        ) * 1.15 + 128;

      gray =
        Math.max(
          0,
          Math.min(
            255,
            gray
          )
        );

      data[index] = gray;
      data[index + 1] = gray;
      data[index + 2] = gray;
    }

    context.putImageData(
      imageData,
      0,
      0
    );

    return canvas;
  }


  /*
   * =========================================================
   * SCHNELLE BILDSIGNATUR
   * =========================================================
   */

  function createVisualSignature(
    input
  ) {
    const canvas =
      extractCanvas(input);

    if (!canvas) {
      return null;
    }

    const width =
      Number(canvas.width);

    const height =
      Number(canvas.height);

    const regions = [
      {
        name: "full",
        weight: 0.62,

        x: 0,
        y: 0,
        width,
        height
      },

      {
        name: "center",
        weight: 0.38,

        x:
          width * 0.08,

        y:
          height * 0.08,

        width:
          width * 0.84,

        height:
          height * 0.84
      }
    ];

    return regions.map(
      region => ({
        name:
          region.name,

        weight:
          region.weight,

        fingerprint:
          createRegionFingerprint(
            canvas,
            region
          )
      })
    );
  }


  function createRegionFingerprint(
    canvas,
    region
  ) {
    /*
     * Sehr kleine Vergleichsauflösung.
     * Das hält die Prüfung schnell.
     */
    const width = 48;
    const height = 27;

    const sample =
      document.createElement(
        "canvas"
      );

    sample.width = width;
    sample.height = height;

    const context =
      sample.getContext(
        "2d",
        {
          willReadFrequently: true
        }
      );

    context.drawImage(
      canvas,

      region.x,
      region.y,
      region.width,
      region.height,

      0,
      0,
      width,
      height
    );

    const pixels =
      context.getImageData(
        0,
        0,
        width,
        height
      ).data;

    const gray = [];

    for (
      let index = 0;
      index < pixels.length;
      index += 4
    ) {
      gray.push(
        pixels[index] * 0.299 +
        pixels[index + 1] * 0.587 +
        pixels[index + 2] * 0.114
      );
    }

    const low =
      percentileValue(
        gray,
        5
      );

    const high =
      Math.max(
        low + 20,

        percentileValue(
          gray,
          95
        )
      );

    const normalized =
      gray.map(value =>
        Math.max(
          0,

          Math.min(
            1,

            (
              value - low
            ) /
            (
              high - low
            )
          )
        )
      );

    const median =
      percentileValue(
        normalized,
        50
      );

    const averageHash =
      normalized
        .map(value =>
          value >= median
            ? "1"
            : "0"
        )
        .join("");

    let differenceHash = "";

    for (
      let y = 0;
      y < height;
      y += 1
    ) {
      for (
        let x = 0;
        x < width - 1;
        x += 1
      ) {
        const left =
          normalized[
            y * width + x
          ];

        const right =
          normalized[
            y * width + x + 1
          ];

        differenceHash +=
          left > right
            ? "1"
            : "0";
      }
    }

    const histogram =
      new Array(12).fill(0);

    for (
      const value
      of normalized
    ) {
      const bin =
        Math.min(
          11,

          Math.floor(
            value * 12
          )
        );

      histogram[bin] += 1;
    }

    return {
      width,
      height,
      normalized,
      averageHash,
      differenceHash,

      histogram:
        histogram.map(value =>
          value /
          normalized.length
        )
    };
  }


  function compareVisualSignatures(
    firstInput,
    secondInput
  ) {
    const first =
      extractVisualSignature(
        firstInput
      );

    const second =
      extractVisualSignature(
        secondInput
      );

    if (
      !Array.isArray(first) ||
      !Array.isArray(second) ||
      first.length !== second.length
    ) {
      return 0;
    }

    let score = 0;
    let totalWeight = 0;

    for (
      let index = 0;
      index < first.length;
      index += 1
    ) {
      const weight =
        Number(
          first[index]?.weight || 0
        );

      const similarity =
        compareRegionFingerprints(
          first[index]?.fingerprint,
          second[index]?.fingerprint
        );

      score +=
        similarity * weight;

      totalWeight +=
        weight;
    }

    return score /
      Math.max(
        0.0001,
        totalWeight
      );
  }


  function extractVisualSignature(
    input
  ) {
    if (
      Array.isArray(input)
    ) {
      return input;
    }

    if (
      input &&
      typeof input === "object"
    ) {
      return (
        input.visualSignature ||
        input.imageSignature ||
        input.photoSignature ||
        input.fingerprint ||
        null
      );
    }

    return null;
  }


  function compareRegionFingerprints(
    first,
    second
  ) {
    if (
      !first ||
      !second
    ) {
      return 0;
    }

    const pixelSimilarity =
      bestShiftedPixelSimilarity(
        first.normalized,
        second.normalized,
        first.width,
        first.height
      );

    const averageSimilarity =
      hashSimilarity(
        first.averageHash,
        second.averageHash
      );

    const differenceSimilarity =
      hashSimilarity(
        first.differenceHash,
        second.differenceHash
      );

    const histogramSimilarity =
      histogramIntersection(
        first.histogram,
        second.histogram
      );

    return (
      pixelSimilarity * 0.48 +
      averageSimilarity * 0.18 +
      differenceSimilarity * 0.24 +
      histogramSimilarity * 0.10
    );
  }


  function bestShiftedPixelSimilarity(
    first,
    second,
    width,
    height
  ) {
    if (
      !Array.isArray(first) ||
      !Array.isArray(second) ||
      first.length !==
        width * height ||
      second.length !==
        width * height
    ) {
      return 0;
    }

    let best = 0;

    /*
     * Nur Verschiebungen von einem Pixel prüfen.
     */
    for (
      let shiftY = -1;
      shiftY <= 1;
      shiftY += 1
    ) {
      for (
        let shiftX = -1;
        shiftX <= 1;
        shiftX += 1
      ) {
        let difference = 0;
        let count = 0;

        for (
          let y = 0;
          y < height;
          y += 1
        ) {
          const otherY =
            y + shiftY;

          if (
            otherY < 0 ||
            otherY >= height
          ) {
            continue;
          }

          for (
            let x = 0;
            x < width;
            x += 1
          ) {
            const otherX =
              x + shiftX;

            if (
              otherX < 0 ||
              otherX >= width
            ) {
              continue;
            }

            difference +=
              Math.abs(
                first[
                  y * width + x
                ] -
                second[
                  otherY * width +
                  otherX
                ]
              );

            count += 1;
          }
        }

        if (count) {
          best =
            Math.max(
              best,

              1 -
              difference /
              count
            );
        }
      }
    }

    return Math.max(
      0,
      Math.min(
        1,
        best
      )
    );
  }


  function hashSimilarity(
    first,
    second
  ) {
    if (
      !first ||
      !second ||
      first.length !== second.length
    ) {
      return 0;
    }

    let equal = 0;

    for (
      let index = 0;
      index < first.length;
      index += 1
    ) {
      if (
        first[index] ===
        second[index]
      ) {
        equal += 1;
      }
    }

    return equal /
      first.length;
  }


  function histogramIntersection(
    first,
    second
  ) {
    if (
      !Array.isArray(first) ||
      !Array.isArray(second) ||
      first.length !== second.length
    ) {
      return 0;
    }

    let intersection = 0;

    for (
      let index = 0;
      index < first.length;
      index += 1
    ) {
      intersection +=
        Math.min(
          first[index],
          second[index]
        );
    }

    return Math.max(
      0,
      Math.min(
        1,
        intersection
      )
    );
  }


  /*
   * =========================================================
   * OCR-TEXTSIGNATUR
   * =========================================================
   */

  function createIdentitySignature(
    value
  ) {
    const rawTokens =
      normalizeTextInput(value)
        .toUpperCase()
        .replace(/\r/g, " ")
        .split(/\s+/)
        .map(token =>
          token.replace(
            /^[^A-Z0-9]+|[^A-Z0-9]+$/g,
            ""
          )
        )
        .filter(Boolean);

    const tokens = [
      ...new Set(
        rawTokens
          /*
           * Die D-Nummer ist kein Beweis
           * für einen Doppel-Scan.
           */
          .filter(token =>
            !/^D[0-9]+$/.test(token)
          )
          .filter(token =>
            token.length >= 3 ||
            /^[0-9]{4,}$/.test(token)
          )
      )
    ];

    const strongTokens =
      tokens.filter(token => {
        if (
          GENERIC_WORDS.has(token)
        ) {
          return false;
        }

        return (
          /^[0-9]{5,}$/.test(token) ||
          (
            token.length >= 5 &&
            /[A-Z]/.test(token) &&
            /[0-9]/.test(token)
          )
        );
      });

    return {
      tokens,
      strongTokens,

      tokenCount:
        tokens.length
    };
  }


  function compareIdentitySignatures(
    firstInput,
    secondInput
  ) {
    const first =
      extractIdentitySignature(
        firstInput
      );

    const second =
      extractIdentitySignature(
        secondInput
      );

    const firstTokens =
      new Set(
        first.tokens || []
      );

    const secondTokens =
      new Set(
        second.tokens || []
      );

    if (
      firstTokens.size < 3 ||
      secondTokens.size < 3
    ) {
      return {
        available: false,
        similarity: 0,
        commonStrong: 0,
        commonTokens: []
      };
    }

    const union =
      new Set([
        ...firstTokens,
        ...secondTokens
      ]);

    let unionWeight = 0;
    let commonWeight = 0;

    const commonTokens = [];

    for (
      const token
      of union
    ) {
      const weight =
        getTokenWeight(token);

      unionWeight +=
        weight;

      if (
        firstTokens.has(token) &&
        secondTokens.has(token)
      ) {
        commonWeight +=
          weight;

        commonTokens.push(
          token
        );
      }
    }

    const secondStrong =
      new Set(
        second.strongTokens || []
      );

    const commonStrong =
      (
        first.strongTokens || []
      )
        .filter(token =>
          secondStrong.has(token)
        )
        .length;

    return {
      available: true,

      similarity:
        commonWeight /
        Math.max(
          1,
          unionWeight
        ),

      commonStrong,
      commonTokens
    };
  }


  function extractIdentitySignature(
    input
  ) {
    if (
      input &&
      Array.isArray(input.tokens)
    ) {
      return input;
    }

    if (
      input &&
      typeof input === "object"
    ) {
      if (
        input.identitySignature
      ) {
        return input.identitySignature;
      }

      if (
        input.textSignature
      ) {
        return input.textSignature;
      }
    }

    return createIdentitySignature(
      input || ""
    );
  }


  function getTokenWeight(
    token
  ) {
    if (
      GENERIC_WORDS.has(token)
    ) {
      return 0.2;
    }

    if (
      /^[0-9]{5,}$/.test(token)
    ) {
      return 4;
    }

    if (
      token.length >= 5 &&
      /[A-Z]/.test(token) &&
      /[0-9]/.test(token)
    ) {
      return 3;
    }

    if (
      token.length >= 7
    ) {
      return 1.5;
    }

    return 1;
  }


  /*
   * =========================================================
   * SCAN VORBEREITEN
   * =========================================================
   */

  async function prepareScan(
    ...argumentsList
  ) {
    const options =
      parsePrepareArguments(
        argumentsList
      );

    let sourceCanvas =
      options.canvas;

    if (
      !sourceCanvas &&
      options.file
    ) {
      sourceCanvas =
        await createCanvasFromFile(
          options.file
        );
    }

    if (!sourceCanvas) {
      throw new Error(
        "Für prepareScan wurde kein Foto übergeben."
      );
    }

    /*
     * Hochformat wird hier sofort abgelehnt.
     */
    const preparedCanvas =
      normalizeLandscapeCanvas(
        sourceCanvas
      );

    const fileDigest =
      options.fileDigest ||
      (
        options.file
          ? await calculateFileDigest(
              options.file
            )
          : null
      );

    const visualSignature =
      options.visualSignature ||
      createVisualSignature(
        preparedCanvas
      );

    const identitySignature =
      options.identitySignature ||
      createIdentitySignature(
        options.identityText
      );

    return {
      version:
        VERSION,

      orientation:
        "landscape",

      orientationValid:
        true,

      file:
        options.file || null,

      canvas:
        preparedCanvas,

      sourceCanvas:
        preparedCanvas,

      preparedCanvas,

      ocrCanvas:
        preparedCanvas,

      fileDigest,

      digest:
        fileDigest,

      sha256:
        fileDigest,

      fileHash:
        fileDigest,

      visualSignature,

      imageSignature:
        visualSignature,

      photoSignature:
        visualSignature,

      fingerprint:
        visualSignature,

      identityText:
        options.identityText,

      identitySignature,

      textSignature:
        identitySignature,

      preparedAt:
        Date.now()
    };
  }


  function parsePrepareArguments(
    argumentsList
  ) {
    const options = {
      file: null,
      canvas: null,
      identityText: "",
      identitySignature: null,
      visualSignature: null,
      fileDigest: null
    };

    for (
      const argument
      of argumentsList
    ) {
      if (
        argument == null
      ) {
        continue;
      }

      if (
        isBlobLike(argument)
      ) {
        options.file =
          argument;

        continue;
      }

      if (
        isCanvasLike(argument)
      ) {
        options.canvas =
          argument;

        continue;
      }

      if (
        typeof argument ===
        "string"
      ) {
        options.identityText =
          argument;

        continue;
      }

      if (
        typeof argument !==
        "object"
      ) {
        continue;
      }

      if (
        isBlobLike(
          argument.file
        )
      ) {
        options.file =
          argument.file;
      }

      const canvas =
        extractCanvas(argument);

      if (canvas) {
        options.canvas =
          canvas;
      }

      options.identityText =
        argument.identityText ||
        argument.ocrText ||
        argument.text ||
        options.identityText;

      options.identitySignature =
        argument.identitySignature ||
        argument.textSignature ||
        options.identitySignature;

      options.visualSignature =
        argument.visualSignature ||
        argument.imageSignature ||
        argument.photoSignature ||
        argument.fingerprint ||
        options.visualSignature;

      options.fileDigest =
        argument.fileDigest ||
        argument.digest ||
        argument.sha256 ||
        argument.fileHash ||
        options.fileDigest;
    }

    return options;
  }


  function addIdentityToScan(
    scan,
    identityText
  ) {
    const identitySignature =
      createIdentitySignature(
        identityText
      );

    return {
      ...scan,

      identityText,

      identitySignature,

      textSignature:
        identitySignature
    };
  }


  /*
   * =========================================================
   * SCHNELLE VORPRÜFUNG
   * =========================================================
   *
   * Diese Funktion behebt:
   *
   * window.DuplicateFix.precheck is not a function
   */

  function precheck(
    firstOrOptions,
    secondArgument
  ) {
    const {
      firstScan,
      secondScan
    } =
      parseScanPair(
        firstOrOptions,
        secondArgument
      );

    if (
      !firstScan ||
      !secondScan
    ) {
      return createDecision(
        false,
        {
          stage:
            "precheck",

          reason:
            "Für die Vorprüfung fehlen Scan-Daten.",

          exactFileMatch:
            false,

          visualSimilarity:
            0
        }
      );
    }

    const firstDigest =
      extractDigest(
        firstScan
      );

    const secondDigest =
      extractDigest(
        secondScan
      );

    const exactFileMatch =
      Boolean(
        firstDigest &&
        secondDigest &&
        firstDigest ===
          secondDigest
      );

    if (exactFileMatch) {
      return createDecision(
        true,
        {
          stage:
            "precheck",

          reason:
            "Es wurde exakt dieselbe Bilddatei verwendet.",

          exactFileMatch:
            true,

          visualSimilarity:
            1
        }
      );
    }

    const visualSimilarity =
      compareVisualSignatures(
        firstScan,
        secondScan
      );

    const duplicate =
      visualSimilarity >=
      SETTINGS.visualOnlyDuplicate;

    return createDecision(
      duplicate,
      {
        stage:
          "precheck",

        reason:
          duplicate
            ? "Das zweite Foto ist nahezu identisch mit dem ersten Foto."
            : "Die schnelle Vorprüfung hat keinen sicheren Doppel-Scan erkannt.",

        exactFileMatch:
          false,

        visualSimilarity
      }
    );
  }


  /*
   * =========================================================
   * ABSCHLUSSPRÜFUNG NACH DER OCR
   * =========================================================
   */

  function finalCheck(
    firstOrOptions,
    secondArgument
  ) {
    const {
      firstScan,
      secondScan
    } =
      parseScanPair(
        firstOrOptions,
        secondArgument
      );

    if (
      !firstScan ||
      !secondScan
    ) {
      return createDecision(
        false,
        {
          stage:
            "final",

          reason:
            "Für die Abschlussprüfung fehlen Scan-Daten.",

          exactFileMatch:
            false,

          visualSimilarity:
            0,

          textSimilarity:
            0,

          commonStrong:
            0
        }
      );
    }

    const quickDecision =
      precheck(
        firstScan,
        secondScan
      );

    if (
      quickDecision.duplicate
    ) {
      return {
        ...quickDecision,
        stage: "final"
      };
    }

    const visualSimilarity =
      quickDecision
        .visualSimilarity;

    const identityComparison =
      compareIdentitySignatures(
        firstScan,
        secondScan
      );

    const textSimilarity =
      Number(
        identityComparison
          .similarity || 0
      );

    const commonStrong =
      Number(
        identityComparison
          .commonStrong || 0
      );

    let duplicate = false;

    let reason =
      "Die Aufnahmen unterscheiden sich ausreichend.";

    if (
      identityComparison.available &&
      commonStrong >=
        SETTINGS
          .requiredStrongIdentifiers &&
      textSimilarity >=
        SETTINGS
          .strongTextSimilarity &&
      visualSimilarity >=
        SETTINGS
          .visualWithStrongText
    ) {
      duplicate = true;

      reason =
        "Mehrere eindeutige Kennungen sowie die Bildstruktur stimmen überein.";
    } else if (
      identityComparison.available &&
      commonStrong >=
        SETTINGS
          .requiredMediumIdentifiers &&
      textSimilarity >=
        SETTINGS
          .mediumTextSimilarity &&
      visualSimilarity >=
        SETTINGS
          .visualWithMediumText
    ) {
      duplicate = true;

      reason =
        "Etikettentext und Bildstruktur entsprechen sehr wahrscheinlich demselben Etikett.";
    }

    return createDecision(
      duplicate,
      {
        stage:
          "final",

        reason,

        exactFileMatch:
          quickDecision
            .exactFileMatch,

        visualSimilarity,

        textSimilarity,

        commonStrong,

        identityComparison
      }
    );
  }


  function compareScans(
    firstScan,
    secondScan
  ) {
    return finalCheck(
      firstScan,
      secondScan
    );
  }


  function checkDuplicate(
    firstOrOptions,
    secondArgument
  ) {
    return finalCheck(
      firstOrOptions,
      secondArgument
    );
  }


  function evaluateDuplicate(
    firstOrOptions,
    secondArgument
  ) {
    return finalCheck(
      firstOrOptions,
      secondArgument
    );
  }


  function parseScanPair(
    firstOrOptions,
    secondArgument
  ) {
    if (secondArgument) {
      return {
        firstScan:
          firstOrOptions,

        secondScan:
          secondArgument
      };
    }

    const options =
      firstOrOptions || {};

    return {
      firstScan:
        options.firstScan ||
        options.first ||
        options.scan1 ||
        options.referenceScan ||
        null,

      secondScan:
        options.secondScan ||
        options.second ||
        options.scan2 ||
        options.currentScan ||
        options.candidateScan ||
        null
    };
  }


  function extractDigest(
    scan
  ) {
    if (!scan) {
      return null;
    }

    if (
      typeof scan ===
      "string"
    ) {
      return scan;
    }

    return (
      scan.fileDigest ||
      scan.digest ||
      scan.sha256 ||
      scan.fileHash ||
      null
    );
  }


  function createDecision(
    duplicate,
    details
  ) {
    return {
      duplicate,

      isDuplicate:
        duplicate,

      blocked:
        duplicate,

      allow:
        !duplicate,

      ...details
    };
  }


  function percentileValue(
    values,
    percentile
  ) {
    if (
      !Array.isArray(values) ||
      !values.length
    ) {
      return 0;
    }

    const sorted =
      [...values]
        .sort(
          (
            first,
            second
          ) =>
            first - second
        );

    const position =
      percentile /
      100 *
      (
        sorted.length - 1
      );

    const lower =
      Math.floor(position);

    const upper =
      Math.ceil(position);

    if (
      lower === upper
    ) {
      return sorted[lower];
    }

    const fraction =
      position - lower;

    return (
      sorted[lower] *
        (
          1 - fraction
        ) +
      sorted[upper] *
        fraction
    );
  }


  function formatPercent(
    value
  ) {
    if (
      value == null ||
      !Number.isFinite(value)
    ) {
      return "—";
    }

    return `${
      Math.round(
        value * 100
      )
    } %`;
  }


  /*
   * =========================================================
   * TEXTHINWEIS AUF QUERFORMAT ÄNDERN
   * =========================================================
   */

  function updateLandscapeInstructions() {
    if (!document.body) {
      return;
    }

    const walker =
      document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT
      );

    const textNodes = [];

    while (
      walker.nextNode()
    ) {
      textNodes.push(
        walker.currentNode
      );
    }

    for (
      const node
      of textNodes
    ) {
      const value =
        node.nodeValue || "";

      if (
        value.includes(
          "Du kannst das Handy beim Fotografieren quer halten."
        )
      ) {
        node.nodeValue =
          value.replace(
            "Du kannst das Handy beim Fotografieren quer halten.",
            "Halte das Handy beim Fotografieren immer quer."
          );
      }

      if (
        value.includes(
          "Hoch- und Querformat werden unterstützt."
        )
      ) {
        node.nodeValue =
          value.replace(
            "Hoch- und Querformat werden unterstützt.",
            "Es werden ausschließlich Querformatfotos unterstützt."
          );
      }
    }
  }


  /*
   * =========================================================
   * SCHNELLEN OCR-MODUS INSTALLIEREN
   * =========================================================
   *
   * Falls die index.html eine globale Funktion
   * createRecognitionPasses verwendet, wird sie
   * durch die schnelle Drei-Durchlauf-Version ersetzt.
   */

  function installFastRecognitionMode() {
    try {
      window.createRecognitionPasses =
        createRecognitionPasses;
    } catch (error) {
      console.warn(
        "Der schnelle OCR-Modus konnte nicht installiert werden.",
        error
      );
    }
  }


  /*
   * =========================================================
   * ÖFFENTLICHE SCHNITTSTELLE
   * =========================================================
   */

  window.DuplicateFix =
    Object.freeze({
      version:
        VERSION,

      settings:
        SETTINGS,

      limits:
        SETTINGS,

      codeOcrParameters:
        CODE_OCR_PARAMETERS,

      getCodeOcrParameters,

      configureCodeWorker,

      configureCodeRecognition:
        configureCodeWorker,

      extractStrictDCodes,

      extractDCodes:
        extractStrictDCodes,

      findDCodes:
        extractStrictDCodes,

      normalizeManualCode,

      isValidCode,

      isLandscape,

      normalizeLandscapeCanvas,

      ensureLandscape:
        normalizeLandscapeCanvas,

      createCanvasFromFile,

      calculateFileDigest,

      calculateDigest:
        calculateFileDigest,

      createRecognitionPasses,

      getRecognitionPasses:
        createRecognitionPasses,

      createFastRecognitionPasses:
        createRecognitionPasses,

      createVisualSignature,

      createImageSignature:
        createVisualSignature,

      createPhotoSignature:
        createVisualSignature,

      createFingerprint:
        createVisualSignature,

      compareVisualSignatures,

      compareImageSignatures:
        compareVisualSignatures,

      comparePhotoSignatures:
        compareVisualSignatures,

      compareFingerprints:
        compareVisualSignatures,

      createIdentitySignature,

      createTextSignature:
        createIdentitySignature,

      compareIdentitySignatures,

      compareTextSignatures:
        compareIdentitySignatures,

      prepareScan,

      prepareImage:
        prepareScan,

      createPreparedScan:
        prepareScan,

      createScanSignature:
        prepareScan,

      addIdentityToScan,

      attachIdentity:
        addIdentityToScan,

      updateScanIdentity:
        addIdentityToScan,

      precheck,

      preCheck:
        precheck,

      quickCheck:
        precheck,

      preliminaryCheck:
        precheck,

      finalCheck,

      postcheck:
        finalCheck,

      postCheck:
        finalCheck,

      compareScans,

      comparePreparedScans:
        compareScans,

      checkDuplicate,

      isDuplicateScan:
        checkDuplicate,

      evaluateDuplicate,

      assessDuplicate:
        evaluateDuplicate,

      formatPercent
    });


  installFastRecognitionMode();


  if (
    document.readyState ===
    "loading"
  ) {
    document.addEventListener(
      "DOMContentLoaded",
      updateLandscapeInstructions,
      {
        once: true
      }
    );
  } else {
    updateLandscapeInstructions();
  }


  console.info(
    `DuplicateFix ${VERSION} geladen`
  );
})();
