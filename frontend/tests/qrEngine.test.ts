import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import {
  buildMatrixGrid,
  buildQrPixelBuffer,
  evaluateQrContrast,
  verifyTransparentBufferOnLightBg,
} from '../src/lib/qrEngine';
import { validateSelectedFile, validateUrlInput } from '../src/lib/fileCheck';

describe('QR Contrast, Validation & Transparent PNG Decoding', () => {
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

  it('produces pixel-exact normal QR buffers that decode cleanly with jsQR at 200px and 500px', () => {
    const shortUrl = 'https://captain-azhar-center.kashaf-hub.workers.dev/f/AbC123xYz';
    const matrix = buildMatrixGrid(shortUrl, 'M');

    for (const targetPx of [200, 500]) {
      const buf = buildQrPixelBuffer({
        matrix,
        targetSizePx: targetPx,
        quietZoneModules: 4,
        fgColor: '#0A1832',
        bgColor: '#FFFFFF',
      });

      expect(buf.width).toBe(targetPx);
      expect(buf.height).toBe(targetPx);

      const decoded = jsQR(buf.data, buf.width, buf.height, { inversionAttempts: 'dontInvert' });
      expect(decoded).not.toBeNull();
      expect(decoded?.data).toBe(shortUrl);
    }
  });

  it('generates zero-margin transparent QR buffer that decodes cleanly with jsQR on a light background', () => {
    const shortUrl = 'https://captain-azhar-center.kashaf-hub.workers.dev/f/AbC123xYz';
    const matrix = buildMatrixGrid(shortUrl, 'M');

    const transBuf = buildQrPixelBuffer({
      matrix,
      targetSizePx: 300,
      quietZoneModules: 0,
      fgColor: '#0A1832',
      bgColor: null,
      tightTransparent: true,
    });

    // Top-left corner (0,0) is always a dark finder module -> opaque #0A1832
    expect(transBuf.data[0]).toBe(10);
    expect(transBuf.data[1]).toBe(24);
    expect(transBuf.data[2]).toBe(50);
    expect(transBuf.data[3]).toBe(255);

    // Verify there are truly transparent (alpha=0) pixels in the buffer and no white background pixels
    let transparentCount = 0;
    let whiteBgCount = 0;
    for (let i = 0; i < transBuf.data.length; i += 4) {
      if (transBuf.data[i + 3] === 0) transparentCount++;
      if (transBuf.data[i] === 255 && transBuf.data[i + 1] === 255 && transBuf.data[i + 2] === 255) {
        whiteBgCount++;
      }
    }
    expect(transparentCount).toBeGreaterThan(0);
    expect(whiteBgCount).toBe(0);

    // Without white padding, raw transparent pixels have R=G=B=0 (cannot scan),
    // but placed on a light background with quiet margin, jsQR decodes accurately!
    expect(verifyTransparentBufferOnLightBg(transBuf, shortUrl, 24)).toBe(true);
  });
});
