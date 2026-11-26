const ARABIC_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ARABIC_DIACRITICS_RE = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

export function containsArabicScript(value: string): boolean {
  return ARABIC_SCRIPT_RE.test(value);
}

/**
 * Converts Eastern Arabic (٠-٩) and Persian/Urdu (۰-۹) digits into ASCII 0-9.
 */
export function normalizeEasternArabicDigits(input: string): string {
  return input
    .replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0));
}

/**
 * Normalizes Arabic text for dictionary lookups: removes tashkeel/tatweel,
 * unifies Alef/Ya/Ta-marbuta forms, removes punctuation, and collapses spaces.
 */
export function normalizeArabicKey(input: string): string {
  return input
    .replace(ARABIC_DIACRITICS_RE, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/[یے]/g, 'ي')
    .replace(/[:.\-/\\()[\]{}،؛؟!@#$%^&*_+="']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const RAW_ARABIC_COUNTRY_MAP: ReadonlyArray<readonly [string, string]> = [
  // South Asia
  ['باكستان', 'PAKISTANI'],
  ['باكستاني', 'PAKISTANI'],
  ['باكستانية', 'PAKISTANI'],
  ['البكستاني', 'PAKISTANI'],
  ['البكستانية', 'PAKISTANI'],
  ['جمهورية باكستان الإسلامية', 'PAKISTANI'],
  ['الهند', 'INDIAN'],
  ['هند', 'INDIAN'],
  ['هندي', 'INDIAN'],
  ['هندية', 'INDIAN'],
  ['جمهورية الهند', 'INDIAN'],
  ['بنغلاديش', 'BANGLADESHI'],
  ['بنجلاديش', 'BANGLADESHI'],
  ['بنقلاديش', 'BANGLADESHI'],
  ['بنجلادش', 'BANGLADESHI'],
  ['بنغلادش', 'BANGLADESHI'],
  ['بنغلاديشي', 'BANGLADESHI'],
  ['بنغلاديشية', 'BANGLADESHI'],
  ['بنجلاديشي', 'BANGLADESHI'],
  ['بنجلاديشية', 'BANGLADESHI'],
  ['بنقلاديشي', 'BANGLADESHI'],
  ['بنقلاديشية', 'BANGLADESHI'],
  ['بنغالي', 'BANGLADESHI'],
  ['بنغالية', 'BANGLADESHI'],
  ['نيبال', 'NEPALI'],
  ['النيبال', 'NEPALI'],
  ['نيبالي', 'NEPALI'],
  ['نيبالية', 'NEPALI'],
  ['سريلانكا', 'SRI LANKAN'],
  ['سري لانكا', 'SRI LANKAN'],
  ['سيريلانكا', 'SRI LANKAN'],
  ['سريلانكي', 'SRI LANKAN'],
  ['سريلانكية', 'SRI LANKAN'],
  ['سيريلانكي', 'SRI LANKAN'],
  ['سيريلانكية', 'SRI LANKAN'],
  ['أفغانستان', 'AFGHAN'],
  ['أفغاني', 'AFGHAN'],
  ['أفغانية', 'AFGHAN'],
  ['بوتان', 'BHUTANESE'],
  ['بوتاني', 'BHUTANESE'],
  ['بوتانية', 'BHUTANESE'],
  ['المالديف', 'MALDIVIAN'],
  ['جزر المالديف', 'MALDIVIAN'],
  ['مالديفي', 'MALDIVIAN'],
  ['مالديفية', 'MALDIVIAN'],

  // Saudi, GCC & Middle East
  ['السعودية', 'SAUDI'],
  ['المملكة العربية السعودية', 'SAUDI'],
  ['سعودي', 'SAUDI'],
  ['سعودية', 'SAUDI'],
  ['عربي سعودي', 'SAUDI'],
  ['عربية سعودية', 'SAUDI'],
  ['سعودي الجنسية', 'SAUDI'],
  ['الإمارات', 'EMIRATI'],
  ['الإمارات العربية المتحدة', 'EMIRATI'],
  ['إماراتي', 'EMIRATI'],
  ['إماراتية', 'EMIRATI'],
  ['الكويت', 'KUWAITI'],
  ['دولة الكويت', 'KUWAITI'],
  ['كويتي', 'KUWAITI'],
  ['كويتية', 'KUWAITI'],
  ['قطر', 'QATARI'],
  ['دولة قطر', 'QATARI'],
  ['قطري', 'QATARI'],
  ['قطرية', 'QATARI'],
  ['البحرين', 'BAHRAINI'],
  ['مملكة البحرين', 'BAHRAINI'],
  ['بحريني', 'BAHRAINI'],
  ['بحرينية', 'BAHRAINI'],
  ['عمان', 'OMANI'],
  ['سلطنة عمان', 'OMANI'],
  ['عماني', 'OMANI'],
  ['عمانية', 'OMANI'],
  ['اليمن', 'YEMENI'],
  ['الجمهورية اليمنية', 'YEMENI'],
  ['يمني', 'YEMENI'],
  ['يمنية', 'YEMENI'],
  ['مصر', 'EGYPTIAN'],
  ['جمهورية مصر العربية', 'EGYPTIAN'],
  ['مصري', 'EGYPTIAN'],
  ['مصرية', 'EGYPTIAN'],
  ['الأردن', 'JORDANIAN'],
  ['المملكة الأردنية الهاشمية', 'JORDANIAN'],
  ['أردني', 'JORDANIAN'],
  ['أردنية', 'JORDANIAN'],
  ['سوريا', 'SYRIAN'],
  ['سورية', 'SYRIAN'],
  ['الجمهورية العربية السورية', 'SYRIAN'],
  ['سوري', 'SYRIAN'],
  ['لبنان', 'LEBANESE'],
  ['الجمهورية اللبنانية', 'LEBANESE'],
  ['لبناني', 'LEBANESE'],
  ['لبنانية', 'LEBANESE'],
  ['فلسطين', 'PALESTINIAN'],
  ['دولة فلسطين', 'PALESTINIAN'],
  ['فلسطيني', 'PALESTINIAN'],
  ['فلسطينية', 'PALESTINIAN'],
  ['العراق', 'IRAQI'],
  ['جمهورية العراق', 'IRAQI'],
  ['عراقي', 'IRAQI'],
  ['عراقية', 'IRAQI'],
  ['إيران', 'IRANIAN'],
  ['إيراني', 'IRANIAN'],
  ['إيرانية', 'IRANIAN'],
  ['تركيا', 'TURKISH'],
  ['تركي', 'TURKISH'],
  ['تركية', 'TURKISH'],

  // Southeast & East Asia
  ['الفلبين', 'FILIPINO'],
  ['فلبين', 'FILIPINO'],
  ['فلبيني', 'FILIPINO'],
  ['فلبينية', 'FILIPINO'],
  ['الفلبينية', 'FILIPINO'],
  ['إندونيسيا', 'INDONESIAN'],
  ['أندونيسيا', 'INDONESIAN'],
  ['إندونيسي', 'INDONESIAN'],
  ['أندونيسي', 'INDONESIAN'],
  ['إندونيسية', 'INDONESIAN'],
  ['أندونيسية', 'INDONESIAN'],
  ['ماليزيا', 'MALAYSIAN'],
  ['ماليزي', 'MALAYSIAN'],
  ['ماليزية', 'MALAYSIAN'],
  ['تايلاند', 'THAI'],
  ['تايلند', 'THAI'],
  ['تايلاندي', 'THAI'],
  ['تايلندي', 'THAI'],
  ['تايلاندية', 'THAI'],
  ['تايلندية', 'THAI'],
  ['فيتنام', 'VIETNAMESE'],
  ['فيتنامي', 'VIETNAMESE'],
  ['فيتنامية', 'VIETNAMESE'],
  ['ميانمار', 'MYANMAR'],
  ['مينمار', 'MYANMAR'],
  ['بورما', 'MYANMAR'],
  ['بورمي', 'MYANMAR'],
  ['ميانماري', 'MYANMAR'],
  ['الصين', 'CHINESE'],
  ['صيني', 'CHINESE'],
  ['صينية', 'CHINESE'],
  ['اليابان', 'JAPANESE'],
  ['ياباني', 'JAPANESE'],
  ['يابانية', 'JAPANESE'],
  ['كوريا الجنوبية', 'SOUTH KOREAN'],
  ['كوريا', 'KOREAN'],
  ['كوري', 'KOREAN'],
  ['كورية', 'KOREAN'],
  ['سنغافورة', 'SINGAPOREAN'],
  ['سنغافوري', 'SINGAPOREAN'],
  ['سنغافورية', 'SINGAPOREAN'],

  // Africa
  ['السودان', 'SUDANESE'],
  ['جمهورية السودان', 'SUDANESE'],
  ['سوداني', 'SUDANESE'],
  ['سودانية', 'SUDANESE'],
  ['إثيوبيا', 'ETHIOPIAN'],
  ['أثيوبيا', 'ETHIOPIAN'],
  ['إثيوبي', 'ETHIOPIAN'],
  ['أثيوبي', 'ETHIOPIAN'],
  ['إثيوبية', 'ETHIOPIAN'],
  ['أثيوبية', 'ETHIOPIAN'],
  ['إريتريا', 'ERITREAN'],
  ['إرتريا', 'ERITREAN'],
  ['إريتري', 'ERITREAN'],
  ['إريترية', 'ERITREAN'],
  ['إرتري', 'ERITREAN'],
  ['إرترية', 'ERITREAN'],
  ['الصومال', 'SOMALI'],
  ['صومالي', 'SOMALI'],
  ['صومالية', 'SOMALI'],
  ['كينيا', 'KENYAN'],
  ['كيني', 'KENYAN'],
  ['كينية', 'KENYAN'],
  ['أوغندا', 'UGANDAN'],
  ['أوغندي', 'UGANDAN'],
  ['أوغندية', 'UGANDAN'],
  ['نيجيريا', 'NIGERIAN'],
  ['نيجيري', 'NIGERIAN'],
  ['نيجيرية', 'NIGERIAN'],
  ['غانا', 'GHANAIAN'],
  ['غاني', 'GHANAIAN'],
  ['غانية', 'GHANAIAN'],
  ['المغرب', 'MOROCCAN'],
  ['المملكة المغربية', 'MOROCCAN'],
  ['مغربي', 'MOROCCAN'],
  ['مغربية', 'MOROCCAN'],
  ['تونس', 'TUNISIAN'],
  ['تونسي', 'TUNISIAN'],
  ['تونسية', 'TUNISIAN'],
  ['الجزائر', 'ALGERIAN'],
  ['جزائري', 'ALGERIAN'],
  ['جزائرية', 'ALGERIAN'],
  ['ليبيا', 'LIBYAN'],
  ['ليبي', 'LIBYAN'],
  ['ليبية', 'LIBYAN'],
  ['جنوب أفريقيا', 'SOUTH AFRICAN'],
  ['جنوب أفريقي', 'SOUTH AFRICAN'],
  ['جنوب أفريقية', 'SOUTH AFRICAN'],
  ['تشاد', 'CHADIAN'],
  ['تشادي', 'CHADIAN'],
  ['تشادية', 'CHADIAN'],
  ['النيجر', 'NIGERIEN'],
  ['نيجري', 'NIGERIEN'],
  ['نيجرية', 'NIGERIEN'],
  ['مالي', 'MALIAN'],
  ['السنغال', 'SENEGALESE'],
  ['سنغالي', 'SENEGALESE'],
  ['سنغالية', 'SENEGALESE'],
  ['موريتانيا', 'MAURITANIAN'],
  ['موريتاني', 'MAURITANIAN'],
  ['موريتانية', 'MAURITANIAN'],
  ['جيبوتي', 'DJIBOUTIAN'],
  ['جيبوتية', 'DJIBOUTIAN'],
  ['تنزانيا', 'TANZANIAN'],
  ['تنزاني', 'TANZANIAN'],
  ['تنزانية', 'TANZANIAN'],
  ['الكاميرون', 'CAMEROONIAN'],
  ['كاميروني', 'CAMEROONIAN'],
  ['كاميرونية', 'CAMEROONIAN'],
  ['غامبيا', 'GAMBIAN'],
  ['جامبيا', 'GAMBIAN'],
  ['غامبي', 'GAMBIAN'],
  ['جامبي', 'GAMBIAN'],
  ['غينيا', 'GUINEAN'],
  ['غيني', 'GUINEAN'],
  ['غينية', 'GUINEAN'],

  // Central Asia, Europe, Americas, Oceania
  ['أوزبكستان', 'UZBEK'],
  ['أوزبكي', 'UZBEK'],
  ['أوزبكية', 'UZBEK'],
  ['كازاخستان', 'KAZAKH'],
  ['كازاخستاني', 'KAZAKH'],
  ['طاجيكستان', 'TAJIK'],
  ['طاجيكي', 'TAJIK'],
  ['قرغيزستان', 'KYRGYZ'],
  ['قيرغيزستان', 'KYRGYZ'],
  ['قرغيزي', 'KYRGYZ'],
  ['أذربيجان', 'AZERBAIJANI'],
  ['أذربيجاني', 'AZERBAIJANI'],
  ['بريطانيا', 'BRITISH'],
  ['المملكة المتحدة', 'BRITISH'],
  ['بريطاني', 'BRITISH'],
  ['بريطانية', 'BRITISH'],
  ['إنجلترا', 'BRITISH'],
  ['إنجليزي', 'BRITISH'],
  ['أمريكا', 'AMERICAN'],
  ['الولايات المتحدة', 'AMERICAN'],
  ['الولايات المتحدة الأمريكية', 'AMERICAN'],
  ['أمريكي', 'AMERICAN'],
  ['أمريكية', 'AMERICAN'],
  ['كندا', 'CANADIAN'],
  ['كندي', 'CANADIAN'],
  ['كندية', 'CANADIAN'],
  ['أستراليا', 'AUSTRALIAN'],
  ['أسترالي', 'AUSTRALIAN'],
  ['أسترالية', 'AUSTRALIAN'],
  ['نيوزيلندا', 'NEW ZEALANDER'],
  ['نيوزيلندي', 'NEW ZEALANDER'],
  ['نيوزيلندية', 'NEW ZEALANDER'],
  ['ألمانيا', 'GERMAN'],
  ['ألماني', 'GERMAN'],
  ['ألمانية', 'GERMAN'],
  ['فرنسا', 'FRENCH'],
  ['فرنسي', 'FRENCH'],
  ['فرنسية', 'FRENCH'],
  ['إيطاليا', 'ITALIAN'],
  ['إيطالي', 'ITALIAN'],
  ['إيطالية', 'ITALIAN'],
  ['إسبانيا', 'SPANISH'],
  ['إسباني', 'SPANISH'],
  ['إسبانية', 'SPANISH'],
  ['البرتغال', 'PORTUGUESE'],
  ['برتغالي', 'PORTUGUESE'],
  ['برتغالية', 'PORTUGUESE'],
  ['هولندا', 'DUTCH'],
  ['هولندي', 'DUTCH'],
  ['هولندية', 'DUTCH'],
  ['روسيا', 'RUSSIAN'],
  ['روسي', 'RUSSIAN'],
  ['روسية', 'RUSSIAN'],
  ['أوكرانيا', 'UKRAINIAN'],
  ['أوكراني', 'UKRAINIAN'],
  ['أوكرانية', 'UKRAINIAN'],
  ['بولندا', 'POLISH'],
  ['بولندي', 'POLISH'],
  ['بولندية', 'POLISH'],
  ['رومانيا', 'ROMANIAN'],
  ['روماني', 'ROMANIAN'],
  ['رومانية', 'ROMANIAN'],
  ['البرازيل', 'BRAZILIAN'],
  ['برازيلي', 'BRAZILIAN'],
  ['برازيلية', 'BRAZILIAN'],
  ['المكسيك', 'MEXICAN'],
  ['مكسيكي', 'MEXICAN'],
  ['مكسيكية', 'MEXICAN'],
];

const ARABIC_COUNTRY_MAP = new Map<string, string>(
  RAW_ARABIC_COUNTRY_MAP.map(([k, v]) => [normalizeArabicKey(k), v])
);

const ARABIC_NATIONALITY_DISTRACTORS = new Set<string>(
  [
    'الرياض',
    'جدة',
    'الدمام',
    'مكة',
    'مكة المكرمة',
    'المدينة',
    'المدينة المنورة',
    'الخبر',
    'تبوك',
    'أبها',
    'الطائف',
    'القصيم',
    'حائل',
    'جازان',
    'نجران',
    'الجبيل',
    'ينبع',
    'الإسلام',
    'مسلم',
    'غير مسلم',
    'مسيحي',
    'هندوسي',
    'غير سعودي',
    'مقيم',
    'إقامة',
    'هوية مقيم',
    'الهوية الوطنية',
    'جواز سفر',
    'غير محدد',
    'غير معروف',
    'لا يوجد',
  ].map((s) => normalizeArabicKey(s))
);

export const LATIN_NON_NATIONALITY_DISTRACTORS = new Set<string>([
  'RIYADH',
  'AL RIYADH',
  'AL-RIYADH',
  'JEDDAH',
  'DAMMAM',
  'MAKKAH',
  'MAKKAH AL MUKARRAMAH',
  'MECCA',
  'MADINAH',
  'AL MADINAH',
  'AL-MADINAH',
  'MEDINA',
  'KHOBAR',
  'AL KHOBAR',
  'AL-KHOBAR',
  'TABUK',
  'ABHA',
  'TAIF',
  'QASSIM',
  'HAIL',
  'JAZAN',
  'NAJRAN',
  'JUBAIL',
  'AL JUBAIL',
  'YANBU',
  'ISLAM',
  'MUSLIM',
  'NON MUSLIM',
  'CHRISTIAN',
  'HINDU',
  'MOI',
  'IQAMA',
  'PASSPORT',
  'VISA',
  'RESIDENT',
  'RESIDENT IDENTITY',
  'NATIONALITY',
  'COUNTRY',
  'NON SAUDI',
  'NON-SAUDI',
  'CONSTRUCTOR',
  'PROTO',
  'PROTOTYPE',
  'TOSTRING',
  'VALUEOF',
]);

const ARABIC_NAME_BOILERPLATE = new Set<string>(
  [
    'المملكة العربية السعودية',
    'وزارة الداخلية',
    'المديرية العامة للجوازات',
    'الجوازات',
    'هوية مقيم',
    'الهوية الوطنية',
    'بطاقة الأحوال المدنية',
    'إقامة',
    'رقم الإقامة',
    'جواز سفر',
    'تأشيرة',
    'الإسلام',
    'مسلم',
    'غير مسلم',
    'مسيحي',
    'هندوسي',
    'الديانة',
    'المهنة',
    'صاحب العمل',
    'الكفيل',
    'اسم الكفيل',
    'مكان الإصدار',
    'مكان الميلاد',
    'تاريخ الميلاد',
    'تاريخ الانتهاء',
    'الجنسية',
    'الاسم',
    'الاسم الكامل',
    'غير محدد',
    'غير معروف',
    'لا يوجد',
  ].map((s) => normalizeArabicKey(s))
);

export const LATIN_NAME_BOILERPLATE = new Set<string>([
  'KINGDOM OF SAUDI ARABIA',
  'MINISTRY OF INTERIOR',
  'GENERAL DIRECTORATE OF PASSPORTS',
  'RESIDENT IDENTITY',
  'IDENTITY CARD',
  'NATIONAL IDENTITY',
  'NATIONAL ID',
  'IQAMA',
  'PASSPORT',
  'VISA',
  'ISLAM',
  'MUSLIM',
  'NON MUSLIM',
  'CHRISTIAN',
  'HINDU',
  'RELIGION',
  'OCCUPATION',
  'PROFESSION',
  'SPONSOR',
  'EMPLOYER',
  'DATE OF BIRTH',
  'DATE OF ISSUE',
  'DATE OF EXPIRY',
  'PLACE OF ISSUE',
  'PLACE OF BIRTH',
  'NATIONALITY',
  'FULL NAME',
  'NAME',
  'MUQEEM',
  'ABSHER',
  'QIWA',
  'TAWAKKALNA',
  'MINISTRY OF HUMAN RESOURCES',
]);

/**
 * Resolves an Arabic country name or demonym string (e.g., "باكستاني", "الجنسية: سوداني")
 * into its uppercase English demonym.
 */
export function lookupArabicNationalityDemonym(raw: string): string | null {
  const bounded = raw.slice(0, 256);
  if (!containsArabicScript(bounded)) return null;

  const segments = bounded
    .split(/[/|,،؛]+/)
    .map((s) => normalizeArabicKey(s))
    .filter(Boolean);

  for (const seg of segments) {
    const cleaned = seg.replace(/^(?:الجنسيه|جنسيه|الجنس|البلد|الدوله)\s+/, '').trim();
    if (!cleaned) continue;
    if (cleaned.startsWith('غير ')) return null;
    if (ARABIC_NATIONALITY_DISTRACTORS.has(cleaned)) continue;

    const direct = ARABIC_COUNTRY_MAP.get(cleaned);
    if (direct) return direct;
  }

  return null;
}

const COMPOUND_ARABIC_NAMES = new Map<string, string>(
  (
    [
      ['عبد الله', 'ABDULLAH'],
      ['عبد الرحمن', 'ABDUL RAHMAN'],
      ['عبد العزيز', 'ABDUL AZIZ'],
      ['عبد الرحيم', 'ABDUL RAHIM'],
      ['عبد الكريم', 'ABDUL KARIM'],
      ['عبد الرزاق', 'ABDUL RAZZAQ'],
      ['عبد المجيد', 'ABDUL MAJID'],
      ['عبد القادر', 'ABDUL QADIR'],
      ['عبد الوهاب', 'ABDUL WAHAB'],
      ['عبد السلام', 'ABDUL SALAM'],
      ['عبد الغفار', 'ABDUL GHAFFAR'],
      ['عبد الستار', 'ABDUL SATTAR'],
      ['عبد الجبار', 'ABDUL JABBAR'],
      ['عبد الخالق', 'ABDUL KHALIQ'],
      ['عبد الحميد', 'ABDUL HAMID'],
      ['عبد الباسط', 'ABDUL BASIT'],
      ['عبد اللطيف', 'ABDUL LATIF'],
      ['عبد الملك', 'ABDUL MALIK'],
      ['عبد الفتاح', 'ABDUL FATTAH'],
      ['عبد الصمد', 'ABDUL SAMAD'],
      ['عبد الاله', 'ABDUL ILAH'],
      ['نور الدين', 'NOOR AL DIN'],
      ['صلاح الدين', 'SALAH AL DIN'],
      ['سيف الدين', 'SAIF AL DIN'],
      ['شمس الدين', 'SHAMS AL DIN'],
      ['بدر الدين', 'BADR AL DIN'],
      ['علاء الدين', 'ALAA AL DIN'],
      ['فخر الدين', 'FAKHR AL DIN'],
      ['محيي الدين', 'MOHIUDDIN'],
      ['فضل الرحمن', 'FAZAL UR RAHMAN'],
      ['عطاء الله', 'ATAULLAH'],
      ['عزيز الله', 'AZIZULLAH'],
      ['حبيب الله', 'HABIBULLAH'],
      ['رحمة الله', 'RAHMATULLAH'],
      ['أمان الله', 'AMANULLAH'],
    ] as const
  ).map(([ar, en]) => [normalizeArabicKey(ar), en])
);

const SINGLE_ARABIC_NAMES = new Map<string, string>(
  (
    [
      ['محمد', 'MUHAMMAD'],
      ['أحمد', 'AHMAD'],
      ['علي', 'ALI'],
      ['حسن', 'HASAN'],
      ['حسين', 'HUSAIN'],
      ['عمر', 'OMAR'],
      ['عثمان', 'UTHMAN'],
      ['إبراهيم', 'IBRAHIM'],
      ['إسماعيل', 'ISMAIL'],
      ['إسحاق', 'ISHAQ'],
      ['يعقوب', 'YAQOOB'],
      ['يوسف', 'YOUSUF'],
      ['موسى', 'MUSA'],
      ['عيسى', 'ISA'],
      ['يحيى', 'YAHYA'],
      ['زكريا', 'ZAKARIYA'],
      ['سليمان', 'SULAIMAN'],
      ['داود', 'DAWOOD'],
      ['خالد', 'KHALID'],
      ['سعد', 'SAAD'],
      ['سعيد', 'SAEED'],
      ['سالم', 'SALIM'],
      ['سلمان', 'SALMAN'],
      ['سلطان', 'SULTAN'],
      ['فهد', 'FAHD'],
      ['فيصل', 'FAISAL'],
      ['طارق', 'TARIQ'],
      ['ناصر', 'NASIR'],
      ['منصور', 'MANSOUR'],
      ['مصطفى', 'MUSTAFA'],
      ['محمود', 'MAHMOUD'],
      ['ياسر', 'YASIR'],
      ['وليد', 'WALID'],
      ['صالح', 'SALIH'],
      ['عادل', 'ADIL'],
      ['كريم', 'KARIM'],
      ['رحمن', 'RAHMAN'],
      ['رحيم', 'RAHIM'],
      ['نور', 'NOOR'],
      ['خان', 'KHAN'],
      ['شاه', 'SHAH'],
      ['بلال', 'BILAL'],
      ['حمزة', 'HAMZA'],
      ['حبيب', 'HABIB'],
      ['رشيد', 'RASHID'],
      ['راشد', 'RASHID'],
      ['شريف', 'SHARIF'],
      ['عمران', 'IMRAN'],
      ['عرفان', 'IRFAN'],
      ['فيض', 'FAIZ'],
      ['فارس', 'FARIS'],
      ['ماجد', 'MAJID'],
      ['نايف', 'NAIF'],
      ['نواف', 'NAWAF'],
      ['تركي', 'TURKI'],
      ['بندر', 'BANDAR'],
      ['مشعل', 'MISHAL'],
      ['متعب', 'MUTEB'],
      ['زياد', 'ZIAD'],
      ['عزام', 'AZZAM'],
      ['هشام', 'HISHAM'],
      ['جمال', 'JAMAL'],
      ['كمال', 'KAMAL'],
      ['جلال', 'JALAL'],
      ['سمير', 'SAMIR'],
      ['منير', 'MUNIR'],
      ['بشير', 'BASHIR'],
      ['نذير', 'NAZIR'],
      ['زهير', 'ZOHAIR'],
      ['أسامة', 'OSAMA'],
      ['أمين', 'AMIN'],
      ['أنس', 'ANAS'],
      ['أيمن', 'AYMAN'],
      ['بدر', 'BADR'],
      ['ثامر', 'THAMER'],
      ['حسام', 'HUSSAM'],
      ['حمد', 'HAMAD'],
      ['راكان', 'RAKAN'],
      ['سعود', 'SAUD'],
      ['شهاب', 'SHIHAB'],
      ['عصام', 'ISSAM'],
      ['غسان', 'GHASSAN'],
      ['فؤاد', 'FUAD'],
      ['قاسم', 'QASIM'],
      ['كامل', 'KAMIL'],
      ['ماهر', 'MAHER'],
      ['مبارك', 'MUBARAK'],
      ['مختار', 'MUKHTAR'],
      ['مراد', 'MURAD'],
      ['مروان', 'MARWAN'],
      ['نادر', 'NADER'],
      ['نبيل', 'NABIL'],
      ['هاشم', 'HASHIM'],
      ['هاني', 'HANI'],
      ['وائل', 'WAEL'],
      ['ياسين', 'YASIN'],
      ['فاطمة', 'FATIMA'],
      ['عائشة', 'AISHA'],
      ['زينب', 'ZAINAB'],
      ['مريم', 'MARYAM'],
      ['سارة', 'SARA'],
      ['آمنة', 'AMINA'],
      ['خديجة', 'KHADIJA'],
      ['حفصة', 'HAFSA'],
      ['سمية', 'SUMAYA'],
      ['أسماء', 'ASMA'],
      ['نورة', 'NOURA'],
      ['منى', 'MONA'],
      ['هدى', 'HUDA'],
      ['سلمى', 'SALMA'],
      ['ليلى', 'LAYLA'],
      ['ريم', 'REEM'],
      ['دلال', 'DALAL'],
      ['عبدالله', 'ABDULLAH'],
      ['عبدالرحمن', 'ABDUL RAHMAN'],
      ['عبدالعزيز', 'ABDUL AZIZ'],
      ['عبدالكريم', 'ABDUL KARIM'],
      ['عبدالرحيم', 'ABDUL RAHIM'],
      ['قحطاني', 'QAHTANI'],
      ['دوسري', 'DOSARI'],
      ['غامدي', 'GHAMDI'],
      ['زهراني', 'ZAHRANI'],
      ['حربي', 'HARBI'],
      ['عتيبي', 'OTAIBI'],
      ['مطيري', 'MUTAIRI'],
      ['شمري', 'SHAMMARI'],
      ['سبيعي', 'SUBAIE'],
      ['شهراني', 'SHAHRANI'],
      ['عنزي', 'ANAZI'],
      ['رشيدي', 'RASHIDI'],
      ['شهري', 'SHEHRI'],
      ['قريشي', 'QURESHI'],
      ['أنصاري', 'ANSARI'],
      ['صديقي', 'SIDDIQUI'],
      ['فاروق', 'FAROOQ'],
      ['شيخ', 'SHEIKH'],
      ['ملك', 'MALIK'],
      ['سياب', 'SIYAB'],
      ['زادة', 'ZADA'],
      ['زاده', 'ZADA'],
      ['گل', 'GUL'],
      ['جل', 'GUL'],
      ['بن', 'BIN'],
      ['بنت', 'BINT'],
      ['أبو', 'ABU'],
      ['آل', 'AL'],
    ] as const
  ).map(([ar, en]) => [normalizeArabicKey(ar), en])
);

const ARABIC_CHAR_TO_LATIN: Record<string, string> = {
  ا: 'A',
  أ: 'A',
  إ: 'I',
  آ: 'A',
  ٱ: 'A',
  ب: 'B',
  ت: 'T',
  ث: 'TH',
  ج: 'J',
  ح: 'H',
  خ: 'KH',
  د: 'D',
  ذ: 'DH',
  ر: 'R',
  ز: 'Z',
  س: 'S',
  ش: 'SH',
  ص: 'S',
  ض: 'D',
  ط: 'T',
  ظ: 'Z',
  ع: 'A',
  غ: 'GH',
  ف: 'F',
  ق: 'Q',
  ك: 'K',
  ک: 'K',
  ل: 'L',
  م: 'M',
  ن: 'N',
  ه: 'H',
  ة: 'A',
  و: 'W',
  ؤ: 'U',
  ي: 'I',
  ى: 'A',
  ئ: 'I',
  ی: 'I',
  ے: 'E',
  ء: '',
  پ: 'P',
  چ: 'CH',
  ژ: 'ZH',
  گ: 'G',
  ٹ: 'T',
  ڈ: 'D',
  ڑ: 'R',
  ں: 'N',
  ھ: 'H',
};

function transliterateArabicChars(word: string): string {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === 'و' && i > 0 && i < word.length - 1) {
      out += 'O';
      continue;
    }
    if ((ch === 'ي' || ch === 'ى') && i === 0) {
      out += 'Y';
      continue;
    }
    if (Object.hasOwn(ARABIC_CHAR_TO_LATIN, ch)) {
      out += ARABIC_CHAR_TO_LATIN[ch];
    }
  }
  return out.replace(/(.)\1{2,}/g, '$1$1').trim();
}

function transliterateArabicWord(rawWord: string): string {
  const cleaned = rawWord.replace(ARABIC_DIACRITICS_RE, '').trim().slice(0, 80);
  if (!cleaned) return '';

  const lookup = SINGLE_ARABIC_NAMES.get(normalizeArabicKey(cleaned));
  if (lookup) return lookup;

  if (cleaned.startsWith('ال') && cleaned.length > 3) {
    const stem = cleaned.slice(2);
    const stemMapped =
      SINGLE_ARABIC_NAMES.get(normalizeArabicKey(stem)) ?? transliterateArabicChars(stem);
    return stemMapped ? `AL ${stemMapped}` : '';
  }

  return transliterateArabicChars(cleaned);
}

/**
 * Strips common Arabic name labels and converts Arabic-only person names into
 * uppercase Latin letters when no printed English name was extracted.
 */
export function transliterateArabicNameToLatin(raw: string): string | null {
  const bounded = raw.slice(0, 512);
  if (!containsArabicScript(bounded)) return null;

  const strippedLabel = bounded
    .replace(ARABIC_DIACRITICS_RE, '')
    .replace(
      /^\s*(?:الاسم\s+الكامل|الاسم\s+الرباعي|الاسم\s+الثلاثي|الاسم|الإسم|اسم\s+المقيم|اسم\s+العامل|اسم\s+الموظف|اسم\s+المسافر|اسم\s+حامل\s+الجواز|اسم)\s*[:：-]?\s*/i,
      ''
    )
    .trim();

  const keyCheck = normalizeArabicKey(strippedLabel);
  if (!keyCheck || ARABIC_NAME_BOILERPLATE.has(keyCheck)) return null;

  const tokens = strippedLabel
    .replace(/[^\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) return null;

  const resultParts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i + 1 < tokens.length) {
      const pairKey = normalizeArabicKey(`${tokens[i]} ${tokens[i + 1]}`);
      const compound = COMPOUND_ARABIC_NAMES.get(pairKey);
      if (compound) {
        resultParts.push(compound);
        i += 1;
        continue;
      }
    }
    const word = transliterateArabicWord(tokens[i]);
    if (word) resultParts.push(word);
  }

  const joined = resultParts.join(' ').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!joined || !/[A-Z]{2,}/.test(joined) || LATIN_NAME_BOILERPLATE.has(joined)) {
    return null;
  }
  return joined;
}
