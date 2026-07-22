"use strict";

window.DuplicateFix = (() => {
  const VERSION = "11.0";

  /*
   * Die Grenzwerte sind bewusst zurückhaltend.
   *
   * Zwei unterschiedliche Etiketten mit demselben
   * Aufbau sollen nicht vorschnell blockiert werden.
   */
  const LIMITS = Object.freeze({
    /*
     * Allein anhand des Bildes nur bei nahezu
     * vollständiger Übereinstimmung blockieren.
     */
    visualOnly:
      0.995,

    /*
     * Mehrere eindeutige gemeinsame Kennungen.
     */
    commonStrongRequired:
      4,

    identifiersText:
      0.80,

    identifiersVisual:
      0.74,

    /*
     * Extrem hohe Gesamttextähnlichkeit.
     */
    veryStrongText:
      0.94,

    veryStrongTextVisual:
      0.82,

    /*
     * Noch strengere Kombination bei nur
     * drei gemeinsamen eindeutigen Kennungen.
     */
    threeIdentifiersText:
      0.90,

    threeIdentifiersVisual:
      0.80
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
    "VERPACKUNG",
    "ADDRESS",
    "ADRESSE",
    "KILOGRAM",
    "KILOGRAMM"
  ]);


  async function prepareScan(
    file,
    sourceCanvas
  ) {
    const fileDigest =
      await calculateFileDigest(
        file
      );

    const visualSignature =
      createVisualSignature(
        sourceCanvas
      );

    return {
      version:
        VERSION,

      fileDigest,

      visualSignature,

      textSignature: null
    };
  }


  function precheck(
    first,
    second
  ) {
    if (
      first?.fileDigest &&
      second?.fileDigest &&
      first.fileDigest ===
        second.fileDigest
    ) {
      return {
        duplicate: true,

        exactFile: true,

        visualSimilarity:
          1,

        textSimilarity:
          null,

        commonStrong:
          null,

        reason:
          "Es wurde exakt dieselbe Bilddatei wie bei Etikett 1 verwendet."
      };
    }

    const visualSimilarity =
      compareVisualSignatures(
        first?.visualSignature,
        second?.visualSignature
      );

    if (
      visualSimilarity >=
      LIMITS.visualOnly
    ) {
      return {
        duplicate: true,

        exactFile: false,

        visualSimilarity,

        textSimilarity:
          null,

        commonStrong:
          null,

        reason:
          "Das zweite Foto stimmt visuell nahezu vollständig mit Etikett 1 überein."
      };
    }

    return {
      duplicate: false,

      exactFile: false,

      visualSimilarity,

      textSimilarity:
        null,

      commonStrong:
        null,

      reason:
        "Die Bildvorprüfung ergab keinen sicheren doppelten Scan."
    };
  }


  function finalCheck(
    first,
    second
  ) {
    const visualSimilarity =
      compareVisualSignatures(
        first?.visualSignature,
        second?.visualSignature
      );

    const textComparison =
      compareTextSignatures(
        first?.textSignature,
        second?.textSignature
      );

    const textSimilarity =
      textComparison.similarity;

    const commonStrong =
      textComparison.commonStrong;

    /*
     * Nahezu identischer Bildaufbau.
     */
    if (
      visualSimilarity >=
      LIMITS.visualOnly
    ) {
      return {
        duplicate: true,

        exactFile: false,

        visualSimilarity,

        textSimilarity,

        commonStrong,

        reason:
          "Das zweite Foto stimmt visuell nahezu vollständig mit Etikett 1 überein."
      };
    }

    /*
     * Mindestens vier gemeinsame eindeutige Kennungen,
     * deutliche Textähnlichkeit und ähnlicher Bildaufbau.
     */
    if (
      textComparison.available &&
      commonStrong >=
        LIMITS.commonStrongRequired &&
      textSimilarity >=
        LIMITS.identifiersText &&
      visualSimilarity >=
        LIMITS.identifiersVisual
    ) {
      return {
        duplicate: true,

        exactFile: false,

        visualSimilarity,

        textSimilarity,

        commonStrong,

        reason:
          "Mehrere eindeutige Nummern und der Bildaufbau stimmen mit Etikett 1 überein."
      };
    }

    /*
     * Drei eindeutige Kennungen reichen nur,
     * wenn Text und Bild zusätzlich sehr ähnlich sind.
     */
    if (
      textComparison.available &&
      commonStrong >= 3 &&
      textSimilarity >=
        LIMITS.threeIdentifiersText &&
      visualSimilarity >=
        LIMITS.threeIdentifiersVisual
    ) {
      return {
        duplicate: true,

        exactFile: false,

        visualSimilarity,

        textSimilarity,

        commonStrong,

        reason:
          "Drei eindeutige Kennungen sowie Text und Bild stimmen sehr stark mit Etikett 1 überein."
      };
    }

    /*
     * Extrem hohe Ähnlichkeit des gesamten Begleittexts
     * plus deutliche visuelle Übereinstimmung.
     */
    if (
      textComparison.available &&
      textSimilarity >=
        LIMITS.veryStrongText &&
      visualSimilarity >=
        LIMITS.veryStrongTextVisual
    ) {
      return {
        duplicate: true,

        exactFile: false,

        visualSimilarity,

        textSimilarity,

        commonStrong,

        reason:
          "Etikettentext und Bildstruktur entsprechen sehr wahrscheinlich erneut Etikett 1."
      };
    }

    return {
      duplicate: false,

      exactFile: false,

      visualSimilarity,

      textSimilarity,

      commonStrong,

      reason:
        "Etikett 2 unterscheidet sich ausreichend von Etikett 1."
    };
  }


  async function calculateFileDigest(file) {
    if (
      window.crypto &&
      window.crypto.subtle
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


  function createVisualSignature(
    sourceCanvas
  ) {
    const width =
      sourceCanvas.width;

    const height =
      sourceCanvas.height;

    const regions = [
      {
        name:
          "full",

        weight:
          0.40,

        x: 0,
        y: 0,
        width,
        height
      },

      {
        name:
          "center",

        weight:
          0.30,

        x:
          width * 0.08,

        y:
          height * 0.08,

        width:
          width * 0.84,

        height:
          height * 0.84
      },

      {
        name:
          "top",

        weight:
          0.15,

        x: 0,
        y: 0,
        width,

        height:
          height * 0.58
      },

      {
        name:
          "bottom",

        weight:
          0.15,

        x: 0,

        y:
          height * 0.42,

        width,

        height:
          height * 0.58
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
            sourceCanvas,
            region
          )
      })
    );
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

    const data =
      context.getImageData(
        0,
        0,
        size,
        size
      ).data;

    const grayscale = [];

    for (
      let index = 0;
      index < data.length;
      index += 4
    ) {
      grayscale.push(
        data[index] *
          0.299 +
        data[index + 1] *
          0.587 +
        data[index + 2] *
          0.114
      );
    }

    const low =
      percentile(
        grayscale,
        5
      );

    const high =
      Math.max(
        low + 20,

        percentile(
          grayscale,
          95
        )
      );

    const normalized =
      grayscale.map(
        value =>
          Math.max(
            0,

            Math.min(
              1,

              (
                value -
                low
              ) /
              (
                high -
                low
              )
            )
          )
      );

    const median =
      percentile(
        normalized,
        50
      );

    const averageHash =
      normalized
        .map(
          value =>
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
          normalized[
            y * size + x
          ];

        const right =
          normalized[
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
          normalized[
            index + 1
          ] -
          normalized[
            index - 1
          ];

        const vertical =
          normalized[
            index + size
          ] -
          normalized[
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
      percentile(
        edges,
        68
      );

    const edgeHash =
      edges
        .map(
          value =>
            value >= edgeThreshold
              ? "1"
              : "0"
        )
        .join("");

    const histogram =
      new Array(16).fill(0);

    for (
      const value
      of normalized
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

    const total =
      normalized.length;

    return {
      size,

      grayscale:
        normalized,

      averageHash,

      differenceHash,

      edgeHash,

      histogram:
        histogram.map(
          value =>
            value /
            total
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

      if (
        firstRegion.name !==
        secondRegion.name
      ) {
        continue;
      }

      const weight =
        Number(
          firstRegion.weight || 0
        );

      const similarity =
        compareRegionFingerprints(
          firstRegion.fingerprint,
          secondRegion.fingerprint
        );

      weightedScore +=
        similarity *
        weight;

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
      grayscaleSimilarity *
        0.42 +

      averageHashSimilarity *
        0.13 +

      differenceHashSimilarity *
        0.14 +

      edgeHashSimilarity *
        0.21 +

      histogramSimilarity *
        0.10
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
          const secondY =
            y + shiftY;

          if (
            secondY < 0 ||
            secondY >= size
          ) {
            continue;
          }

          for (
            let x = 0;
            x < size;
            x += 1
          ) {
            const secondX =
              x + shiftX;

            if (
              secondX < 0 ||
              secondX >= size
            ) {
              continue;
            }

            const firstValue =
              first[
                y * size + x
              ];

            const secondValue =
              second[
                secondY *
                size +
                secondX
              ];

            difference +=
              Math.abs(
                firstValue -
                secondValue
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


  function createTextSignature(text) {
    /*
     * Die OCR-Wörter bleiben voneinander getrennt.
     * Es werden keine Nummern verbunden.
     */
    const rawTokens =
      String(text || "")
        .toUpperCase()
        .replace(/\r/g, "")
        .split(/\s+/)
        .map(
          token =>
            token.replace(
              /^[^A-Z0-9]+|[^A-Z0-9]+$/g,
              ""
            )
        )
        .filter(Boolean);

    const tokens =
      [
        ...new Set(
          rawTokens
            /*
             * Die D-Nummer wird aus dem Identitätsvergleich
             * entfernt, da zwei passende Etiketten dieselbe
             * D-Nummer besitzen sollen.
             */
            .filter(
              token =>
                !/^D[0-9]+$/.test(
                  token
                )
            )

            .filter(
              token =>
                token.length >= 3 ||
                /^[0-9]{4,}$/.test(
                  token
                )
            )
        )
      ];

    const strongTokens =
      tokens.filter(
        token => {
          if (
            GENERIC_WORDS.has(
              token
            )
          ) {
            return false;
          }

          /*
           * Eindeutige Kennungen:
           *
           * - reine Zahlen mit mindestens fünf Stellen
           * - gemischte Buchstaben-/Zahlencodes
           */
          return (
            /^[0-9]{5,}$/.test(
              token
            ) ||

            (
              token.length >= 5 &&
              /[A-Z]/.test(token) &&
              /[0-9]/.test(token)
            )
          );
        }
      );

    return {
      tokens,
      strongTokens
    };
  }


  function compareTextSignatures(
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
        commonStrong: 0
      };
    }

    const union =
      new Set([
        ...firstTokens,
        ...secondTokens
      ]);

    let unionWeight = 0;
    let intersectionWeight = 0;

    for (const token of union) {
      const weight =
        tokenWeight(token);

      unionWeight +=
        weight;

      if (
        firstTokens.has(token) &&
        secondTokens.has(token)
      ) {
        intersectionWeight +=
          weight;
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
        .filter(
          token =>
            secondStrong.has(token)
        )
        .length;

    return {
      available: true,

      similarity:
        intersectionWeight /
        Math.max(
          1,
          unionWeight
        ),

      commonStrong
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

    if (
      token.length >= 7
    ) {
      return 1.5;
    }

    return 1;
  }


  function percentile(
    values,
    percentileValue
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
      percentileValue /
      100 *
      (
        sorted.length -
        1
      );

    const lower =
      Math.floor(position);

    const upper =
      Math.ceil(position);

    if (lower === upper) {
      return sorted[lower];
    }

    const fraction =
      position -
      lower;

    return (
      sorted[lower] *
        (
          1 -
          fraction
        ) +

      sorted[upper] *
        fraction
    );
  }


  console.info(
    `Doppel-Scan-Schutz ${VERSION} geladen.`
  );


  return {
    version:
      VERSION,

    prepareScan,

    precheck,

    createTextSignature,

    finalCheck
  };
})();
