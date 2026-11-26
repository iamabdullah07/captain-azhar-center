import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_QR_GENERATOR_PREFS,
  loadHomeSection,
  loadQrGeneratorPrefs,
  saveHomeSection,
  saveQrGeneratorPrefs,
} from '../src/lib/homePrefs';

function installMockWebStorage() {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => local.set(k, v),
      removeItem: (k: string) => local.delete(k),
      clear: () => local.clear(),
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => session.set(k, v),
      removeItem: (k: string) => session.delete(k),
      clear: () => session.clear(),
    },
    configurable: true,
  });
  return { local, session };
}

describe('Home Section & Section 1 QR Preferences Persistence', () => {
  beforeEach(() => {
    installMockWebStorage();
  });

  it('persists and restores active section (generate, edit-file, extract-data) across reloads', () => {
    expect(loadHomeSection()).toBe('generate');

    saveHomeSection('edit-file');
    expect(loadHomeSection()).toBe('edit-file');

    saveHomeSection('extract-data');
    expect(loadHomeSection()).toBe('extract-data');

    // Valid URL query param takes precedence and updates persisted state
    expect(loadHomeSection('edit-file')).toBe('edit-file');
    expect(loadHomeSection()).toBe('edit-file');

    // Invalid URL param falls back to persisted section
    expect(loadHomeSection('unknown-section')).toBe('edit-file');
  });

  it('persists Section 1 QR generator settings including sizePx=200, activeTab, ecl, colors, safeMargin', () => {
    expect(loadQrGeneratorPrefs()).toEqual(DEFAULT_QR_GENERATOR_PREFS);

    saveQrGeneratorPrefs({
      activeTab: 'image',
      sizePx: 200,
      ecl: 'H',
      fgColor: '#112233',
      bgColor: '#fafafa',
      safeMargin: false,
    });

    expect(loadQrGeneratorPrefs()).toEqual({
      activeTab: 'image',
      sizePx: 200,
      ecl: 'H',
      fgColor: '#112233',
      bgColor: '#FAFAFA',
      safeMargin: false,
    });

    // Partial/invalid hex while typing does not overwrite previously saved valid color
    saveQrGeneratorPrefs({
      activeTab: 'document',
      sizePx: 200,
      ecl: 'Q',
      fgColor: '#12',
      bgColor: '#FAFAFA',
      safeMargin: true,
    });

    expect(loadQrGeneratorPrefs()).toEqual({
      activeTab: 'document',
      sizePx: 200,
      ecl: 'Q',
      fgColor: '#112233',
      bgColor: '#FAFAFA',
      safeMargin: true,
    });
  });

  it('falls back to safe defaults if stored QR prefs JSON is corrupted', () => {
    localStorage.setItem('cac_qr_generator_prefs_v1', '{bad-json');
    expect(loadQrGeneratorPrefs()).toEqual(DEFAULT_QR_GENERATOR_PREFS);
  });
});
