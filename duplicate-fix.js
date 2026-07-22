"use strict";

window.DuplicateFix = (() => {
  const VERSION = "12.0";

  const LIMITS = Object.freeze({
    /*
     * Reiner Bildvergleich:
     * Nur bei nahezu identischen Fotos blockieren.
     */
    nearExactLabelVisual: 0.985,
    nearExactFullVisual: 0.975,

    /*
     * Gleiche eindeutige Kennungen.
     */
    manyIdentifiersCount: 4,
    manyIdentifiersText: 0.64,
    manyIdentifiersOverlap: 0.67,
    manyIdentifiersLayout: 0.58,
    manyIdentifiersVisual: 0.54,

    /*
     * Drei gemeinsame Kennungen benötigen
     * stärkere Text-, Layout- und Bildwerte.
     */
    threeIdentifiersText: 0.77,
    threeIdentifiersOverlap: 0.74,
    threeIdentifiersLayout: 0.68,
    threeIdentifiersVisual: 0.60,

    /*
     * Gleiches Foto beziehungsweise gleiche Szene
     * mit mindestens zwei eindeutigen Kennungen.
     */
    sameSceneFullVisual: 0.91,
    sameSceneLabelVisual: 0.88,
    sameSceneText: 0.52,
    sameSceneIdentifiers: 2,

    /*
     * Fast vollständig identischer OCR-Text.
     */
    extremeText: 0.93,
    extremeLayout: 0.80,
    extremeLabelVisual: 0.70
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
    "KILOGRAMM",
    "FROM",
    "PROTECT",
    "FROST",
    "CUSTOMER",
    "KUNDE",
    "SUPPLIER",
    "LIEFERANT",
    "DESCRIPTION",
    "BEZEICHNUNG"
  ]);


  async function prepareScan(
    file,
    sourceCanvas
  ) {
    return {
      version: VERSION,

      fileDigest:
        await calculateFileDigest(file),

      visualSignature:
        createVisualSignature(
          sourceCanvas
        ),

      identitySignature: null
    };
  }


  function precheck(first, second) {
    if (
      first?.fileDigest &&
      second?.fileDigest &&
      first.fileDigest ===
        second.fileDigest
    ) {
      return createResult({
        duplicate: true,
        exactFile: true,

        labelVisualSimilarity: 1,
        fullVisualSimilarity: 1,

        reason:
          "Es wurde exakt dieselbe Bilddatei wie bei Etikett 1 verwendet."
      });
    }

    const visual =
      compareVisualSignatures(
        first?.visualSignature,
        second?.visualSignature
      );

    /*
     * Vor der OCR nur extrem ähnliche Bilder blockieren.
     */
    if (
      visual.label >=
        LIMITS.nearExactLabelVisual &&
      visual.full >=
        LIMITS.nearExactFullVisual
    ) {
      return createResult({
        duplicate: true,
        exactFile: false,

        labelVisualSimilarity:
          visual.label,

        fullVisualSimilarity:
          visual.full,

        reason:
          "Das zweite Foto stimmt nahezu vollständig mit dem ersten Foto überein."
      });
    }

    return createResult({
      duplicate: false,
      exactFile: false,

      labelVisualSimilarity:
        visual.label,

      fullVisualSimilarity:
        visual.full,

      reason:
        "Die Bildvorprüfung ergab keinen sicheren doppelten Scan."
    });
  }


  function finalCheck(first, second) {
    const visual =
      compareVisualSignatures(
        first?.visualSignature,
        second?.visualSignature
      );

    const identity =
      compareIdentitySignatures(
        first?.identitySignature,
        second?.identitySignature
      );

    const base = {
      exactFile: false,

      labelVisualSimilarity:
        visual.label,

      fullVisualSimilarity:
        visual.full,

      textSimilarity:
        identity.textSimilarity,

      strongOverlap:
        identity.strongOverlap,

      layoutSimilarity:
        identity.layoutSimilarity,

      commonStrong:
        identity.commonStrong
    };

    /*
     * Nahezu identische Bilder.
     */
    if (
      visual.label >=
        LIMITS.nearExactLabelVisual &&
      visual.full >=
        LIMITS.nearExactFullVisual
    ) {
      return createResult({
        ...base,

        duplicate: true,

        reason:
          "Das zweite Foto stimmt nahezu vollständig mit Etikett 1 überein."
      });
    }

    /*
     * Mindestens vier identische eindeutige Nummern
     * an ähnlichen Positionen.
     */
    if (
      identity.available &&
      identity.commonStrong >=
        LIMITS.manyIdentifiersCount &&
      identity.textSimilarity >=
        LIMITS.manyIdentifiersText &&
      identity.strongOverlap >=
        LIMITS.manyIdentifiersOverlap &&
      identity.layoutSimilarity >=
        LIMITS.manyIdentifiersLayout &&
      visual.label >=
        LIMITS.manyIdentifiersVisual
    ) {
      return createResult({
        ...base,

        duplicate: true,

        reason:
          "Mehrere eindeutige Nummern und ihre Positionen stimmen mit Etikett 1 überein."
      });
    }

    /*
     * Drei gemeinsame eindeutige Kennungen.
     */
    if (
      identity.available &&
      identity.commonStrong >= 3 &&
      identity.textSimilarity >=
        LIMITS.threeIdentifiersText &&
      identity.strongOverlap >=
        LIMITS.threeIdentifiersOverlap &&
      identity.layoutSimilarity >=
        LIMITS.threeIdentifiersLayout &&
      visual.label >=
        LIMITS.threeIdentifiersVisual
    ) {
      return createResult({
        ...base,

        duplicate: true,

        reason:
          "Drei eindeutige Kennungen, Etikettentext und Layout stimmen stark mit Etikett 1 überein."
      });
    }

    /*
     * Gleiche Szene beziehungsweise dasselbe Etikett
     * mit mindestens zwei identischen Kennungen.
     */
    if (
      identity.available &&
      identity.commonStrong >=
        LIMITS.sameSceneIdentifiers &&
      identity.textSimilarity >=
        LIMITS.sameSceneText &&
      visual.full >=
        LIMITS.sameSceneFullVisual &&
      visual.label >=
        LIMITS.sameSceneLabelVisual
    ) {
      return createResult({
        ...base,

        duplicate: true,

        reason:
          "Gesamtbild, Etikettenbereich und mehrere eindeutige Kennungen stimmen mit Etikett 1 überein."
      });
    }

    /*
     * Nahezu vollständige Text- und Layoutübereinstimmung.
     */
    if (
      identity.available &&
      identity.textSimilarity >=
        LIMITS.extremeText &&
      identity.layoutSimilarity >=
        LIMITS.extremeLayout &&
      visual.label >=
        LIMITS.extremeLabelVisual
    ) {
      return createResult({
        ...base,

        duplicate: true,

        reason:
          "Etikettentext, Positionen und Bildstruktur entsprechen sehr wahrscheinlich erneut Etikett 1."
      });
    }

    return createResult({
      ...base,

      duplicate: false,

      reason:
        "Etikett 2 unterscheidet sich ausreichend von Etikett 1."
    });
  }


  function createResult(values) {
    return {
      duplicate:
        Boolean(values.duplicate),

      exactFile:
        Boolean(values.exactFile),

      labelVisualSimilarity:
        finiteOrNull(
          values.labelVisualSimilarity
        ),

      fullVisualSimilarity:
        finiteOrNull(
          values.fullVisualSimilarity
        ),

      textSimilarity:
        finiteOrNull(
          values.textSimilarity
        ),

      strongOverlap:
        finiteOrNull(
          values.strongOverlap
        ),

      layoutSimilarity:
        finiteOrNull(
          values.layoutSimilarity
        ),

      commonStrong:
        Number.isFinite(
          values.commonStrong
        )
          ? values.commonStrong
          : null,

      reason:
        values.reason || ""
    };
  }


  function finiteOrNull(value) {
    return Number.isFinite(value)
      ? value
      : null;
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
    const fullRegion = {
      x: 0,
      y: 0,
      width: sourceCanvas.width,
      height: sourceCanvas.height
    };

    const labelRegion =
      detectLabelRegion(
        sourceCanvas
      );

    return {
      full:
        createFingerprintVariants(
          sourceCanvas,
          fullRegion,
          [-4, 0, 4]
        ),

      label:
        createFingerprintVariants(
          sourceCanvas,
          labelRegion,
          [-7, -3, 0, 3, 7]
        ),

      labelRegion
    };
  }


  /*
   * Sucht die größte helle, relativ farbneutrale Fläche.
   * Bei typischen weißen Etiketten wird dadurch möglichst
   * der Etikettenbereich statt des gesamten Fotos verglichen.
   */
  function detectLabelRegion(
    sourceCanvas
  ) {
    const size = 112;

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

    context.drawImage(
      sourceCanvas,
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

    const luminances = [];

    for (
      let index = 0;
      index < data.length;
      index += 4
    ) {
      luminances.push(
        data[index] * 0.299 +
        data[index + 1] * 0.587 +
        data[index + 2] * 0.114
      );
    }

    const threshold =
      Math.max(
        125,
        percentile(
          luminances,
          58
        )
      );

    const mask =
      new Uint8Array(
        size * size
      );

    for (
      let pixel = 0;
      pixel < mask.length;
      pixel += 1
    ) {
      const dataIndex =
        pixel * 4;

      const red =
        data[dataIndex];

      const green =
        data[dataIndex + 1];

      const blue =
        data[dataIndex + 2];

      const luminance =
        red * 0.299 +
        green * 0.587 +
        blue * 0.114;

      const saturation =
        Math.max(
          red,
          green,
          blue
        ) -
        Math.min(
          red,
          green,
          blue
        );

      mask[pixel] =
        luminance >= threshold &&
        saturation <= 115
          ? 1
          : 0;
    }

    const visited =
      new Uint8Array(
        mask.length
      );

    let best = null;

    for (
      let start = 0;
      start < mask.length;
      start += 1
    ) {
      if (
        !mask[start] ||
        visited[start]
      ) {
        continue;
      }

      const stack = [start];

      visited[start] = 1;

      let area = 0;

      let minX = size;
      let minY = size;
      let maxX = 0;
      let maxY = 0;

      while (stack.length) {
        const current =
          stack.pop();

        const x =
          current % size;

        const y =
          Math.floor(
            current / size
          );

        area += 1;

        minX =
          Math.min(minX, x);

        minY =
          Math.min(minY, y);

        maxX =
          Math.max(maxX, x);

        maxY =
          Math.max(maxY, y);

        const neighbours = [
          current - 1,
          current + 1,
          current - size,
          current + size
        ];

        for (const neighbour of neighbours) {
          if (
            neighbour < 0 ||
            neighbour >= mask.length ||
            visited[neighbour] ||
            !mask[neighbour]
          ) {
            continue;
          }

          const neighbourX =
            neighbour % size;

          if (
            Math.abs(
              neighbourX - x
            ) > 1
          ) {
            continue;
          }

          visited[neighbour] = 1;
          stack.push(neighbour);
        }
      }

      const width =
        maxX - minX + 1;

      const height =
        maxY - minY + 1;

      const boundingArea =
        width * height;

      const areaRatio =
        area /
        mask.length;

      const rectangularity =
        area /
        Math.max(
          1,
          boundingArea
        );

      if (
        areaRatio < 0.018 ||
        width < 14 ||
        height < 14
      ) {
        continue;
      }

      const centerX =
        (minX + maxX) / 2;

      const centerY =
        (minY + maxY) / 2;

      const distance =
        Math.hypot(
          centerX - size / 2,
          centerY - size / 2
        ) /
        (size * 0.71);

      const centerFactor =
        1.18 -
        Math.min(
          1,
          distance
        ) * 0.25;

      const score =
        area *
        rectangularity *
        centerFactor;

      if (
        !best ||
        score > best.score
      ) {
        best = {
          minX,
          minY,
          maxX,
          maxY,
          areaRatio,
          score
        };
      }
    }

    if (
      !best ||
      best.areaRatio > 0.94
    ) {
      return {
        x: 0,
        y: 0,
        width: sourceCanvas.width,
        height: sourceCanvas.height
      };
    }

    const padding = 5;

    const minX =
      Math.max(
        0,
        best.minX - padding
      );

    const minY =
      Math.max(
        0,
        best.minY - padding
      );

    const maxX =
      Math.min(
        size - 1,
        best.maxX + padding
      );

    const maxY =
      Math.min(
        size - 1,
        best.maxY + padding
      );

    return {
      x:
        minX /
        size *
        sourceCanvas.width,

      y:
        minY /
        size *
        sourceCanvas.height,

      width:
        (
          maxX -
          minX +
          1
        ) /
        size *
        sourceCanvas.width,

      height:
        (
          maxY -
          minY +
          1
        ) /
        size *
        sourceCanvas.height
    };
  }


  function createFingerprintVariants(
    sourceCanvas,
    region,
    angles
  ) {
    return angles.map(
      angle =>
        createFingerprint(
          sourceCanvas,
          region,
          angle
        )
    );
  }


  function createFingerprint(
    sourceCanvas,
    region,
    angle
  ) {
    const normalizedSize = 224;

    const normalized =
      document.createElement(
        "canvas"
      );

    normalized.width =
      normalizedSize;

    normalized.height =
      normalizedSize;

    const context =
      normalized.getContext(
        "2d",
        {
          willReadFrequently: true
        }
      );

    context.fillStyle = "white";

    context.fillRect(
      0,
      0,
      normalizedSize,
      normalizedSize
    );

    context.save();

    context.translate(
      normalizedSize / 2,
      normalizedSize / 2
    );

    context.rotate(
      angle *
      Math.PI /
      180
    );

    context.drawImage(
      sourceCanvas,

      region.x,
      region.y,
      region.width,
      region.height,

      -normalizedSize / 2,
      -normalizedSize / 2,
      normalizedSize,
      normalizedSize
    );

    context.restore();

    const sampleSize = 36;

    const sample =
      document.createElement(
        "canvas"
      );

    sample.width =
      sampleSize;

    sample.height =
      sampleSize;

    const sampleContext =
      sample.getContext(
        "2d",
        {
          willReadFrequently: true
        }
      );

    sampleContext.drawImage(
      normalized,
      0,
      0,
      sampleSize,
      sampleSize
    );

    const data =
      sampleContext.getImageData(
        0,
        0,
        sampleSize,
        sampleSize
      ).data;

    const grayscale = [];

    for (
      let index = 0;
      index < data.length;
      index += 4
    ) {
      grayscale.push(
        data[index] * 0.299 +
        data[index + 1] * 0.587 +
        data[index + 2] * 0.114
      );
    }

    const low =
      percentile(
        grayscale,
        4
      );

    const high =
      Math.max(
        low + 25,
        percentile(
          grayscale,
          96
        )
      );

    const normalizedGray =
      grayscale.map(value =>
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
      y < sampleSize;
      y += 1
    ) {
      for (
        let x = 0;
        x < sampleSize - 1;
        x += 1
      ) {
        const left =
          normalizedGray[
            y *
            sampleSize +
            x
          ];

        const right =
          normalizedGray[
            y *
            sampleSize +
            x +
            1
          ];

        differenceHash +=
          left > right
            ? "1"
            : "0";
      }
    }

    const edges =
      new Array(
        sampleSize *
        sampleSize
      ).fill(0);

    for (
      let y = 1;
      y < sampleSize - 1;
      y += 1
    ) {
      for (
        let x = 1;
        x < sampleSize - 1;
        x += 1
      ) {
        const index =
          y *
          sampleSize +
          x;

        const horizontal =
          normalizedGray[index + 1] -
          normalizedGray[index - 1];

        const vertical =
          normalizedGray[
            index +
            sampleSize
          ] -
          normalizedGray[
            index -
            sampleSize
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
        70
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

    const total =
      normalizedGray.length;

    return {
      size:
        sampleSize,

      grayscale:
        normalizedGray,

      averageHash,

      differenceHash,

      edgeHash,

      histogram:
        histogram.map(value =>
          value / total
        )
    };
  }


  function compareVisualSignatures(
    first,
    second
  ) {
    if (!first || !second) {
      return {
        label: 0,
        full: 0
      };
    }

    return {
      label:
        compareFingerprintVariants(
          first.label,
          second.label
        ),

      full:
        compareFingerprintVariants(
          first.full,
          second.full
        )
    };
  }


  function compareFingerprintVariants(
    firstVariants,
    secondVariants
  ) {
    if (
      !Array.isArray(firstVariants) ||
      !Array.isArray(secondVariants)
    ) {
      return 0;
    }

    let best = 0;

    for (
      const first
      of firstVariants
    ) {
      for (
        const second
        of secondVariants
      ) {
        best =
          Math.max(
            best,
            compareFingerprints(
              first,
              second
            )
          );
      }
    }

    return best;
  }


  function compareFingerprints(
    first,
    second
  ) {
    if (!first || !second) {
      return 0;
    }

    const grayscaleSimilarity =
      bestShiftedSimilarity(
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
      grayscaleSimilarity * 0.38 +
      averageHashSimilarity * 0.13 +
      differenceHashSimilarity * 0.15 +
      edgeHashSimilarity * 0.24 +
      histogramSimilarity * 0.10
    );
  }


  function bestShiftedSimilarity(
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

            difference +=
              Math.abs(
                first[
                  y *
                  size +
                  x
                ] -
                second[
                  secondY *
                  size +
                  secondX
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
      first.length !==
        second.length
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
      first.length !==
        second.length
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


  function createIdentitySignature(
    identityData
  ) {
    const width =
      Math.max(
        1,
        Number(
          identityData?.width || 1
        )
      );

    const height =
      Math.max(
        1,
        Number(
          identityData?.height || 1
        )
      );

    const sourceWords =
      Array.isArray(
        identityData?.words
      )
        ? identityData.words
        : [];

    const words = [];

    for (const sourceWord of sourceWords) {
      const token =
        normalizeIdentityToken(
          sourceWord.text
        );

      if (
        !token ||
        /^D[0-9]+$/.test(token) ||
        sourceWord.confidence < 28
      ) {
        continue;
      }

      const centerX =
        (
          sourceWord.left +
          sourceWord.width / 2
        ) /
        width;

      const centerY =
        (
          sourceWord.top +
          sourceWord.height / 2
        ) /
        height;

      words.push({
        token,
        confidence:
          sourceWord.confidence,

        x:
          clamp01(centerX),

        y:
          clamp01(centerY)
      });
    }

    /*
     * Falls TSV wenige Wörter liefert,
     * werden die normalen Textblöcke zusätzlich aufgenommen.
     */
    const fallbackTokens =
      String(
        identityData?.text || ""
      )
        .toUpperCase()
        .split(/\s+/)
        .map(
          normalizeIdentityToken
        )
        .filter(Boolean)
        .filter(token =>
          !/^D[0-9]+$/.test(token)
        );

    const tokenSet =
      new Set(
        words.map(
          word =>
            word.token
        )
      );

    for (const token of fallbackTokens) {
      tokenSet.add(token);
    }

    const tokens =
      [...tokenSet]
        .filter(token =>
          token.length >= 3 ||
          /^[0-9]{4,}$/.test(token)
        );

    const strongTokens =
      tokens.filter(
        isStrongIdentityToken
      );

    const positions = {};

    for (const word of words) {
      if (!positions[word.token]) {
        positions[word.token] = [];
      }

      positions[word.token].push({
        x: word.x,
        y: word.y
      });
    }

    return {
      tokens,
      strongTokens,
      positions
    };
  }


  function normalizeIdentityToken(value) {
    return String(value || "")
      .toUpperCase()
      .trim()
      .replace(
        /^[^A-Z0-9]+|[^A-Z0-9]+$/g,
        ""
      );
  }


  function isStrongIdentityToken(token) {
    if (
      !token ||
      GENERIC_WORDS.has(token)
    ) {
      return false;
    }

    /*
     * Eindeutige Kennungen:
     *
     * - reine Nummern mit mindestens vier Stellen
     * - gemischte Codes aus Buchstaben und Zahlen
     */
    return (
      /^[0-9]{4,}$/.test(token) ||
      (
        token.length >= 5 &&
        /[A-Z]/.test(token) &&
        /[0-9]/.test(token)
      )
    );
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

    const firstStrong =
      new Set(
        first?.strongTokens || []
      );

    const secondStrong =
      new Set(
        second?.strongTokens || []
      );

    if (
      firstTokens.size < 3 ||
      secondTokens.size < 3
    ) {
      return {
        available: false,
        textSimilarity: 0,
        commonStrong: 0,
        strongOverlap: 0,
        layoutSimilarity: 0
      };
    }

    const union =
      new Set([
        ...firstTokens,
        ...secondTokens
      ]);

    let unionWeight = 0;
    let commonWeight = 0;

    for (const token of union) {
      const weight =
        tokenWeight(token);

      unionWeight += weight;

      if (
        firstTokens.has(token) &&
        secondTokens.has(token)
      ) {
        commonWeight += weight;
      }
    }

    const commonStrongTokens =
      [...firstStrong]
        .filter(token =>
          secondStrong.has(token)
        );

    const commonStrong =
      commonStrongTokens.length;

    const strongOverlap =
      commonStrong /
      Math.max(
        1,
        Math.min(
          firstStrong.size,
          secondStrong.size
        )
      );

    const layoutSimilarity =
      compareTokenLayouts(
        commonStrongTokens,
        first?.positions || {},
        second?.positions || {}
      );

    return {
      available: true,

      textSimilarity:
        commonWeight /
        Math.max(
          1,
          unionWeight
        ),

      commonStrong,

      strongOverlap,

      layoutSimilarity
    };
  }


  function compareTokenLayouts(
    tokens,
    firstPositions,
    secondPositions
  ) {
    const scores = [];

    for (const token of tokens) {
      const first =
        firstPositions[token] || [];

      const second =
        secondPositions[token] || [];

      if (
        !first.length ||
        !second.length
      ) {
        continue;
      }

      let bestDistance =
        Infinity;

      for (
        const firstPosition
        of first
      ) {
        for (
          const secondPosition
          of second
        ) {
          const distance =
            Math.hypot(
              firstPosition.x -
              secondPosition.x,

              firstPosition.y -
              secondPosition.y
            );

          bestDistance =
            Math.min(
              bestDistance,
              distance
            );
        }
      }

      const score =
        Math.max(
          0,
          1 -
          bestDistance /
          0.38
        );

      scores.push(score);
    }

    if (!scores.length) {
      return 0;
    }

    return scores.reduce(
      (sum, score) =>
        sum + score,
      0
    ) /
    scores.length;
  }


  function tokenWeight(token) {
    if (
      GENERIC_WORDS.has(token)
    ) {
      return 0.15;
    }

    if (
      /^[0-9]{4,}$/.test(token)
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
      return 1.4;
    }

    return 1;
  }


  function percentile(
    values,
    requestedPercentile
  ) {
    if (
      !Array.isArray(values) ||
      !values.length
    ) {
      return 0;
    }

    const sorted =
      [...values].sort(
        (first, second) =>
          first - second
      );

    const position =
      requestedPercentile /
      100 *
      (sorted.length - 1);

    const lower =
      Math.floor(position);

    const upper =
      Math.ceil(position);

    if (lower === upper) {
      return sorted[lower];
    }

    const fraction =
      position - lower;

    return (
      sorted[lower] *
        (1 - fraction) +
      sorted[upper] *
        fraction
    );
  }


  function clamp01(value) {
    return Math.max(
      0,
      Math.min(
        1,
        Number(value || 0)
      )
    );
  }


  console.info(
    `Doppel-Scan-Schutz ${VERSION} geladen.`
  );


  return {
    version: VERSION,

    prepareScan,
    precheck,

    createIdentitySignature,
    finalCheck
  };
})();
