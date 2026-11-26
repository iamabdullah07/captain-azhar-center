import type { InputTab } from './fileCheck';
import {
  QR_ECL_OPTIONS,
  QR_SIZE_OPTIONS,
  type QrErrorCorrection,
  type QrSizeOption,
} from './qrEngine';

export type HomeSection = 'generate' | 'edit-file' | 'extract-data';

export const HOME_SECTION_STORAGE_KEY = 'cac_home_section_v1';
export const QR_GENERATOR_PREFS_STORAGE_KEY = 'cac_qr_generator_prefs_v1';

const VALID_HOME_SECTIONS = new Set<HomeSection>(['generate', 'edit-file', 'extract-data']);
const VALID_INPUT_TABS = new Set<InputTab>(['link', 'image', 'document', 'video']);
const VALID_SIZES = new Set<number>(QR_SIZE_OPTIONS.map((o) => o.value));
const VALID_ECLS = new Set<string>(QR_ECL_OPTIONS.map((o) => o.value));
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export interface QrGeneratorPrefs {
  activeTab: InputTab;
  sizePx: QrSizeOption;
  ecl: QrErrorCorrection;
  fgColor: string;
  bgColor: string;
  safeMargin: boolean;
}

export const DEFAULT_QR_GENERATOR_PREFS: QrGeneratorPrefs = {
  activeTab: 'link',
  sizePx: 300,
  ecl: 'M',
  fgColor: '#0A1832',
  bgColor: '#FFFFFF',
  safeMargin: true,
};

function readStorageItem(key: string): string | null {
  try {
    const val = localStorage.getItem(key);
    if (val !== null) return val;
  } catch {
    // Ignore localStorage failures (e.g., restricted private mode)
  }
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage write errors
  }
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Ignore storage write errors
  }
}

export function isValidHomeSection(value: unknown): value is HomeSection {
  return typeof value === 'string' && VALID_HOME_SECTIONS.has(value as HomeSection);
}

export function loadHomeSection(urlSectionParam?: string | null): HomeSection {
  if (isValidHomeSection(urlSectionParam)) {
    writeStorageItem(HOME_SECTION_STORAGE_KEY, urlSectionParam);
    return urlSectionParam;
  }
  const saved = readStorageItem(HOME_SECTION_STORAGE_KEY);
  if (isValidHomeSection(saved)) {
    return saved;
  }
  return 'generate';
}

export function saveHomeSection(section: HomeSection): void {
  if (!isValidHomeSection(section)) return;
  writeStorageItem(HOME_SECTION_STORAGE_KEY, section);
}

export function loadQrGeneratorPrefs(): QrGeneratorPrefs {
  try {
    const raw = readStorageItem(QR_GENERATOR_PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_QR_GENERATOR_PREFS };
    const parsed = JSON.parse(raw) as Partial<QrGeneratorPrefs>;
    const sizeNum = Number(parsed.sizePx);
    return {
      activeTab:
        typeof parsed.activeTab === 'string' && VALID_INPUT_TABS.has(parsed.activeTab as InputTab)
          ? (parsed.activeTab as InputTab)
          : DEFAULT_QR_GENERATOR_PREFS.activeTab,
      sizePx: VALID_SIZES.has(sizeNum)
        ? (sizeNum as QrSizeOption)
        : DEFAULT_QR_GENERATOR_PREFS.sizePx,
      ecl:
        typeof parsed.ecl === 'string' && VALID_ECLS.has(parsed.ecl)
          ? (parsed.ecl as QrErrorCorrection)
          : DEFAULT_QR_GENERATOR_PREFS.ecl,
      fgColor:
        typeof parsed.fgColor === 'string' && HEX_COLOR_RE.test(parsed.fgColor.trim())
          ? parsed.fgColor.trim().toUpperCase()
          : DEFAULT_QR_GENERATOR_PREFS.fgColor,
      bgColor:
        typeof parsed.bgColor === 'string' && HEX_COLOR_RE.test(parsed.bgColor.trim())
          ? parsed.bgColor.trim().toUpperCase()
          : DEFAULT_QR_GENERATOR_PREFS.bgColor,
      safeMargin:
        typeof parsed.safeMargin === 'boolean'
          ? parsed.safeMargin
          : DEFAULT_QR_GENERATOR_PREFS.safeMargin,
    };
  } catch {
    return { ...DEFAULT_QR_GENERATOR_PREFS };
  }
}

export function saveQrGeneratorPrefs(prefs: QrGeneratorPrefs): void {
  const existing = loadQrGeneratorPrefs();
  const normalized: QrGeneratorPrefs = {
    activeTab: VALID_INPUT_TABS.has(prefs.activeTab) ? prefs.activeTab : existing.activeTab,
    sizePx: VALID_SIZES.has(prefs.sizePx) ? prefs.sizePx : existing.sizePx,
    ecl: VALID_ECLS.has(prefs.ecl) ? prefs.ecl : existing.ecl,
    fgColor: HEX_COLOR_RE.test(prefs.fgColor.trim())
      ? prefs.fgColor.trim().toUpperCase()
      : existing.fgColor,
    bgColor: HEX_COLOR_RE.test(prefs.bgColor.trim())
      ? prefs.bgColor.trim().toUpperCase()
      : existing.bgColor,
    safeMargin: typeof prefs.safeMargin === 'boolean' ? prefs.safeMargin : existing.safeMargin,
  };
  writeStorageItem(QR_GENERATOR_PREFS_STORAGE_KEY, JSON.stringify(normalized));
}
