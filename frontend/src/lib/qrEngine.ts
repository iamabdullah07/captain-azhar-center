import QRCode from 'qrcode';
import jsQR from 'jsqr';

export type QrSizeOption = 200 | 300 | 500 | 700 | 1000 | 1500 | 2100;
export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export const QR_SIZE_OPTIONS: Array<{ value: QrSizeOption; label: string }> = [
  { value: 200, label: '200 × 200 px — Small' },
  { value: 300, label: '300 × 300 px — Medium' },
  { value: 500, label: '500 × 500 px — Large' },
  { value: 700, label: '700 × 700 px — Extra Large' },
  { value: 1000, label: '1000 × 1000 px — High Res' },
  { value: 1500, label: '1500 × 1500 px — Poster' },
  { value: 2100, label: '2100 × 2100 px — Print Ultra' },
];

export const QR_ECL_OPTIONS: Array<{ value: QrErrorCorrection; label: string }> = [
  { value: 'L', label: 'Low (L) — 7% recovery' },
  { value: 'M', label: 'Medium (M) — recommended' },
  { value: 'Q', label: 'Quartile (Q) — 25% recovery' },
  { value: 'H', label: 'High (H) — 30% recovery' },
];

export interface ContrastCheckResult {
  ratio: number;
  isLightOnDark: boolean;
  isBlocked: boolean;
  isWarning: boolean;
  message: string;
}

function parseHexRgb(hex: string): [number, number, number] | null {
  const clean = hex.trim();
  const match = clean.match(/^#([0-9a-fA-F]{6})$/);
  if (!match) return null;
  const num = Number.parseInt(match[1], 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function srgbChannelLuminance(c8: number): number {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function getRelativeLuminance(hex: string): number | null {
  const rgb = parseHexRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  return (
    0.2126 * srgbChannelLuminance(r) +
    0.7152 * srgbChannelLuminance(g) +
    0.0722 * srgbChannelLuminance(b)
  );
}

export function evaluateQrContrast(fgHex: string, bgHex: string): ContrastCheckResult {
  const lFg = getRelativeLuminance(fgHex);
  const lBg = getRelativeLuminance(bgHex);

  if (lFg === null || lBg === null) {
    return {
      ratio: 1,
      isLightOnDark: false,
      isBlocked: true,
      isWarning: false,
      message: 'Please enter valid 6-digit hex colors (e.g. #0A1832 and #FFFFFF).',
    };
  }

  const isLightOnDark = lFg >= lBg;
  const lighter = Math.max(lFg, lBg);
  const darker = Math.min(lFg, lBg);
  const ratio = Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));

  if (isLightOnDark) {
    return {
      ratio,
      isLightOnDark: true,
      isBlocked: true,
      isWarning: false,
      message: 'Foreground must be darker than background so phone cameras can scan reliably.',
    };
  }

  if (ratio < 4.0) {
    return {
      ratio,
      isLightOnDark: false,
      isBlocked: true,
      isWarning: false,
      message: `Contrast ratio (${ratio}:1) is too low. Must be at least 4.0:1 to scan reliably.`,
    };
  }

  if (ratio < 4.5) {
    return {
      ratio,
      isLightOnDark: false,
      isBlocked: false,
      isWarning: true,
      message: `Contrast ratio (${ratio}:1) is borderline. Darker foreground on white is recommended.`,
    };
  }

  return {
    ratio,
    isLightOnDark: false,
    isBlocked: false,
    isWarning: false,
    message: `Great contrast (${ratio}:1) — easy to scan on all phones.`,
  };
}

export interface GeneratedQrAssets {
  shortUrl: string;
  sizePx: QrSizeOption;
  requestedEcl: QrErrorCorrection;
  effectiveEcl: QrErrorCorrection;
  effectiveMargin: boolean;
  autoAdjusted: boolean;
  verified: boolean;
  moduleCount: number;
  pngDataUrl: string;
  jpgDataUrl: string;
  svgString: string;
  matrix: boolean[][];
  fgColor: string;
  bgColor: string;
}

function buildMatrixGrid(text: string, ecl: QrErrorCorrection): boolean[][] {
  const qr = QRCode.create(text, { errorCorrectionLevel: ecl });
  const size = qr.modules.size;
  const grid: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) {
      row.push(Boolean(qr.modules.get(r, c)));
    }
    grid.push(row);
  }
  return grid;
}

function renderMatrixToCanvas(params: {
  matrix: boolean[][];
  targetSizePx: number;
  quietZoneModules: number;
  fgColor: string;
  bgColor: string;
}): HTMLCanvasElement {
  const { matrix, targetSizePx, quietZoneModules, fgColor, bgColor } = params;
  const canvas = document.createElement('canvas');
  canvas.width = targetSizePx;
  canvas.height = targetSizePx;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable.');

  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, targetSizePx, targetSizePx);

  const n = matrix.length;
  const totalModules = n + quietZoneModules * 2;
  const modulePx = Math.max(1, Math.floor(targetSizePx / totalModules));
  const drawnSize = modulePx * totalModules;
  const offset = Math.floor((targetSizePx - drawnSize) / 2);

  ctx.fillStyle = fgColor;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) {
        const x = offset + (c + quietZoneModules) * modulePx;
        const y = offset + (r + quietZoneModules) * modulePx;
        ctx.fillRect(x, y, modulePx, modulePx);
      }
    }
  }
  return canvas;
}

function buildCrispSvg(params: {
  matrix: boolean[][];
  sizePx: number;
  quietZoneModules: number;
  fgColor: string;
  bgColor: string;
}): string {
  const { matrix, sizePx, quietZoneModules, fgColor, bgColor } = params;
  const n = matrix.length;
  const total = n + quietZoneModules * 2;
  const paths: string[] = [];

  for (let r = 0; r < n; r++) {
    let runStart = -1;
    for (let c = 0; c <= n; c++) {
      const dark = c < n && matrix[r][c];
      if (dark && runStart === -1) {
        runStart = c;
      } else if (!dark && runStart !== -1) {
        const len = c - runStart;
        const x = runStart + quietZoneModules;
        const y = r + quietZoneModules;
        paths.push(`M${x},${y}h${len}v1h-${len}z`);
        runStart = -1;
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`,
    `<rect width="${total}" height="${total}" fill="${bgColor}"/>`,
    `<path d="${paths.join('')}" fill="${fgColor}"/>`,
    `</svg>`,
  ].join('');
}

function verifyCanvasWithJsQr(canvas: HTMLCanvasElement, expectedText: string): boolean {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const decoded = jsQR(imgData.data, imgData.width, imgData.height, {
    inversionAttempts: 'dontInvert',
  });
  return Boolean(decoded && decoded.data === expectedText);
}

/**
 * Generates crisp pixel-aligned QR PNG, JPG, and SVG, and runs a jsQR decode self-check.
 * Automatically steps up error correction or quiet zone if jsQR decode fails.
 */
export function generateVerifiedQr(params: {
  shortUrl: string;
  sizePx: QrSizeOption;
  errorCorrection: QrErrorCorrection;
  fgColor: string;
  bgColor: string;
  safeMargin: boolean;
}): GeneratedQrAssets {
  const contrast = evaluateQrContrast(params.fgColor, params.bgColor);
  if (contrast.isBlocked) {
    throw new Error(contrast.message);
  }

  const eclOrder: QrErrorCorrection[] = ['L', 'M', 'Q', 'H'];
  const startIdx = eclOrder.indexOf(params.errorCorrection);
  const attempts: Array<{ ecl: QrErrorCorrection; margin: boolean }> = [];

  for (let i = startIdx; i < eclOrder.length; i++) {
    attempts.push({ ecl: eclOrder[i], margin: params.safeMargin });
  }
  if (!params.safeMargin) {
    attempts.push({ ecl: 'H', margin: true });
  }

  let chosen = attempts[0];
  let chosenMatrix = buildMatrixGrid(params.shortUrl, chosen.ecl);
  let chosenCanvas = renderMatrixToCanvas({
    matrix: chosenMatrix,
    targetSizePx: params.sizePx,
    quietZoneModules: chosen.margin ? 4 : 0,
    fgColor: params.fgColor,
    bgColor: params.bgColor,
  });
  let verified = false;

  for (const attempt of attempts) {
    const matrix = buildMatrixGrid(params.shortUrl, attempt.ecl);
    const qz = attempt.margin ? 4 : 0;

    // For very large export canvases (1500/2100), verify via crisp integer 500px check + target canvas
    const checkSize = params.sizePx > 1000 ? 500 : params.sizePx;
    const checkCanvas = renderMatrixToCanvas({
      matrix,
      targetSizePx: checkSize,
      quietZoneModules: qz,
      fgColor: params.fgColor,
      bgColor: params.bgColor,
    });

    if (verifyCanvasWithJsQr(checkCanvas, params.shortUrl)) {
      chosen = attempt;
      chosenMatrix = matrix;
      chosenCanvas =
        checkSize === params.sizePx
          ? checkCanvas
          : renderMatrixToCanvas({
              matrix,
              targetSizePx: params.sizePx,
              quietZoneModules: qz,
              fgColor: params.fgColor,
              bgColor: params.bgColor,
            });
      verified = true;
      break;
    }
  }

  const pngDataUrl = chosenCanvas.toDataURL('image/png');
  const jpgDataUrl = chosenCanvas.toDataURL('image/jpeg', 0.96);
  const svgString = buildCrispSvg({
    matrix: chosenMatrix,
    sizePx: params.sizePx,
    quietZoneModules: chosen.margin ? 4 : 0,
    fgColor: params.fgColor,
    bgColor: params.bgColor,
  });

  return {
    shortUrl: params.shortUrl,
    sizePx: params.sizePx,
    requestedEcl: params.errorCorrection,
    effectiveEcl: chosen.ecl,
    effectiveMargin: chosen.margin,
    autoAdjusted: chosen.ecl !== params.errorCorrection || chosen.margin !== params.safeMargin,
    verified,
    moduleCount: chosenMatrix.length,
    pngDataUrl,
    jpgDataUrl,
    svgString,
    matrix: chosenMatrix,
    fgColor: params.fgColor,
    bgColor: params.bgColor,
  };
}

/** Exports the QR code as an infinite-resolution vector PDF. */
export async function downloadQrAsPdf(
  assets: GeneratedQrAssets,
  filenameBase = 'captain-azhar-qr'
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const qrBlockMm = 120;
  const quietZone = assets.effectiveMargin ? 4 : 0;
  const totalModules = assets.moduleCount + quietZone * 2;
  const modMm = qrBlockMm / totalModules;
  const startX = (pageWidth - qrBlockMm) / 2;
  const startY = 42;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor('#0A1832');
  doc.text('Captain Azhar Center — QR Code Service', pageWidth / 2, 24, { align: 'center' });

  doc.setFillColor(assets.bgColor);
  doc.rect(startX, startY, qrBlockMm, qrBlockMm, 'F');

  doc.setFillColor(assets.fgColor);
  for (let r = 0; r < assets.moduleCount; r++) {
    for (let c = 0; c < assets.moduleCount; c++) {
      if (assets.matrix[r][c]) {
        doc.rect(
          startX + (c + quietZone) * modMm,
          startY + (r + quietZone) * modMm,
          modMm + 0.02,
          modMm + 0.02,
          'F'
        );
      }
    }
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor('#475569');
  doc.text(`Scan Link: ${assets.shortUrl}`, pageWidth / 2, startY + qrBlockMm + 14, {
    align: 'center',
  });
  doc.text(
    `Resolution preset: ${assets.sizePx} × ${assets.sizePx} px  |  Error Correction: ${assets.effectiveEcl}`,
    pageWidth / 2,
    startY + qrBlockMm + 21,
    { align: 'center' }
  );

  doc.save(`${filenameBase}-${assets.sizePx}px.pdf`);
}
