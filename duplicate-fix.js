"use strict";

(() => {
  const FIX_VERSION = "4.0";

  /*
   * Die Erkennung ist absichtlich konservativ:
   * Ein unsicherer zweiter Scan wird blockiert.
   */
  const LIMITS = Object.freeze({
    almostIdenticalVisual: 0.90,

    strongTextSimilarity: 0.72,
    minimumVisualWithStrongText: 0.38,

    mediumTextSimilarity: 0.48,
    minimumVisualWithMediumText: 0.60,

    minimumVisualWithoutText: 0.52,

    minimumVisualWithCommonIdentifiers: 0.50
  });

  const CODE_WHITELIST =
    "D0123456789OQILSZGB -.:/_";

  const TEXT_WHITELIST =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.:/_()[]";

  const GENERIC_WORDS = new Set([
    "BATCH",
    "BATCHNO",
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
    "MATERIAL"
  ]);

  /*
   * Strenge D-Nummern-Regel:
   *
   * gültig:   D562708020
   * ungültig: D 562708020
   * ungültig: DA562708020
   * ungültig: D5627O8020
   * ungültig: D562708020A
   * ungültig: D5627080201
   */
  extractStrictDCodes = function extractStrictDCodesStrict(text) {
    const normalizedText =
      String(text || "")
        .toUpperCase()
        .replace(/\r/g, "");

    const pattern =
      /(?:^|[^A-Z0-9])D([0-9]{9})(?![A-Z0-9])/g;

    const results = new Set();

    let match;

    while (
      (match = pattern.exec(normalizedText)) !== null
    ) {
      results.add(`D${match[1]}`);
    }

    return [...results];
  };


  /*
   * Die ursprünglichen Dateiauswahl-Listener rufen processFile
   * dynamisch auf. Deshalb kann die Funktion hier ersetzt werden.
   */
  processFile = async function processFileWithDuplicateProtection(
    file,
    slotNumber
  ) {
    const slot =
      slotNumber === 1
        ? state.scan1
        : state.scan2;

    const preview =
      slotNumber === 1
        ? elements.preview1
        : elements.preview2;

    const placeholder =
      slotNumber === 1
        ? elements.placeholder1
        : elements.placeholder2;

    const codeInput =
      slotNumber === 1
        ? elements.code1
        : elements.code2;

    const info =
      slotNumber === 1
        ? elements.ocrInfo1
        : elements.ocrInfo2;

    const confirmButton =
      slotNumber === 1
        ? elements.confirm1
        : elements.confirm2;

    confirmButton.disabled = true;
    codeInput.value = "";
    info.textContent = "";

    setStatus(
      `Etikett ${slotNumber} wird vorbereitet …`,
      "scanning"
    );

    try {
      const image =
        await loadImage(file);

      const sourceCanvas =
        drawImageToCanvas(
          image,
          elements.sourceCanvas,
          2600
        );

      const fileDigest =
        await calculateFileDigest(file);

      const visualSignature =
        createVisualSignature(sourceCanvas);

      /*
       * Erste Prüfung vor der OCR:
       * Exakt dieselbe Datei oder nahezu identische Bildstruktur.
       */
      if (
        slotNumber === 2 &&
        state.scan1.fileDigest
      ) {
        if (
          fileDigest ===
          state.scan1.fileDigest
        ) {
          blockSecondScan(
            "Es wurde exakt dieselbe Bilddatei wie bei Etikett 1 verwendet.",
            {
              exactFile: true,
              visual: 1,
              text: 1
            }
          );

          return;
        }

        const preliminaryVisual =
          compareVisualSignatures(
            state.scan1.visualSignature,
            visualSignature
          );

        appendDebug(
          "\nDOPPEL-SCAN-VORPRÜFUNG\n" +
          `Version: ${FIX_VERSION}\n` +
          `Bildähnlichkeit: ${
            formatPercent(preliminaryVisual)
          }\n`
        );

        if (
          preliminaryVisual >=
          LIMITS.almostIdenticalVisual
        ) {
          blockSecondScan(
            "Die Bildstruktur stimmt nahezu vollständig mit Etikett 1 überein.",
            {
              exactFile: false,
              visual: preliminaryVisual,
              text: null
            }
          );

          return;
        }
      }

      revokePreview(slot);

      slot.previewUrl =
        URL.createObjectURL(file);

      preview.src = slot.previewUrl;
      preview.classList.add("visible");
      placeholder.classList.add("hidden");

      slot.fileDigest = fileDigest;
      slot.visualSignature = visualSignature;
      slot.confirmed = false;
      slot.code = null;

      await initializeWorker();

      /*
       * D-Nummer zunächst mit der bisherigen eingeschränkten
       * Zeichenauswahl suchen. Die Auswertung ist trotzdem streng.
       */
      await configureCodeRecognition();

      const result =
        await searchForDNumber(
          sourceCanvas,
          slotNumber
        );

      /*
       * Zusätzlich wird einmal der allgemeine Etikettentext gelesen.
       * Dieser Text wird ausschließlich lokal als Fingerabdruck
       * zur Erkennung desselben Etiketts verwendet.
       */
      const identityText =
        await readIdentityText(
          sourceCanvas,
          slotNumber
        );

      slot.identitySignature =
        createTextSignature(identityText);

      await configureCodeRecognition();

      if (slotNumber === 2) {
        const visualSimilarity =
          compareVisualSignatures(
            state.scan1.visualSignature,
            visualSignature
          );

        const textComparison =
          compareTextSignatures(
            state.scan1.identitySignature,
            slot.identitySignature
          );

        const decision =
          evaluateDuplicate(
            visualSimilarity,
            textComparison
          );

        appendDebug(
          "\nDOPPEL-SCAN-ENTSCHEIDUNG\n" +
          `Bildähnlichkeit: ${
            formatPercent(visualSimilarity)
          }\n` +
          `Textähnlichkeit: ${
            textComparison.available
              ? formatPercent(
                  textComparison.similarity
                )
              : "nicht ausreichend"
          }\n` +
          `Gemeinsame Kennungen: ${
            textComparison.commonStrong
          }\n` +
          `Ergebnis: ${
            decision.duplicate
              ? "BLOCKIERT"
              : "AKZEPTIERT"
          }\n` +
          `Grund: ${decision.reason}\n`
        );

        if (decision.duplicate) {
          blockSecondScan(
            decision.reason,
            {
              exactFile: false,
              visual: visualSimilarity,
              text:
                textComparison.available
                  ? textComparison.similarity
                  : null
            }
          );

          return;
        }
      }

      appendDebug(
        `\nERGEBNIS ETIKETT ${slotNumber}\n` +
        JSON.stringify(result, null, 2)
      );

      if (!result.code) {
        slot.code = null;

        info.textContent =
          "Keine gültige D-Nummer erkannt. " +
          "Erlaubt ist ausschließlich D direkt gefolgt " +
          "von neun Ziffern, zum Beispiel D562708020.";

        setStatus(
          `Auf Etikett ${slotNumber} wurde keine gültige D-Nummer gefunden.`,
          "error"
        );

        codeInput.focus();
        return;
      }

      slot.code = result.code;
      codeInput.value = result.code;
      confirmButton.disabled = false;

      info.textContent =
        `${result.votes} OCR-Prüfung(en) unterstützten diesen Wert. ` +
        "D und die neun Ziffern wurden ohne Zwischenraum erkannt.";

      setStatus(
        `Etikett ${slotNumber}: ${result.code} erkannt. ` +
        "Bitte kontrollieren und übernehmen.",
        "success"
      );
    } catch (error) {
      console.error(error);

      setStatus(
        error.message || String(error),
        "error"
      );

      info.textContent =
        "Foto erneut aufnehmen oder die D-Nummer " +
        "im Format D123456789 manuell eintragen.";
    }
  };


  async function configureCodeRecognition() {
    await state.worker.setParameters({
      tessedit_char_whitelist:
        CODE_WHITELIST,

      tessedit_pageseg_mode: "11",

      preserve_interword_spaces: "1",

      user_defined_dpi: "300"
    });
  }


  async function readIdentityText(
    sourceCanvas,
    slotNumber
  ) {
    try {
      setStatus(
        `Etikett ${slotNumber}: Etikettenidentität wird geprüft …`,
        "scanning"
      );

      await state.worker.setParameters({
        tessedit_char_whitelist:
          TEXT_WHITELIST,

        tessedit_pageseg_mode: "11",

        preserve_interword_spaces: "1",

        user_defined_dpi: "300"
      });

      const prepared =
        createPreparedCrop(
          sourceCanvas,
          {
            x: 0,
            y: 0,
            width: sourceCanvas.width,
            height: sourceCanvas.height
          },
          false
        );

      const recognition =
        await state.worker.recognize(prepared);

      const text =
        recognition?.data?.text || "";

      appendDebug(
        `\nIDENTITÄTSTEXT ETIKETT ${slotNumber}\n` +
        `${compactText(text)}\n`
      );

      return text;
    } catch (error) {
      appendDebug(
        `\nIdentitätstext nicht verfügbar: ${
          error.message || String(error)
        }\n`
      );

      return "";
    }
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


  function createVisualSignature(sourceCanvas) {
    const bounds =
      detectLabelBounds(sourceCanvas);

    const variants = [
      -7,
      0,
      7
    ].map(angle =>
      createVisualVariant(
        sourceCanvas,
        bounds,
        angle
      )
    );

    return {
      bounds,
      variants
    };
  }


  /*
   * Sucht im verkleinerten Bild nach der größten zusammenhängenden,
   * hellen und relativ farbneutralen Fläche.
   *
   * Dadurch wird möglichst das Etikett und nicht das gesamte
   * Kamerafoto miteinander verglichen.
   */
  function detectLabelBounds(sourceCanvas) {
    const analysisSize = 96;

    const canvas =
      document.createElement("canvas");

    canvas.width = analysisSize;
    canvas.height = analysisSize;

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
      analysisSize,
      analysisSize
    );

    const data =
      context.getImageData(
        0,
        0,
        analysisSize,
        analysisSize
      ).data;

    const luminances = [];
    const mask =
      new Uint8Array(
        analysisSize * analysisSize
      );

    for (
      let index = 0;
      index < data.length;
      index += 4
    ) {
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];

      const maximum =
        Math.max(red, green, blue);

      const minimum =
        Math.min(red, green, blue);

      const luminance =
        red * 0.299 +
        green * 0.587 +
        blue * 0.114;

      luminances.push(luminance);

      const saturation =
        maximum - minimum;

      mask[index / 4] =
        luminance >= 130 &&
        saturation <= 105
          ? 1
          : 0;
    }

    const dynamicThreshold =
      Math.max(
        120,
        percentileValue(
          luminances,
          58
        )
      );

    for (
      let pixel = 0;
      pixel < mask.length;
      pixel += 1
    ) {
      const dataIndex = pixel * 4;

      const red = data[dataIndex];
      const green = data[dataIndex + 1];
      const blue = data[dataIndex + 2];

      const luminance =
        red * 0.299 +
        green * 0.587 +
        blue * 0.114;

      const saturation =
        Math.max(red, green, blue) -
        Math.min(red, green, blue);

      mask[pixel] =
        luminance >= dynamicThreshold &&
        saturation <= 110
          ? 1
          : 0;
    }

    const visited =
      new Uint8Array(mask.length);

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
      let minX = analysisSize;
      let minY = analysisSize;
      let maxX = 0;
      let maxY = 0;

      while (stack.length) {
        const current =
          stack.pop();

        const x =
          current % analysisSize;

        const y =
          Math.floor(
            current / analysisSize
          );

        area += 1;

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);

        const neighbours = [
          current - 1,
          current + 1,
          current - analysisSize,
          current + analysisSize
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
            neighbour % analysisSize;

          if (
            Math.abs(neighbourX - x) > 1
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

      const rectangleArea =
        width * height;

      const rectangularity =
        area /
        Math.max(1, rectangleArea);

      const areaRatio =
        area /
        mask.length;

      if (
        areaRatio < 0.025 ||
        width < 18 ||
        height < 18
      ) {
        continue;
      }

      const centerX =
        (minX + maxX) / 2;

      const centerY =
        (minY + maxY) / 2;

      const centerDistance =
        Math.hypot(
          centerX - analysisSize / 2,
          centerY - analysisSize / 2
        ) /
        (analysisSize * 0.71);

      const centerFactor =
        1.15 -
        Math.min(1, centerDistance) * 0.25;

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
      best.areaRatio > 0.92
    ) {
      return {
        x: 0,
        y: 0,
        width: sourceCanvas.width,
        height: sourceCanvas.height
      };
    }

    const padding = 4;

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
        analysisSize - 1,
        best.maxX + padding
      );

    const maxY =
      Math.min(
        analysisSize - 1,
        best.maxY + padding
      );

    return {
      x:
        minX /
        analysisSize *
        sourceCanvas.width,

      y:
        minY /
        analysisSize *
        sourceCanvas.height,

      width:
        (maxX - minX + 1) /
        analysisSize *
        sourceCanvas.width,

      height:
        (maxY - minY + 1) /
        analysisSize *
        sourceCanvas.height
    };
  }


  function createVisualVariant(
    sourceCanvas,
    bounds,
    angle
  ) {
    const normalizedSize = 192;

    const normalized =
      document.createElement("canvas");

    normalized.width = normalizedSize;
    normalized.height = normalizedSize;

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

      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,

      -normalizedSize / 2,
      -normalizedSize / 2,
      normalizedSize,
      normalizedSize
    );

    context.restore();

    const sampleSize = 32;

    const sample =
      document.createElement("canvas");

    sample.width = sampleSize;
    sample.height = sampleSize;

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

    const imageData =
      sampleContext.getImageData(
        0,
        0,
        sampleSize,
        sampleSize
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
            y * sampleSize + x
          ];

        const right =
          normalizedGray[
            y * sampleSize + x + 1
          ];

        differenceHash +=
          left > right
            ? "1"
            : "0";
      }
    }

    const edges =
      new Array(
        sampleSize * sampleSize
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
          y * sampleSize + x;

        const horizontal =
          normalizedGray[index + 1] -
          normalizedGray[index - 1];

        const vertical =
          normalizedGray[
            index + sampleSize
          ] -
          normalizedGray[
            index - sampleSize
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

    const rowProfile =
      new Array(sampleSize).fill(0);

    const columnProfile =
      new Array(sampleSize).fill(0);

    for (
      let y = 0;
      y < sampleSize;
      y += 1
    ) {
      for (
        let x = 0;
        x < sampleSize;
        x += 1
      ) {
        const value =
          edges[
            y * sampleSize + x
          ];

        rowProfile[y] += value;
        columnProfile[x] += value;
      }
    }

    const histogram =
      new Array(16).fill(0);

    for (const value of normalizedGray) {
      const bin =
        Math.min(
          15,
          Math.floor(value * 16)
        );

      histogram[bin] += 1;
    }

    const total =
      normalizedGray.length;

    return {
      grayscale: normalizedGray,
      averageHash,
      differenceHash,
      edgeHash,

      rowProfile:
        normalizeVector(rowProfile),

      columnProfile:
        normalizeVector(columnProfile),

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
    if (
      !first?.variants ||
      !second?.variants
    ) {
      return 0;
    }

    let best = 0;

    for (
      const firstVariant
      of first.variants
    ) {
      for (
        const secondVariant
        of second.variants
      ) {
        best =
          Math.max(
            best,
            compareVisualVariants(
              firstVariant,
              secondVariant
            )
          );
      }
    }

    return best;
  }


  function compareVisualVariants(
    first,
    second
  ) {
    const grayscaleSimilarity =
      bestShiftedCorrelation(
        first.grayscale,
        second.grayscale,
        32,
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

    const profileSimilarity =
      (
        cosineSimilarity(
          first.rowProfile,
          second.rowProfile
        ) +
        cosineSimilarity(
          first.columnProfile,
          second.columnProfile
        )
      ) / 2;

    const histogramSimilarity =
      histogramIntersection(
        first.histogram,
        second.histogram
      );

    return (
      grayscaleSimilarity * 0.31 +
      averageHashSimilarity * 0.12 +
      differenceHashSimilarity * 0.15 +
      edgeHashSimilarity * 0.21 +
      profileSimilarity * 0.13 +
      histogramSimilarity * 0.08
    );
  }


  function bestShiftedCorrelation(
    first,
    second,
    width,
    maximumShift
  ) {
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
        const firstValues = [];
        const secondValues = [];

        for (
          let y = 0;
          y < width;
          y += 1
        ) {
          const otherY =
            y + shiftY;

          if (
            otherY < 0 ||
            otherY >= width
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

            firstValues.push(
              first[
                y * width + x
              ]
            );

            secondValues.push(
              second[
                otherY * width +
                otherX
              ]
            );
          }
        }

        best =
          Math.max(
            best,
            pearsonSimilarity(
              firstValues,
              secondValues
            )
          );
      }
    }

    return best;
  }


  function pearsonSimilarity(
    first,
    second
  ) {
    if (
      !first.length ||
      first.length !== second.length
    ) {
      return 0;
    }

    const firstMean =
      first.reduce(
        (sum, value) =>
          sum + value,
        0
      ) /
      first.length;

    const secondMean =
      second.reduce(
        (sum, value) =>
          sum + value,
        0
      ) /
      second.length;

    let numerator = 0;
    let firstVariance = 0;
    let secondVariance = 0;

    for (
      let index = 0;
      index < first.length;
      index += 1
    ) {
      const firstDelta =
        first[index] - firstMean;

      const secondDelta =
        second[index] - secondMean;

      numerator +=
        firstDelta * secondDelta;

      firstVariance +=
        firstDelta * firstDelta;

      secondVariance +=
        secondDelta * secondDelta;
    }

    const denominator =
      Math.sqrt(
        firstVariance *
        secondVariance
      );

    if (!denominator) {
      return 0;
    }

    const correlation =
      numerator / denominator;

    return Math.max(
      0,
      Math.min(
        1,
        (correlation + 1) / 2
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

    return equal / first.length;
  }


  function normalizeVector(vector) {
    const magnitude =
      Math.sqrt(
        vector.reduce(
          (sum, value) =>
            sum + value * value,
          0
        )
      );

    if (!magnitude) {
      return vector.map(() => 0);
    }

    return vector.map(
      value =>
        value / magnitude
    );
  }


  function cosineSimilarity(
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

    let dot = 0;

    for (
      let index = 0;
      index < first.length;
      index += 1
    ) {
      dot +=
        first[index] *
        second[index];
    }

    return Math.max(
      0,
      Math.min(1, dot)
    );
  }


  function histogramIntersection(
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

    let intersection = 0;

    for (
      let index = 0;
      index < first.length;
      index += 1
    ) {
      intersection += Math.min(
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
    const cleaned =
      String(text || "")
        .toUpperCase()
        .replace(
          /(?:^|[^A-Z0-9])D[0-9]{9}(?![A-Z0-9])/g,
          " "
        )
        .replace(/[^A-Z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (!cleaned) {
      return {
        tokens: [],
        strongTokens: []
      };
    }

    const tokens =
      [...new Set(
        cleaned
          .split(" ")
          .filter(token =>
            token.length >= 3 ||
            /^[0-9]{4,}$/.test(token)
          )
      )];

    const strongTokens =
      tokens.filter(token =>
        /^[0-9]{4,}$/.test(token) ||
        (
          /[A-Z]/.test(token) &&
          /[0-9]/.test(token)
        ) ||
        token.length >= 7
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
      new Set(first?.tokens || []);

    const secondTokens =
      new Set(second?.tokens || []);

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

    const secondStrong =
      new Set(
        second?.strongTokens || []
      );

    const commonStrong =
      (first?.strongTokens || [])
        .filter(token =>
          secondStrong.has(token)
        )
        .length;

    return {
      available: true,

      similarity:
        commonWeight /
        Math.max(1, unionWeight),

      commonStrong
    };
  }


  function tokenWeight(token) {
    if (/^[0-9]{4,}$/.test(token)) {
      return 4;
    }

    if (
      /[A-Z]/.test(token) &&
      /[0-9]/.test(token)
    ) {
      return 3;
    }

    if (GENERIC_WORDS.has(token)) {
      return 0.35;
    }

    if (token.length >= 7) {
      return 1.6;
    }

    return 1;
  }


  function evaluateDuplicate(
    visual,
    textComparison
  ) {
    if (
      visual >=
      LIMITS.almostIdenticalVisual
    ) {
      return {
        duplicate: true,
        reason:
          "Der Bildaufbau entspricht nahezu vollständig Etikett 1."
      };
    }

    if (
      textComparison.available &&
      textComparison.similarity >=
        LIMITS.strongTextSimilarity &&
      visual >=
        LIMITS.minimumVisualWithStrongText
    ) {
      return {
        duplicate: true,
        reason:
          "Bild und Begleittexte entsprechen sehr wahrscheinlich erneut Etikett 1."
      };
    }

    if (
      textComparison.available &&
      textComparison.similarity >=
        LIMITS.mediumTextSimilarity &&
      visual >=
        LIMITS.minimumVisualWithMediumText
    ) {
      return {
        duplicate: true,
        reason:
          "Die Kombination aus Bildstruktur und Etikettentext ist zu ähnlich."
      };
    }

    if (
      textComparison.available &&
      textComparison.commonStrong >= 2 &&
      visual >=
        LIMITS.minimumVisualWithCommonIdentifiers
    ) {
      return {
        duplicate: true,
        reason:
          "Mehrere eindeutige Kennungen und der Bildaufbau stimmen mit Etikett 1 überein."
      };
    }

    /*
     * Fail-closed:
     * Steht nicht genug OCR-Text zur Verfügung, muss das Bild
     * sich deutlich unterscheiden. Andernfalls wird es blockiert.
     */
    if (
      !textComparison.available &&
      visual >=
        LIMITS.minimumVisualWithoutText
    ) {
      return {
        duplicate: true,
        reason:
          "Die Anwendung kann nicht sicher bestätigen, dass dies ein anderes Etikett ist. Der zweite Scan wird vorsorglich abgelehnt."
      };
    }

    return {
      duplicate: false,
      reason:
        "Etikett 2 unterscheidet sich ausreichend von Etikett 1."
    };
  }


  function blockSecondScan(
    reason,
    metrics
  ) {
    revokePreview(state.scan2);

    state.scan2.code = null;
    state.scan2.confirmed = false;
    state.scan2.hash = null;
    state.scan2.previewUrl = null;
    state.scan2.fileDigest = null;
    state.scan2.visualSignature = null;
    state.scan2.identitySignature = null;

    elements.preview2.src = "";

    elements.preview2.classList.remove(
      "visible"
    );

    elements.placeholder2.classList.remove(
      "hidden"
    );

    elements.code2.value = "";
    elements.code2.disabled = false;
    elements.confirm2.disabled = true;

    elements.ocrInfo2.textContent =
      "Der zweite Scan wurde vollständig verworfen. " +
      "Bitte fotografiere das andere Etikett.";

    setStatus(
      "Doppelter Scan verhindert: " +
      reason,
      "error"
    );

    appendDebug(
      "\nDOPPEL-SCAN BLOCKIERT\n" +
      `Grund: ${reason}\n` +
      `Identische Datei: ${
        metrics?.exactFile
          ? "ja"
          : "nein"
      }\n` +
      `Bildähnlichkeit: ${
        metrics?.visual == null
          ? "nicht verfügbar"
          : formatPercent(
              metrics.visual
            )
      }\n` +
      `Textähnlichkeit: ${
        metrics?.text == null
          ? "nicht verfügbar"
          : formatPercent(
              metrics.text
            )
      }\n`
    );

    navigator.vibrate?.([
      200,
      80,
      200
    ]);
  }


  function percentileValue(
    values,
    percentile
  ) {
    if (!values.length) {
      return 0;
    }

    const sorted =
      [...values]
        .sort(
          (first, second) =>
            first - second
        );

    const index =
      Math.max(
        0,
        Math.min(
          sorted.length - 1,
          Math.round(
            percentile /
            100 *
            (sorted.length - 1)
          )
        )
      );

    return sorted[index];
  }


  function formatPercent(value) {
    if (
      value == null ||
      !Number.isFinite(value)
    ) {
      return "—";
    }

    return `${
      Math.round(value * 100)
    } %`;
  }

  appendDebug(
    `\nDoppel-Scan-Schutz ${FIX_VERSION} geladen.\n`
  );
})();
