import { describe, expect, it } from 'vitest';
import {
  findDuplicateIdNumbers,
  formatColumnCopyText,
  formatCompactTokenCount,
  formatElapsedTimer,
  formatRowCopyText,
  getQuotaTubeTone,
  loadExtractModelPrefs,
  saveExtractModelPrefs,
} from '../src/lib/extractHelpers';
import { validateExtractFile } from '../src/lib/fileCheck';

describe('Phase 2-4 Frontend Extract Helpers & Validation', () => {
  it('validates supported file formats and size limits cleanly', () => {
    const okImg = new File([new Uint8Array(100)], 'passport.jpg', { type: 'image/jpeg' });
    expect(validateExtractFile(okImg, 50)).toEqual({ ok: true, ext: 'jpg' });

    const okHeic = new File([new Uint8Array(100)], 'id.heic', { type: 'image/heic' });
    expect(validateExtractFile(okHeic, 50)).toEqual({ ok: true, ext: 'heic' });

    const okZip = new File([new Uint8Array(100)], 'docs.zip', { type: 'application/zip' });
    expect(validateExtractFile(okZip, 50)).toEqual({ ok: true, ext: 'zip' });

    const okDocx = new File([new Uint8Array(100)], 'list.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(validateExtractFile(okDocx, 50)).toEqual({ ok: true, ext: 'docx' });

    const badExe = new File([new Uint8Array(100)], 'virus.exe', { type: 'application/octet-stream' });
    expect(validateExtractFile(badExe, 50).ok).toBe(false);

    const bigPdf = new File([new Uint8Array(10)], 'huge.pdf', { type: 'application/pdf' });
    Object.defineProperty(bigPdf, 'size', { value: 55 * 1024 * 1024 });
    expect(validateExtractFile(bigPdf, 50).ok).toBe(false);
  });

  it('formats live timer, vertical column copy, horizontal row copy, and duplicate IDs', () => {
    expect(formatElapsedTimer(0)).toBe('0:00');
    expect(formatElapsedTimer(9400)).toBe('0:09');
    expect(formatElapsedTimer(125000)).toBe('2:05');

    const rows = [
      { name: 'ALI KHAN', idNumber: 'AB123456', nationality: 'PAKISTANI' },
      { name: null, idNumber: 'CD998877', nationality: 'INDIAN' },
      { name: 'ZAINAB', idNumber: 'AB123456', nationality: null },
    ];

    expect(formatColumnCopyText(rows, 'name')).toBe('ALI KHAN\n-\nZAINAB');
    expect(formatColumnCopyText(rows, 'idNumber')).toBe('AB123456\nCD998877\nAB123456');
    expect(formatColumnCopyText(rows, 'nationality')).toBe('PAKISTANI\nINDIAN\n-');

    expect(formatRowCopyText(rows[0])).toBe('ALI KHAN\tAB123456\tPAKISTANI');
    expect(formatRowCopyText(rows[1])).toBe('-\tCD998877\tINDIAN');

    const dups = findDuplicateIdNumbers(rows);
    expect(dups.has('AB123456')).toBe(true);
    expect(dups.has('CD998877')).toBe(false);
  });

  it('persists and restores model preferences cleanly', () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
      },
      configurable: true,
    });

    expect(loadExtractModelPrefs()).toEqual({ selectedModel: 'auto', allowFallback: false });
    saveExtractModelPrefs({ selectedModel: 'gemini-3.6-flash', allowFallback: true });
    expect(loadExtractModelPrefs()).toEqual({
      selectedModel: 'gemini-3.6-flash',
      allowFallback: true,
    });
  });

  it('formats compact token counts and computes green/yellow/red quota tube colors', () => {
    expect(formatCompactTokenCount(0)).toBe('0');
    expect(formatCompactTokenCount(850)).toBe('850');
    expect(formatCompactTokenCount(1520)).toBe('1.5K');
    expect(formatCompactTokenCount(998500)).toBe('999K');
    expect(formatCompactTokenCount(1000000)).toBe('1M');

    expect(getQuotaTubeTone(100, 'ready').tone).toBe('green');
    expect(getQuotaTubeTone(51, 'ready').tone).toBe('green');
    expect(getQuotaTubeTone(50, 'ready').tone).toBe('yellow');
    expect(getQuotaTubeTone(21, 'ready').tone).toBe('yellow');
    expect(getQuotaTubeTone(20, 'ready').tone).toBe('red');
    expect(getQuotaTubeTone(0, 'cooldown').tone).toBe('red');
  });
});
