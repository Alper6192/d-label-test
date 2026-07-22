"use strict";

(() => {
  const VERSION = "11.0";

  /*
   * Diese Grenzwerte sind bewusst zurückhaltend.
   * Unterschiedliche Etiketten mit gleichem Layout
   * sollen nicht vorschnell blockiert werden.
   */
  const LIMITS = Object.freeze({
    visualOnly: 0.99,

    strongTextSimilarity: 0.90,
    visualWithStrongText: 0.76,

    mediumTextSimilarity: 0.80,
    visualWithMediumText: 0.90,

    requiredCommonIdentifiers: 3,
    visualWithIdentifiers: 0.80
  });


  /*
   * Für die D-Nummern-OCR müssen alle Buchstaben erlaubt sein.
   *
   * Andernfalls kann beispielsweise ein A von Tesseract
   * zwangsweise als D ausgegeben werden.
   *
   * Die spätere Prüfung akzeptiert trotzdem ausschließlich
   * D direkt gefolgt von Ziffern.
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
    "KG",
    "AG",
    "CO"
  ]);


  /*
   * =========================================================
   * TEXTEINGABE NORMALISIEREN
   * =========================================================
   */

  function normalizeTextInput(value) {
    if (Array.isArray(value)) {
      return value
        .map(item => {
          if (typeof item === "string") {
            return item;
          }

          if (
            item &&
            typeof item.text === "string"
          ) {
            return item.text;
          }

          if (
            item &&
            typeof item.rawText === "string"
          ) {
            return item.rawText;
          }

          return "";
        })
        .join("\n");
    }


    if (
      value &&
      typeof value === "object"
    ) {
      /*
       * Direktes Objekt mit Text.
       */
      if (
        typeof value.text === "string"
      ) {
        return value.text;
      }

      /*
       * Tesseract-Ergebnis.
       */
      if (
        value.data &&
        typeof value.data.text === "string"
      ) {
        return value.data.text;
      }

      /*
       * OCR-Ergebnis mit mehreren Durchläufen.
       */
      if (
        Array.isArray(value.passes)
      ) {
        return normalizeTextInput(
          value.passes
        );
      }
    }


    return String(value || "");
  }


  /*
   * =========================================================
   * D-NUMMERN-ERKENNUNG
   * =========================================================
   *
   * Die Regel ist:
   *
   * - Der Textblock beginnt mit D.
   * - Direkt hinter D folgt mindestens eine Ziffer.
   * - Danach dürfen nur weitere Ziffern folgen.
   * - Beim nächsten Leerzeichen, Tab oder Zeilenumbruch
   *   endet die D-Nummer.
   * - Verschiedene Textblöcke werden niemals verbunden.
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

    const tokens =
      text
        .split(/\s+/)
        .filter(Boolean);

    const results =
      new Set();


    for (const token of tokens) {
      /*
       * Es wird nur der vollständige Textblock akzeptiert.
       *
       * Zahlen vor oder hinter diesem Block werden nicht
       * angehängt.
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
     * Inhaltliche Fehler werden nicht automatisch entfernt.
     *
     * Dadurch wird beispielsweise D 123 nicht automatisch
     * in D123 umgewandelt.
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
    /*
     * Kopie zurückgeben, damit der Aufrufer
     * das Originalobjekt nicht verändern kann.
     */
    return {
      ...CODE_OCR_PARAMETERS
    };
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
      typeof file.arrayBuffer === "function"
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
      file.name,
      file.size,
      file.lastModified,
      file.type
    ].join("|");
  }


  /*
   * =========================================================
   * IDENTITÄTS-SIGNATUR AUS OCR-TEXT
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
     * Die eigentliche D-Nummer wird aus dem
     * Doppel-Scan-Textvergleich entfernt.
     *
     * Zwei korrekte, zusammengehörende Etiketten dürfen
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


    /*
     * Nur längere Zahlen oder gemischte Codes
     * gelten als eindeutige Kennungen.
     */
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
      tokenCount: tokens.length
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


    /*
     * Zu wenig OCR-Text:
     * Keine textbasierte Doppel-Scan-Entscheidung.
     */
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
        tokenWeight(token);

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


  function tokenWeight(token) {
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

  function createVisualSignature(
    sourceCanvas
  ) {
    if (
      !sourceCanvas ||
      !sourceCanvas.width ||
      !sourceCanvas.height
    ) {
      return null;
    }


    const width =
      sourceCanvas.width;

    const height =
      sourceCanvas.height;


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
          normalizedGray[index + 1] -
          normalizedGray[index - 1];


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

      totalWeight +=
        weight;
    }


    return weightedScore /
      Math.max(
        0.0001,
        totalWeight
      );
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
   * DOPPEL-SCAN-ENTSCHEIDUNG
   * =========================================================
   */

  function evaluateDuplicate(
    visualOrOptions,
    identityComparison,
    exactFileMatch = false
  ) {
    /*
     * Unterstützt zwei Aufrufformen:
     *
     * evaluateDuplicate(visual, textvergleich, exact)
     *
     * oder:
     *
     * evaluateDuplicate({
     *   visualSimilarity,
     *   identityComparison,
     *   exactFileMatch
     * })
     */
    let visualSimilarity =
      visualOrOptions;

    let comparison =
      identityComparison;

    let exact =
      exactFileMatch;


    if (
      visualOrOptions &&
      typeof visualOrOptions === "object"
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


    /*
     * Exakt dieselbe Datei wird immer blockiert.
     */
    if (exact) {
      return {
        duplicate: true,

        reason:
          "Es wurde exakt dieselbe Bilddatei verwendet."
      };
    }


    /*
     * Nur bei fast vollständiger visueller
     * Übereinstimmung allein blockieren.
     */
    if (
      visual >=
      LIMITS.visualOnly
    ) {
      return {
        duplicate: true,

        reason:
          "Das zweite Foto stimmt visuell nahezu vollständig mit dem ersten Foto überein."
      };
    }


    /*
     * Mehrere echte gemeinsame Kennungen.
     */
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

        reason:
          "Mehrere eindeutige Kennungen sowie die Bildstruktur stimmen überein."
      };
    }


    /*
     * Sehr hohe Textähnlichkeit plus
     * deutliche Bildähnlichkeit.
     */
    if (
      textAvailable &&
      textSimilarity >=
        LIMITS.strongTextSimilarity &&
      visual >=
        LIMITS.visualWithStrongText
    ) {
      return {
        duplicate: true,

        reason:
          "Etikettentext und Bildstruktur entsprechen sehr wahrscheinlich erneut demselben Etikett."
      };
    }


    /*
     * Mittlere Textähnlichkeit reicht nur bei
     * sehr hoher visueller Ähnlichkeit.
     */
    if (
      textAvailable &&
      textSimilarity >=
        LIMITS.mediumTextSimilarity &&
      visual >=
        LIMITS.visualWithMediumText
    ) {
      return {
        duplicate: true,

        reason:
          "Text und Bildstruktur sind gemeinsam ungewöhnlich ähnlich."
      };
    }


    /*
     * Unsichere Fälle werden zugelassen.
     * Dadurch werden verschiedene Etiketten nicht vorschnell blockiert.
     */
    return {
      duplicate: false,

      reason:
        "Die Aufnahmen unterscheiden sich ausreichend."
    };
  }


  function checkDuplicate(
    options = {}
  ) {
    const exactFileMatch =
      Boolean(
        options.exactFileMatch ||
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
            options.firstVisual ??
              options.firstImageSignature,

            options.secondVisual ??
              options.secondImageSignature
          );


    const identityComparison =
      options.identityComparison ||
      compareIdentitySignatures(
        options.firstIdentity ??
          options.firstIdentitySignature,

        options.secondIdentity ??
          options.secondIdentitySignature
      );


    const decision =
      evaluateDuplicate(
        visualSimilarity,
        identityComparison,
        exactFileMatch
      );


    return {
      ...decision,

      exactFileMatch,
      visualSimilarity,
      identityComparison
    };
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
   *
   * Genau dieser Block behebt die Fehlermeldung:
   *
   * window.DuplicateFix.createIdentitySignature
   * is not a function
   */

  window.DuplicateFix = Object.freeze({
    version:
      VERSION,

    limits:
      LIMITS,

    codeOcrParameters:
      CODE_OCR_PARAMETERS,


    getCodeOcrParameters,

    extractStrictDCodes,

    normalizeManualCode,

    isValidCode,

    calculateFileDigest,


    createIdentitySignature,

    createTextSignature:
      createIdentitySignature,


    compareIdentitySignatures,

    compareIdentitySignature:
      compareIdentitySignatures,

    compareTextSignatures:
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

    checkDuplicate,

    formatPercent
  });


  console.info(
    `DuplicateFix ${VERSION} geladen`
  );
})();
