export type ExtractedIdType = 'passport' | 'iqama' | 'national_id' | 'visa';

export interface RawGeminiExtractedDoc {
  page_number?: number | null;
  name?: string | null;
  passport_number?: string | null;
  iqama_number?: string | null;
  national_id_number?: string | null;
  visa_number?: string | null;
  id_number?: string | null;
  id_type?: string | null;
  nationality?: string | null;
  confidence?: number | null;
}

export interface NormalizedExtractedDoc {
  pageNumber: number | null;
  name: string | null;
  idNumber: string | null;
  idType: ExtractedIdType | null;
  nationality: string | null;
  confidence: number | null;
}

const PLACEHOLDER_VALUES = new Set([
  '',
  '-',
  '--',
  'N/A',
  'NA',
  'NONE',
  'NULL',
  'NIL',
  'UNKNOWN',
  'NOT FOUND',
  'UNREADABLE',
  'NOT APPLICABLE',
]);

// Maps country names, official titles, ISO codes, and variants to uppercase demonyms.
const COUNTRY_TO_DEMONYM: Record<string, string> = {
  // South Asia
  PAKISTAN: 'PAKISTANI',
  'ISLAMIC REPUBLIC OF PAKISTAN': 'PAKISTANI',
  PAK: 'PAKISTANI',
  PK: 'PAKISTANI',
  PAKISTANI: 'PAKISTANI',
  INDIA: 'INDIAN',
  'REPUBLIC OF INDIA': 'INDIAN',
  BHARAT: 'INDIAN',
  IND: 'INDIAN',
  IN: 'INDIAN',
  INDIAN: 'INDIAN',
  BANGLADESH: 'BANGLADESHI',
  'PEOPLES REPUBLIC OF BANGLADESH': 'BANGLADESHI',
  BGD: 'BANGLADESHI',
  BD: 'BANGLADESHI',
  BANGLADESHI: 'BANGLADESHI',
  NEPAL: 'NEPALI',
  NPL: 'NEPALI',
  NP: 'NEPALI',
  NEPALI: 'NEPALI',
  NEPALESE: 'NEPALI',
  'SRI LANKA': 'SRI LANKAN',
  SRILANKA: 'SRI LANKAN',
  LKA: 'SRI LANKAN',
  LK: 'SRI LANKAN',
  'SRI LANKAN': 'SRI LANKAN',
  AFGHANISTAN: 'AFGHAN',
  AFG: 'AFGHAN',
  AF: 'AFGHAN',
  AFGHAN: 'AFGHAN',
  BHUTAN: 'BHUTANESE',
  BTN: 'BHUTANESE',
  BT: 'BHUTANESE',
  BHUTANESE: 'BHUTANESE',
  MALDIVES: 'MALDIVIAN',
  MDV: 'MALDIVIAN',
  MV: 'MALDIVIAN',
  MALDIVIAN: 'MALDIVIAN',

  // Gulf & Middle East
  'SAUDI ARABIA': 'SAUDI',
  'KINGDOM OF SAUDI ARABIA': 'SAUDI',
  SAUDI: 'SAUDI',
  'SAUDI ARABIAN': 'SAUDI',
  KSA: 'SAUDI',
  SAU: 'SAUDI',
  SA: 'SAUDI',
  'UNITED ARAB EMIRATES': 'EMIRATI',
  UAE: 'EMIRATI',
  ARE: 'EMIRATI',
  AE: 'EMIRATI',
  EMIRATI: 'EMIRATI',
  KUWAIT: 'KUWAITI',
  KWT: 'KUWAITI',
  KW: 'KUWAITI',
  KUWAITI: 'KUWAITI',
  QATAR: 'QATARI',
  QAT: 'QATARI',
  QA: 'QATARI',
  QATARI: 'QATARI',
  BAHRAIN: 'BAHRAINI',
  BHR: 'BAHRAINI',
  BH: 'BAHRAINI',
  BAHRAINI: 'BAHRAINI',
  OMAN: 'OMANI',
  OMN: 'OMANI',
  OM: 'OMANI',
  OMANI: 'OMANI',
  YEMEN: 'YEMENI',
  YEM: 'YEMENI',
  YE: 'YEMENI',
  YEMENI: 'YEMENI',
  EGYPT: 'EGYPTIAN',
  'ARAB REPUBLIC OF EGYPT': 'EGYPTIAN',
  EGY: 'EGYPTIAN',
  EG: 'EGYPTIAN',
  EGYPTIAN: 'EGYPTIAN',
  JORDAN: 'JORDANIAN',
  JOR: 'JORDANIAN',
  JO: 'JORDANIAN',
  JORDANIAN: 'JORDANIAN',
  SYRIA: 'SYRIAN',
  'SYRIAN ARAB REPUBLIC': 'SYRIAN',
  SYR: 'SYRIAN',
  SY: 'SYRIAN',
  SYRIAN: 'SYRIAN',
  LEBANON: 'LEBANESE',
  LBN: 'LEBANESE',
  LB: 'LEBANESE',
  LEBANESE: 'LEBANESE',
  PALESTINE: 'PALESTINIAN',
  PSE: 'PALESTINIAN',
  PS: 'PALESTINIAN',
  PALESTINIAN: 'PALESTINIAN',
  IRAQ: 'IRAQI',
  IRQ: 'IRAQI',
  IQ: 'IRAQI',
  IRAQI: 'IRAQI',
  IRAN: 'IRANIAN',
  IRN: 'IRANIAN',
  IR: 'IRANIAN',
  IRANIAN: 'IRANIAN',
  TURKEY: 'TURKISH',
  TURKIYE: 'TURKISH',
  TUR: 'TURKISH',
  TR: 'TURKISH',
  TURKISH: 'TURKISH',

  // Southeast & East Asia
  PHILIPPINES: 'FILIPINO',
  'REPUBLIC OF THE PHILIPPINES': 'FILIPINO',
  PHL: 'FILIPINO',
  PH: 'FILIPINO',
  FILIPINO: 'FILIPINO',
  PHILIPPINE: 'FILIPINO',
  INDONESIA: 'INDONESIAN',
  IDN: 'INDONESIAN',
  ID: 'INDONESIAN',
  INDONESIAN: 'INDONESIAN',
  MALAYSIA: 'MALAYSIAN',
  MYS: 'MALAYSIAN',
  MY: 'MALAYSIAN',
  MALAYSIAN: 'MALAYSIAN',
  THAILAND: 'THAI',
  THA: 'THAI',
  TH: 'THAI',
  THAI: 'THAI',
  VIETNAM: 'VIETNAMESE',
  VNM: 'VIETNAMESE',
  VN: 'VIETNAMESE',
  VIETNAMESE: 'VIETNAMESE',
  MYANMAR: 'MYANMAR',
  BURMA: 'MYANMAR',
  MMR: 'MYANMAR',
  MM: 'MYANMAR',
  CHINA: 'CHINESE',
  CHN: 'CHINESE',
  CN: 'CHINESE',
  CHINESE: 'CHINESE',
  JAPAN: 'JAPANESE',
  JPN: 'JAPANESE',
  JP: 'JAPANESE',
  JAPANESE: 'JAPANESE',
  'SOUTH KOREA': 'SOUTH KOREAN',
  'REPUBLIC OF KOREA': 'SOUTH KOREAN',
  KOREA: 'KOREAN',
  KOR: 'SOUTH KOREAN',
  KR: 'SOUTH KOREAN',
  'SOUTH KOREAN': 'SOUTH KOREAN',
  SINGAPORE: 'SINGAPOREAN',
  SGP: 'SINGAPOREAN',
  SG: 'SINGAPOREAN',
  SINGAPOREAN: 'SINGAPOREAN',

  // Africa
  SUDAN: 'SUDANESE',
  SDN: 'SUDANESE',
  SD: 'SUDANESE',
  SUDANESE: 'SUDANESE',
  ETHIOPIA: 'ETHIOPIAN',
  ETH: 'ETHIOPIAN',
  ET: 'ETHIOPIAN',
  ETHIOPIAN: 'ETHIOPIAN',
  ERITREA: 'ERITREAN',
  ERI: 'ERITREAN',
  ER: 'ERITREAN',
  ERITREAN: 'ERITREAN',
  SOMALIA: 'SOMALI',
  SOM: 'SOMALI',
  SO: 'SOMALI',
  SOMALI: 'SOMALI',
  KENYA: 'KENYAN',
  KEN: 'KENYAN',
  KE: 'KENYAN',
  KENYAN: 'KENYAN',
  UGANDA: 'UGANDAN',
  UGA: 'UGANDAN',
  UG: 'UGANDAN',
  UGANDAN: 'UGANDAN',
  NIGERIA: 'NIGERIAN',
  NGA: 'NIGERIAN',
  NG: 'NIGERIAN',
  NIGERIAN: 'NIGERIAN',
  GHANA: 'GHANAIAN',
  GHA: 'GHANAIAN',
  GH: 'GHANAIAN',
  GHANAIAN: 'GHANAIAN',
  MOROCCO: 'MOROCCAN',
  MAR: 'MOROCCAN',
  MA: 'MOROCCAN',
  MOROCCAN: 'MOROCCAN',
  TUNISIA: 'TUNISIAN',
  TUN: 'TUNISIAN',
  TN: 'TUNISIAN',
  TUNISIAN: 'TUNISIAN',
  ALGERIA: 'ALGERIAN',
  DZA: 'ALGERIAN',
  DZ: 'ALGERIAN',
  ALGERIAN: 'ALGERIAN',
  LIBYA: 'LIBYAN',
  LBY: 'LIBYAN',
  LY: 'LIBYAN',
  LIBYAN: 'LIBYAN',
  'SOUTH AFRICA': 'SOUTH AFRICAN',
  ZAF: 'SOUTH AFRICAN',
  ZA: 'SOUTH AFRICAN',
  'SOUTH AFRICAN': 'SOUTH AFRICAN',
  CHAD: 'CHADIAN',
  TCD: 'CHADIAN',
  TD: 'CHADIAN',
  CHADIAN: 'CHADIAN',
  NIGER: 'NIGERIEN',
  NER: 'NIGERIEN',
  NE: 'NIGERIEN',
  NIGERIEN: 'NIGERIEN',
  MALI: 'MALIAN',
  MLI: 'MALIAN',
  ML: 'MALIAN',
  MALIAN: 'MALIAN',
  SENEGAL: 'SENEGALESE',
  SEN: 'SENEGALESE',
  SN: 'SENEGALESE',
  SENEGALESE: 'SENEGALESE',

  // Europe, Americas, Oceania
  'UNITED KINGDOM': 'BRITISH',
  UK: 'BRITISH',
  BRITAIN: 'BRITISH',
  'GREAT BRITAIN': 'BRITISH',
  ENGLAND: 'BRITISH',
  GBR: 'BRITISH',
  GB: 'BRITISH',
  BRITISH: 'BRITISH',
  'UNITED STATES': 'AMERICAN',
  'UNITED STATES OF AMERICA': 'AMERICAN',
  USA: 'AMERICAN',
  US: 'AMERICAN',
  AMERICA: 'AMERICAN',
  AMERICAN: 'AMERICAN',
  CANADA: 'CANADIAN',
  CAN: 'CANADIAN',
  CA: 'CANADIAN',
  CANADIAN: 'CANADIAN',
  AUSTRALIA: 'AUSTRALIAN',
  AUS: 'AUSTRALIAN',
  AU: 'AUSTRALIAN',
  AUSTRALIAN: 'AUSTRALIAN',
  'NEW ZEALAND': 'NEW ZEALANDER',
  NZL: 'NEW ZEALANDER',
  NZ: 'NEW ZEALANDER',
  GERMANY: 'GERMAN',
  DEU: 'GERMAN',
  DE: 'GERMAN',
  GERMAN: 'GERMAN',
  FRANCE: 'FRENCH',
  FRA: 'FRENCH',
  FR: 'FRENCH',
  FRENCH: 'FRENCH',
  ITALY: 'ITALIAN',
  ITA: 'ITALIAN',
  IT: 'ITALIAN',
  ITALIAN: 'ITALIAN',
  SPAIN: 'SPANISH',
  ESP: 'SPANISH',
  ES: 'SPANISH',
  SPANISH: 'SPANISH',
  PORTUGAL: 'PORTUGUESE',
  PRT: 'PORTUGUESE',
  PT: 'PORTUGUESE',
  PORTUGUESE: 'PORTUGUESE',
  NETHERLANDS: 'DUTCH',
  NLD: 'DUTCH',
  NL: 'DUTCH',
  DUTCH: 'DUTCH',
  RUSSIA: 'RUSSIAN',
  RUS: 'RUSSIAN',
  RU: 'RUSSIAN',
  RUSSIAN: 'RUSSIAN',
  UKRAINE: 'UKRAINIAN',
  UKR: 'UKRAINIAN',
  UA: 'UKRAINIAN',
  UKRAINIAN: 'UKRAINIAN',
  POLAND: 'POLISH',
  POL: 'POLISH',
  PL: 'POLISH',
  POLISH: 'POLISH',
  ROMANIA: 'ROMANIAN',
  ROU: 'ROMANIAN',
  RO: 'ROMANIAN',
  ROMANIAN: 'ROMANIAN',
  BRAZIL: 'BRAZILIAN',
  BRA: 'BRAZILIAN',
  BR: 'BRAZILIAN',
  BRAZILIAN: 'BRAZILIAN',
  MEXICO: 'MEXICAN',
  MEX: 'MEXICAN',
  MX: 'MEXICAN',
  MEXICAN: 'MEXICAN',
};

function isPlaceholder(val: string): boolean {
  return PLACEHOLDER_VALUES.has(val.trim().toUpperCase());
}

/**
 * Normalizes a person's full name to uppercase Latin letters.
 * Strips Arabic script runs if mixed with English, collapses whitespace, and rejects placeholders.
 */
export function normalizeExtractedName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;

  // Remove Arabic/Urdu Unicode blocks if both Arabic and English were captured together
  const withoutArabic = raw
    .replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+/g, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  const cleaned = withoutArabic
    .replace(/[^A-Za-z0-9\s.'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s./'-]+|[\s./'-]+$/g, '')
    .trim()
    .toUpperCase();

  if (!cleaned || isPlaceholder(cleaned)) return null;
  if (!/[A-Z]{2,}/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Strips spaces and dashes from candidate ID strings and validates non-placeholder content.
 */
export function normalizeExtractedIdNumber(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || isPlaceholder(trimmed)) return null;

  // Strip spaces, dashes, underscores, dots
  const stripped = trimmed.replace(/[\s\-–—_.]+/g, '').toUpperCase();
  if (!stripped || isPlaceholder(stripped)) return null;

  // Must contain alphanumeric chars and at least 4 characters (no real passport/iqama/ID/visa is <4 chars)
  const alnum = stripped.replace(/[^A-Z0-9]/g, '');
  if (alnum.length < 4 || !/\d/.test(alnum)) {
    // Allow purely alpha only if invalid? Real IDs contain digits; check >= 4 alnum with at least 1 digit
    return null;
  }
  return alnum;
}

/**
 * Strictly enforces ID priority in backend code:
 * 1. Passport number
 * 2. Iqama number
 * 3. National ID number
 * 4. Visa number
 */
export function pickPriorityId(raw: RawGeminiExtractedDoc): {
  idNumber: string | null;
  idType: ExtractedIdType | null;
} {
  const passport = normalizeExtractedIdNumber(raw.passport_number);
  if (passport) return { idNumber: passport, idType: 'passport' };

  const iqama = normalizeExtractedIdNumber(raw.iqama_number);
  if (iqama) return { idNumber: iqama, idType: 'iqama' };

  const nationalId = normalizeExtractedIdNumber(raw.national_id_number);
  if (nationalId) return { idNumber: nationalId, idType: 'national_id' };

  const visa = normalizeExtractedIdNumber(raw.visa_number);
  if (visa) return { idNumber: visa, idType: 'visa' };

  // Fallback if model populated generic id_number/id_type directly
  const fallbackId = normalizeExtractedIdNumber(raw.id_number);
  if (fallbackId) {
    const rawType = (raw.id_type ?? '').trim().toLowerCase();
    const mappedType: ExtractedIdType =
      rawType === 'passport' || rawType === 'iqama' || rawType === 'national_id' || rawType === 'visa'
        ? rawType
        : 'national_id';
    return { idNumber: fallbackId, idType: mappedType };
  }

  return { idNumber: null, idType: null };
}

/**
 * Normalizes nationality into clean uppercase demonym (e.g., PAKISTANI, INDIAN, SAUDI).
 */
export function normalizeNationalityDemonym(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;

  const cleaned = raw
    .replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]+/g, ' ')
    .replace(/[^A-Za-z\s/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

  if (!cleaned || isPlaceholder(cleaned)) return null;

  // Handle slash-separated bilingual or dual labels like "PAKISTAN / PAKISTANI"
  const parts = cleaned.split('/').map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const key = part.replace(/['.]/g, '').replace(/\s+/g, ' ').trim();
    if (COUNTRY_TO_DEMONYM[key]) {
      return COUNTRY_TO_DEMONYM[key];
    }
  }

  const wholeKey = cleaned.replace(/['.]/g, '').replace(/\s+/g, ' ').trim();
  if (COUNTRY_TO_DEMONYM[wholeKey]) {
    return COUNTRY_TO_DEMONYM[wholeKey];
  }

  // Fallback: return clean uppercase token if at least 3 Latin letters
  if (/^[A-Z][A-Z\s-]{2,39}$/.test(wholeKey)) {
    return wholeKey;
  }
  return null;
}

export function normalizeExtractedDocument(raw: RawGeminiExtractedDoc): NormalizedExtractedDoc {
  const { idNumber, idType } = pickPriorityId(raw);
  const confidence =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? Math.max(0, Math.min(1, Number(raw.confidence.toFixed(2))))
      : null;
  const pageNumber =
    typeof raw.page_number === 'number' && Number.isInteger(raw.page_number) && raw.page_number > 0
      ? raw.page_number
      : null;

  return {
    pageNumber,
    name: normalizeExtractedName(raw.name),
    idNumber,
    idType,
    nationality: normalizeNationalityDemonym(raw.nationality),
    confidence,
  };
}
