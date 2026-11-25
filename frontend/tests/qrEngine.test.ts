import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { evaluateQrContrast } from '../src/lib/qrEngine';
import { validateSelectedFile, validateUrlInput } from '../src/lib/fileCheck';

describe('QR Contrast & Input Validation', () => {
  it('blocks low contrast and inverted light-on-dark QR color combinations', () => {
    const good = evaluateQrContrast('#0A1832', '#FFFFFF');
    expect(good.isBlocked).toBe(false);
    expect(good.ratio).toBeGreaterThan(14);

    const low = evaluateQrContrast('#94A3B8', '#FFFFFF');
    expect(low.isBlocked).toBe(true);

    const inverted = evaluateQrContrast('#FFFFFF', '#0A1832');
    expect(inverted.isBlocked).toBe(true);
    expect(inverted.isLightOnDark).toBe(true);
  });

  it('validates file types and URL schemes strictly on the client', () => {
    expect(validateUrlInput('https://example.com/test').ok).toBe(true);
    expect(validateUrlInput('javascript:alert(1)').ok).toBe(false);

    const fakeSvg = new File(['<svg></svg>'], 'icon.svg', { type: 'image/svg+xml' });
    expect(validateSelectedFile(fakeSvg, 'image').ok).toBe(false);

    const validXlsx = new File([new Uint8Array(100)], 'budget.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(validateSelectedFile(validXlsx, 'document').ok).toBe(true);

    const validPptx = new File([new Uint8Array(100)], 'deck.pptx');
    expect(validateSelectedFile(validPptx, 'document').ok).toBe(true);
  });

  it('produces pixel-exact QR modules that decode cleanly with jsQR at 200px and 500px', () => {
    const shortUrl = 'https://captain-azhar.workers.dev/f/AbC123xYz';
    const qr = QRCode.create(shortUrl, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const quietZone = 4;
    const total = n + quietZone * 2;

    for (const targetPx of [200, 500]) {
      const modPx = Math.max(1, Math.floor(targetPx / total));
      const drawn = modPx * total;
      const offset = Math.floor((targetPx - drawn) / 2);

      const rgba = new Uint8ClampedArray(targetPx * targetPx * 4);
      rgba.fill(255); // white background

      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (!qr.modules.get(r, c)) continue;
          const x0 = offset + (c + quietZone) * modPx;
          const y0 = offset + (r + quietZone) * modPx;
          for (let dy = 0; dy < modPx; dy++) {
            for (let dx = 0; dx < modPx; dx++) {
              const idx = ((y0 + dy) * targetPx + (x0 + dx)) * 4;
              rgba[idx] = 10;     // #0A1832
              rgba[idx + 1] = 24;
              rgba[idx + 2] = 50;
              rgba[idx + 3] = 255;
            }
          }
        }
      }

      const decoded = jsQR(rgba, targetPx, targetPx, { inversionAttempts: 'dontInvert' });
      expect(decoded).not.toBeNull();
      expect(decoded?.data).toBe(shortUrl);
    }
  });
});
