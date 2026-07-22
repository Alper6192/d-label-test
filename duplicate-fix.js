"use strict";

(() => {
  const VERSION = "12.0";

  /*
   * Grenzwerte für die Doppel-Scan-Erkennung.
   *
   * Unterschiedliche Etiketten mit ähnlichem Aufbau
   * sollen nicht vorschnell blockiert werden.
   */
  const LIMITS = Object.freeze({
    visualOnly: 0.99,

    strongTextSimilarity: 0.93,
    visualWithStrongText: 0.74,

    mediumTextSimilarity: 0.82,
    visualWithMediumText: 0.90,

    requiredCommonIdentifiers: 3,
    visualWithIdentifiers: 0.78
  });


  /*
   * Alle Buchstaben müssen für die OCR erlaubt sein.
   *
   * Würde nur D erlaubt, könnte Tesseract ein A
   * fälschlicherweise als D ausgeben.
   */
  const CODE_OCR_PARAMETERS = Object.freeze({
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",

    tessedit_pageseg_mode: "11",

    preserve_interword_spaces: "1",

    user_defined_dpi: "300"
  });


  const GENERIC_WORDS = new Set([
    "BATCH",
    "BATCHNO",
    "CHARGE",
    "CHARGENNUMMER",
    "LOT",
    "LOTNO",
    "NUMBER",
    "NUMMER",
    "PRODUCT",
    "PRODUKT",
    "WEIGHT",
    "GEWICHT",
    "GROSS",
    "NET",
    "DATE",
    "DATUM",
    "DELIVERY",
    "NOTE",
    "LIEFERSCHEIN",
    "MADE",
    "MATERIAL",
    "LABEL",
    "ETIKETT",
    "QUANTITY",
    "MENGE",
    "HENKEL",
    "PACKING",
    "DELIVERYNOTE",
    "KG",
    "AG",
    "CO"
  ]);


  /*
   * =========================================================
   * ALLGEMEINE EINGABEN AUSWERTEN
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
    if (!value) {
      return false;
    }


    if (
      typeof HTMLCanvasElement !==
        "undefined" &&
      value instanceof HTMLCanvasElement
    ) {
      return true;
    }


    if (
      typeof OffscreenCanvas !==
        "undefined" &&
      value instanceof OffscreenCanvas
    ) {
      return true;
    }


    return (
      typeof value.getContext ===
        "function" &&
      Number(value.width) > 0 &&
      Number(value.height) > 0
    );
  }


  /*
   * =========================================================
   * D-NUMMERN-ERKENNUNG
   * =========================================================
   *
   * Regel:
   *
   * D muss direkt von mindestens einer Ziffer gefolgt werden.
   * Die D-Nummer endet beim nächsten Leerzeichen,
   * Tab oder Zeilenumbruch.
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
    const text =
      normalizeTextInput(value)
        .toUpperCase()
        .replace(/\r/g, "");


    /*
     * Der Text wird ausschließlich an echten
     * Leerzeichen, Tabs und Zeilenumbrüchen getrennt.
     *
     * Verschiedene Textblöcke werden niemals verbunden.
     */
    const tokens =
      text
        .split(/\s+/)
        .filter(Boolean);


    const results =
      new Set();


    for (const rawToken of tokens) {
      /*
       * Nur Satzzeichen am Anfang und Ende entfernen.
       *
       * Innerhalb des Tokens werden keine Zeichen entfernt.
       * D123-456 bleibt deshalb ungültig.
       */
      const token =
        rawToken.replace(
          /^[,;:()[\]{}"'!?]+|[,;:()[\]{}"'!?]+$/g,
          ""
        );


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
     * Fehler werden nicht automatisch korrigiert.
     *
     * D 123 bleibt D 123 und wird anschließend
     * als ungültig bewertet.
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


  async function configureCodeWorker(worker) {
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
   * DATEI-PRÜFSUMME
   * =========================================================
   */

  async function calculateFileDigest(file) {
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


    /*
     * Fallback für ältere Browser.
     */
    return [
      file.name || "",
      file.size || "",
      file.lastModified || "",
      file.type || ""
    ].join("|");
  }


  /*
   * =========================================================
   * DATEI IN CANVAS LADEN
   * =========================================================
   */

  async function createCanvasFromFile(
    file,
    maximumSide = 2600
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


    const originalWidth =
      Number(
        image.width ||
        image.naturalWidth
      );


    const originalHeight =
      Number(
        image.height ||
        image.naturalHeight
      );


    if (
      !originalWidth ||
      !originalHeight
    ) {
      throw new Error(
        "Die Bildgröße konnte nicht ermittelt werden."
      );
    }


    const scale =
      Math.min(
        1,

        maximumSide /
        Math.max(
          originalWidth,
          originalHeight
        )
      );


    const canvas =
      document.createElement(
        "canvas"
      );


    canvas.width =
      Math.max(
        1,
        Math.round(
          originalWidth * scale
        )
      );


    canvas.height =
      Math.max(
        1,
        Math.round(
          originalHeight * scale
        )
      );


    const context =
      canvas.getContext(
        "2d",
        {
          willReadFrequently: true
        }
      );


    if (!context) {
      throw new Error(
        "Der Bildbereich konnte nicht erstellt werden."
      );
    }


    context.drawImage(
      image,
      0,
      0,
      canvas.width,
      canvas.height
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
   * OCR-TEXTSIGNATUR
   * =========================================================
   */

  function createIdentitySignature(value) {
    const text =
      normalizeTextInput(value)
        .toUpperCase()
        .replace(/\r/g, " ");


    const rawTokens =
      text
        .split(/\s+/)
        .map(token =>
          token.replace(
            /^[^A-Z0-9]+|[^A-Z0-9]+$/g,
            ""
          )
        )
        .filter(Boolean);


    /*
     * D-Nummern werden beim Doppel-Scan-Vergleich
     * nicht berücksichtigt.
     *
     * Zwei zusammengehörende Etiketten sollen gerade
     * dieselbe D-Nummer besitzen.
     */
    const tokens =
      [
        ...new Set(
          rawTokens
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
    first,
    second
  ) {
    const firstTokens =
      new Set(
        first?.tokens || []
      );


    const secondTokens =
      new Set(
        second?.tokens || []
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


    for (const token of union) {
      const weight =
        getTokenWeight(token);


      unionWeight += weight;


      if (
        firstTokens.has(token) &&
        secondTokens.has(token)
      ) {
        commonWeight += weight;
        commonTokens.push(token);
      }
    }


    const secondStrong =
      new Set(
        second?.strongTokens || []
      );


    const commonStrong =
      (
        first?.strongTokens || []
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


  function getTokenWeight(token) {
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


    if (token.length >= 7) {
      return 1.5;
    }


    return 1;
  }


  /*
   * =========================================================
   * VISUELLE BILDSIGNATUR
   * =========================================================
   */

  function createVisualSignature(input) {
    const sourceCanvas =
      extractCanvas(input);


    if (!sourceCanvas) {
      return null;
    }


    const width =
      Number(sourceCanvas.width);


    const height =
      Number(sourceCanvas.height);


    if (!width || !height) {
      return null;
    }


    const regions = [
      {
        name: "full",
        weight: 0.42,

        x: 0,
        y: 0,
        width,
        height
      },

      {
        name: "center",
        weight: 0.34,

        x: width * 0.08,
        y: height * 0.08,

        width: width * 0.84,
        height: height * 0.84
      },

      {
        name: "top",
        weight: 0.12,

        x: 0,
        y: 0,
        width,

        height:
          height * 0.58
      },

      {
        name: "bottom",
        weight: 0.12,

        x: 0,
        y: height * 0.42,
        width,

        height:
          height * 0.58
      }
    ];


    return regions.map(region => ({
      name:
        region.name,

      weight:
        region.weight,

      fingerprint:
        createRegionFingerprint(
          sourceCanvas,
          region
        )
    }));
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
        input.imageCanvas,
        input.preparedCanvas
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


  function createRegionFingerprint(
    sourceCanvas,
    region
  ) {
    const size = 32;


    const canvas =
      document.createElement(
        "canvas"
      );


    canvas.width = size;
    canvas.height = size;


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
      size,
      size
    );


    const imageData =
      context.getImageData(
        0,
        0,
        size,
        size
      ).data;


    const grayscale = [];


    for (
      let index = 0;
      index < imageData.length;
      index += 4
    ) {
      grayscale.push(
        imageData[index] * 0.299 +
        imageData[index + 1] * 0.587 +
        imageData[index + 2] * 0.114
      );
    }


    const low =
      percentileValue(
        grayscale,
        5
      );


    const high =
      Math.max(
        low + 20,

        percentileValue(
          grayscale,
          95
        )
      );


    const normalizedGray =
      grayscale.map(value =>
        Math.max(
          0,

          Math.min(
            1,

            (value - low) /
            (high - low)
          )
        )
      );


    const median =
      percentileValue(
        normalizedGray,
        50
      );


    const averageHash =
      normalizedGray
        .map(value =>
          value >= median
            ? "1"
            : "0"
        )
        .join("");


    let differenceHash = "";


    for (
      let y = 0;
      y < size;
      y += 1
    ) {
      for (
        let x = 0;
        x < size - 1;
        x += 1
      ) {
        const left =
          normalizedGray[
            y * size + x
          ];


        const right =
          normalizedGray[
            y * size + x + 1
          ];


        differenceHash +=
          left > right
            ? "1"
            : "0";
      }
    }


    const edges =
      new Array(
        size * size
      ).fill(0);


    for (
      let y = 1;
      y < size - 1;
      y += 1
    ) {
      for (
        let x = 1;
        x < size - 1;
        x += 1
      ) {
        const index =
          y * size + x;


        const horizontal =
          normalizedGray[
            index + 1
          ] -
          normalizedGray[
            index - 1
          ];


        const vertical =
          normalizedGray[
            index + size
          ] -
          normalizedGray[
            index - size
          ];


        edges[index] =
          Math.hypot(
            horizontal,
            vertical
          );
      }
    }


    const edgeThreshold =
      percentileValue(
        edges,
        68
      );


    const edgeHash =
      edges
        .map(value =>
          value >= edgeThreshold
            ? "1"
            : "0"
        )
        .join("");


    const histogram =
      new Array(16).fill(0);


    for (
      const value
      of normalizedGray
    ) {
      const bin =
        Math.min(
          15,

          Math.floor(
            value * 16
          )
        );


      histogram[bin] += 1;
    }


    return {
      size,

      grayscale:
        normalizedGray,

      averageHash,
      differenceHash,
      edgeHash,

      histogram:
        histogram.map(value =>
          value /
          normalizedGray.length
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


    let weightedScore = 0;
    let totalWeight = 0;


    for (
      let index = 0;
      index < first.length;
      index += 1
    ) {
      const firstRegion =
        first[index];


      const secondRegion =
        second[index];


      const weight =
        Number(
          firstRegion?.weight || 0
        );


      const similarity =
        compareRegionFingerprints(
          firstRegion?.fingerprint,
          secondRegion?.fingerprint
        );


      weightedScore +=
        similarity * weight;


      totalWeight += weight;
    }


    return weightedScore /
      Math.max(
        0.0001,
        totalWeight
      );
  }


  function extractVisualSignature(input) {
    if (Array.isArray(input)) {
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
    if (!first || !second) {
      return 0;
    }


    const grayscaleSimilarity =
      bestShiftedGrayscaleSimilarity(
        first.grayscale,
        second.grayscale,
        first.size,
        2
      );


    const averageHashSimilarity =
      hashSimilarity(
        first.averageHash,
        second.averageHash
      );


    const differenceHashSimilarity =
      hashSimilarity(
        first.differenceHash,
        second.differenceHash
      );


    const edgeHashSimilarity =
      hashSimilarity(
        first.edgeHash,
        second.edgeHash
      );


    const histogramSimilarity =
      histogramIntersection(
        first.histogram,
        second.histogram
      );


    return (
      grayscaleSimilarity * 0.42 +
      averageHashSimilarity * 0.13 +
      differenceHashSimilarity * 0.14 +
      edgeHashSimilarity * 0.21 +
      histogramSimilarity * 0.10
    );
  }


  function bestShiftedGrayscaleSimilarity(
    first,
    second,
    size,
    maximumShift
  ) {
    if (
      !Array.isArray(first) ||
      !Array.isArray(second) ||
      first.length !== size * size ||
      second.length !== size * size
    ) {
      return 0;
    }


    let best = 0;


    for (
      let shiftY = -maximumShift;
      shiftY <= maximumShift;
      shiftY += 1
    ) {
      for (
        let shiftX = -maximumShift;
        shiftX <= maximumShift;
        shiftX += 1
      ) {
        let difference = 0;
        let count = 0;


        for (
          let y = 0;
          y < size;
          y += 1
        ) {
          const otherY =
            y + shiftY;


          if (
            otherY < 0 ||
            otherY >= size
          ) {
            continue;
          }


          for (
            let x = 0;
            x < size;
            x += 1
          ) {
            const otherX =
              x + shiftX;


            if (
              otherX < 0 ||
              otherX >= size
            ) {
              continue;
            }


            difference +=
              Math.abs(
                first[
                  y * size + x
                ] -
                second[
                  otherY * size +
                  otherX
                ]
              );


            count += 1;
          }
        }


        if (!count) {
          continue;
        }


        const similarity =
          Math.max(
            0,

            1 -
            difference /
            count
          );


        best =
          Math.max(
            best,
            similarity
          );
      }
    }


    return best;
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
   * PREPARE SCAN
   * =========================================================
   *
   * Unterstützte Aufrufe:
   *
   * await prepareScan(file, canvas)
   *
   * await prepareScan(canvas, file)
   *
   * await prepareScan({
   *   file,
   *   canvas,
   *   identityText
   * })
   *
   * await prepareScan(canvas)
   */

  async function prepareScan(
    ...argumentsList
  ) {
    const options =
      parsePrepareScanArguments(
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
          options.file,
          options.maximumSide
        );
    }


    if (!sourceCanvas) {
      throw new Error(
        "Für prepareScan wurde kein Bildbereich übergeben."
      );
    }


    const fileDigest =
      options.fileDigest ||
      options.digest ||
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
        sourceCanvas
      );


    const identitySignature =
      options.identitySignature ||
      createIdentitySignature(
        options.identityText ||
        options.ocrText ||
        options.text ||
        ""
      );


    /*
     * Mehrere Eigenschaftsnamen werden angeboten,
     * damit unterschiedliche index.html-Versionen
     * dieselben Daten verwenden können.
     */
    return {
      version:
        VERSION,

      file:
        options.file || null,

      canvas:
        sourceCanvas,

      sourceCanvas,

      preparedCanvas:
        sourceCanvas,


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


      identitySignature,

      textSignature:
        identitySignature,


      identityText:
        options.identityText ||
        options.ocrText ||
        options.text ||
        "",


      preparedAt:
        Date.now()
    };
  }


  function parsePrepareScanArguments(
    argumentsList
  ) {
    const options = {
      file: null,
      canvas: null,
      identityText: "",
      identitySignature: null,
      visualSignature: null,
      fileDigest: null,
      maximumSide: 2600
    };


    for (
      const argument
      of argumentsList
    ) {
      if (argument == null) {
        continue;
      }


      if (
        typeof Blob !==
          "undefined" &&
        argument instanceof Blob
      ) {
        options.file =
          argument;

        continue;
      }


      if (isCanvasLike(argument)) {
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
        typeof argument ===
        "number"
      ) {
        continue;
      }


      if (
        typeof argument ===
        "object"
      ) {
        if (
          argument.file &&
          typeof Blob !==
            "undefined" &&
          argument.file instanceof Blob
        ) {
          options.file =
            argument.file;
        }


        const possibleCanvas =
          extractCanvas(argument);


        if (possibleCanvas) {
          options.canvas =
            possibleCanvas;
        }


        if (
          typeof argument.identityText ===
          "string"
        ) {
          options.identityText =
            argument.identityText;
        } else if (
          typeof argument.ocrText ===
          "string"
        ) {
          options.identityText =
            argument.ocrText;
        } else if (
          typeof argument.text ===
          "string"
        ) {
          options.identityText =
            argument.text;
        }


        if (
          argument.identitySignature
        ) {
          options.identitySignature =
            argument.identitySignature;
        } else if (
          argument.textSignature
        ) {
          options.identitySignature =
            argument.textSignature;
        } else if (
          Array.isArray(
            argument.tokens
          )
        ) {
          options.identitySignature =
            argument;
        }


        if (
          argument.visualSignature
        ) {
          options.visualSignature =
            argument.visualSignature;
        } else if (
          argument.imageSignature
        ) {
          options.visualSignature =
            argument.imageSignature;
        } else if (
          argument.fingerprint
        ) {
          options.visualSignature =
            argument.fingerprint;
        }


        options.fileDigest =
          argument.fileDigest ||
          argument.digest ||
          argument.sha256 ||
          argument.fileHash ||
          options.fileDigest;


        if (
          Number.isFinite(
            argument.maximumSide
          )
        ) {
          options.maximumSide =
            Math.max(
              256,
              Number(
                argument.maximumSide
              )
            );
        }
      }
    }


    return options;
  }


  /*
   * Fügt einem bereits vorbereiteten Scan
   * später OCR-Text hinzu.
   */
  function addIdentityToScan(
    preparedScan,
    identityText
  ) {
    const identitySignature =
      createIdentitySignature(
        identityText
      );


    return {
      ...preparedScan,

      identityText,

      identitySignature,

      textSignature:
        identitySignature
    };
  }


  /*
   * =========================================================
   * DOPPEL-SCAN-ENTSCHEIDUNG
   * =========================================================
   */

  function evaluateDuplicate(
    visualOrOptions,
    identityComparison,
    exactFileMatch = false
  ) {
    let visualSimilarity =
      visualOrOptions;


    let comparison =
      identityComparison;


    let exact =
      exactFileMatch;


    if (
      visualOrOptions &&
      typeof visualOrOptions ===
        "object"
    ) {
      visualSimilarity =
        visualOrOptions.visualSimilarity ??
        visualOrOptions.visual ??
        0;


      comparison =
        visualOrOptions.identityComparison ??
        visualOrOptions.textComparison ??
        identityComparison;


      exact =
        Boolean(
          visualOrOptions.exactFileMatch ??
          visualOrOptions.exactFile ??
          exactFileMatch
        );
    }


    const visual =
      Number(
        visualSimilarity || 0
      );


    const textAvailable =
      Boolean(
        comparison?.available
      );


    const textSimilarity =
      Number(
        comparison?.similarity || 0
      );


    const commonStrong =
      Number(
        comparison?.commonStrong || 0
      );


    if (exact) {
      return {
        duplicate: true,
        isDuplicate: true,

        reason:
          "Es wurde exakt dieselbe Bilddatei verwendet."
      };
    }


    /*
     * Allein aufgrund des Bildes nur bei nahezu
     * vollständiger Übereinstimmung blockieren.
     */
    if (
      visual >=
      LIMITS.visualOnly
    ) {
      return {
        duplicate: true,
        isDuplicate: true,

        reason:
          "Das zweite Foto stimmt visuell nahezu vollständig mit dem ersten Foto überein."
      };
    }


    if (
      textAvailable &&
      commonStrong >=
        LIMITS.requiredCommonIdentifiers &&
      textSimilarity >= 0.78 &&
      visual >=
        LIMITS.visualWithIdentifiers
    ) {
      return {
        duplicate: true,
        isDuplicate: true,

        reason:
          "Mehrere eindeutige Kennungen und die Bildstruktur stimmen überein."
      };
    }


    if (
      textAvailable &&
      textSimilarity >=
        LIMITS.strongTextSimilarity &&
      visual >=
        LIMITS.visualWithStrongText
    ) {
      return {
        duplicate: true,
        isDuplicate: true,

        reason:
          "Etikettentext und Bildstruktur entsprechen sehr wahrscheinlich demselben Etikett."
      };
    }


    if (
      textAvailable &&
      textSimilarity >=
        LIMITS.mediumTextSimilarity &&
      visual >=
        LIMITS.visualWithMediumText
    ) {
      return {
        duplicate: true,
        isDuplicate: true,

        reason:
          "Text und Bildstruktur sind gemeinsam ungewöhnlich ähnlich."
      };
    }


    return {
      duplicate: false,
      isDuplicate: false,

      reason:
        "Die Aufnahmen unterscheiden sich ausreichend."
    };
  }


  function compareScans(
    firstScan,
    secondScan
  ) {
    const firstDigest =
      extractDigest(firstScan);


    const secondDigest =
      extractDigest(secondScan);


    const exactFileMatch =
      Boolean(
        firstDigest &&
        secondDigest &&
        firstDigest === secondDigest
      );


    const visualSimilarity =
      compareVisualSignatures(
        firstScan,
        secondScan
      );


    const firstIdentity =
      extractIdentitySignature(
        firstScan
      );


    const secondIdentity =
      extractIdentitySignature(
        secondScan
      );


    const identityComparison =
      compareIdentitySignatures(
        firstIdentity,
        secondIdentity
      );


    const decision =
      evaluateDuplicate({
        visualSimilarity,
        identityComparison,
        exactFileMatch
      });


    return {
      ...decision,

      exactFileMatch,

      visualSimilarity,

      imageSimilarity:
        visualSimilarity,

      identityComparison,

      textSimilarity:
        identityComparison.similarity,

      commonStrong:
        identityComparison.commonStrong
    };
  }


  function checkDuplicate(
    firstOrOptions,
    secondScan
  ) {
    /*
     * checkDuplicate(ersterScan, zweiterScan)
     */
    if (secondScan) {
      return compareScans(
        firstOrOptions,
        secondScan
      );
    }


    /*
     * checkDuplicate({
     *   firstScan,
     *   secondScan
     * })
     */
    const options =
      firstOrOptions || {};


    if (
      options.firstScan &&
      options.secondScan
    ) {
      return compareScans(
        options.firstScan,
        options.secondScan
      );
    }


    if (
      options.first &&
      options.second
    ) {
      return compareScans(
        options.first,
        options.second
      );
    }


    const exactFileMatch =
      Boolean(
        options.exactFileMatch ||
        options.exactFile ||
        (
          options.firstDigest &&
          options.secondDigest &&
          options.firstDigest ===
            options.secondDigest
        )
      );


    const visualSimilarity =
      Number.isFinite(
        options.visualSimilarity
      )
        ? options.visualSimilarity
        : compareVisualSignatures(
            options.firstVisual ||
            options.firstImageSignature,

            options.secondVisual ||
            options.secondImageSignature
          );


    const identityComparison =
      options.identityComparison ||
      options.textComparison ||
      compareIdentitySignatures(
        options.firstIdentity ||
        options.firstIdentitySignature,

        options.secondIdentity ||
        options.secondIdentitySignature
      );


    const decision =
      evaluateDuplicate({
        visualSimilarity,
        identityComparison,
        exactFileMatch
      });


    return {
      ...decision,

      exactFileMatch,
      visualSimilarity,
      identityComparison,

      textSimilarity:
        identityComparison?.similarity || 0
    };
  }


  function extractDigest(scan) {
    if (!scan) {
      return null;
    }


    if (typeof scan === "string") {
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


  function extractIdentitySignature(
    scan
  ) {
    if (!scan) {
      return {
        tokens: [],
        strongTokens: []
      };
    }


    if (
      Array.isArray(scan.tokens)
    ) {
      return scan;
    }


    return (
      scan.identitySignature ||
      scan.textSignature ||
      createIdentitySignature(
        scan.identityText ||
        scan.ocrText ||
        scan.text ||
        ""
      )
    );
  }


  /*
   * =========================================================
   * HILFSFUNKTIONEN
   * =========================================================
   */

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
          (first, second) =>
            first - second
        );


    const position =
      percentile /
      100 *
      (sorted.length - 1);


    const lowerIndex =
      Math.floor(position);


    const upperIndex =
      Math.ceil(position);


    if (
      lowerIndex === upperIndex
    ) {
      return sorted[
        lowerIndex
      ];
    }


    const fraction =
      position -
      lowerIndex;


    return (
      sorted[lowerIndex] *
        (1 - fraction) +
      sorted[upperIndex] *
        fraction
    );
  }


  function formatPercent(value) {
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
   * ÖFFENTLICHE SCHNITTSTELLE
   * =========================================================
   */

  window.DuplicateFix = Object.freeze({
    version:
      VERSION,

    limits:
      LIMITS,

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


    calculateFileDigest,

    calculateDigest:
      calculateFileDigest,


    createCanvasFromFile,


    prepareScan,

    prepareImage:
      prepareScan,

    createPreparedScan:
      prepareScan,

    createScanSignature:
      prepareScan,


    addIdentityToScan,

    updateScanIdentity:
      addIdentityToScan,


    createIdentitySignature,

    createTextSignature:
      createIdentitySignature,


    compareIdentitySignatures,

    compareTextSignatures:
      compareIdentitySignatures,

    compareIdentitySignature:
      compareIdentitySignatures,


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


    evaluateDuplicate,

    assessDuplicate:
      evaluateDuplicate,


    compareScans,

    comparePreparedScans:
      compareScans,

    compareScanSignatures:
      compareScans,


    checkDuplicate,

    isDuplicateScan:
      checkDuplicate,


    formatPercent
  });


  console.info(
    `DuplicateFix ${VERSION} geladen`
  );
})();
