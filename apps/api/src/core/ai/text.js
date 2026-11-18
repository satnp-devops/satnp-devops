import { maskEmail, maskPhone } from '../crm/pii.js';

// Pure text helpers shared by the guardrails and the rule-based mock: untrusted-text delimiting,
// prompt-injection hints, money and discount mentions, handover topics, language, keywords and
// PII masking. English and romanised Hindi ("Hinglish") as Indian families write them.

// ---------- Untrusted input ----------

/**
 * Wrap outside text (a customer's message, a transcript) so the model reads it as data. Anything
 * inside that looks like our own tags is defused, so a message can't "close" the block and carry on
 * as instructions. Control characters are dropped.
 */
export function delimitUntrusted(text, { tag = 'untrusted_input', label } = {}) {
  const clean = String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    // "< / untrusted_input >", "<\n/context>" and fullwidth "＜" read as tags to a model too.
    .replace(/[<＜﹤](\s*\/?\s*)(untrusted_input|knowledge_base|context|system|instructions?)\b/gi, '‹$1$2');
  const attrs = label ? ` source="${String(label).replace(/[^a-z0-9 _-]/gi, '')}"` : '';
  return `<${tag}${attrs}>\n${clean}\n</${tag}>`;
}

const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|the)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|guidelines|directions)\b/i,
  /\b(system|developer)\s*(prompt|message|mode)\b/i,
  /\byou are now\b|\bact as (an?|the) (admin|system|developer|assistant)\b|\bpretend (to be|you are)\b/i,
  /\b(reveal|show|print|repeat)\b[^.\n]{0,30}\b(prompt|instructions|system message)\b/i,
  /\bjailbreak\b|\bDAN mode\b/i,
  /<\/?\s*(system|assistant|instructions?|untrusted_input)\s*>/i,
  /\b(new|updated) instructions\s*:/i,
  /\b(mark|set|change|move)\b[^.\n]{0,30}\b(as|to)\s+(paid|enrolled|won|approved|refunded|verified)\b/i,
  /\b(give|grant|apply)\b[^.\n]{0,20}(100\s?%|\bfull\b|\bfree\b)[^.\n]{0,20}\b(discount|refund|waiver|scholarship)\b/i,
];

/** Phrases that try to steer the model rather than ask a question. Returns the matching snippets. */
export function injectionHints(text) {
  const source = String(text ?? '');
  const hits = [];
  for (const pattern of INJECTION_PATTERNS) {
    const match = source.match(pattern);
    if (match) hits.push(match[0].slice(0, 80));
  }
  return hits;
}

// ---------- Money ----------

const SCALE = { k: 1_000, thousand: 1_000, hazaar: 1_000, hazar: 1_000, hajar: 1_000, l: 100_000, lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000, cr: 10_000_000, crore: 10_000_000, crores: 10_000_000 };
const CURRENCY_WORDS = { '₹': 'INR', rs: 'INR', 'rs.': 'INR', inr: 'INR', rupee: 'INR', rupees: 'INR', rupaye: 'INR', rupaiye: 'INR', '/-': 'INR', $: 'USD', usd: 'USD', dollar: 'USD', dollars: 'USD', aed: 'AED', dirham: 'AED', dirhams: 'AED', '£': 'GBP', gbp: 'GBP', '€': 'EUR', eur: 'EUR', sgd: 'SGD' };
const NUMBER = String.raw`\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const SCALE_WORD = String.raw`k|thousand|hazaar|hazar|hajar|lakhs?|lacs?|l|crores?|cr`;
const PREFIX_CURRENCY = String.raw`₹|rs\.?|inr|\$|usd|aed|£|gbp|€|eur|sgd`;
const SUFFIX_CURRENCY = String.raw`rupees?|rupaye|rupaiye|rs\.?|inr|\/-|usd|dollars?|aed|dirhams?|gbp|eur|sgd`;

const MONEY_PATTERNS = [
  // ₹45,000 · Rs. 1.5 lakh · $1,200 · INR 30k
  new RegExp(String.raw`(?<![\w])(${PREFIX_CURRENCY})\s?(${NUMBER})\s?(${SCALE_WORD})?(?![\w])`, 'gi'),
  // 45,000 rupees · 45000/- · 2 lakh rupaye · 300 dollars
  new RegExp(String.raw`(?<![\w.,])(${NUMBER})\s?(${SCALE_WORD})?\s?(${SUFFIX_CURRENCY})(?![\w])`, 'gi'),
  // 1.5 lakh · 2 lakhs · 3 crore (Indian amounts without a currency)
  new RegExp(String.raw`(?<![\w.,])(${NUMBER})\s?(lakhs?|lacs?|crores?)(?![\w])`, 'gi'),
];

const toAmount = (number, scale) => {
  const value = Number(String(number).replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * (scale ? SCALE[scale.toLowerCase()] ?? 1 : 1));
};

/**
 * Money amounts mentioned in a text: [{ text, amount, currency, amountMinor }], in order.
 * `amount` is in major units; `amountMinor` assumes two decimals (INR, USD, AED, GBP, EUR, SGD).
 */
export function findMoney(text) {
  const source = String(text ?? '');
  const found = [];
  const seen = [];
  const overlaps = (start, end) => seen.some(([s, e]) => start < e && end > s);
  MONEY_PATTERNS.forEach((pattern, index) => {
    for (const match of source.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) continue;
      let number;
      let scale;
      let currencyWord;
      if (index === 0) [, currencyWord, number, scale] = match;
      else if (index === 1) [, number, scale, currencyWord] = match;
      else [, number, scale] = match;
      const amount = toAmount(number, scale);
      if (amount === null || amount === 0) continue;
      // Bare years and counts are not money.
      if (index === 2 && amount < 1000) continue;
      const currency = currencyWord ? CURRENCY_WORDS[currencyWord.toLowerCase()] ?? 'INR' : 'INR';
      seen.push([start, end]);
      found.push({ text: match[0].trim(), amount, currency, amountMinor: amount * 100, index: start });
    }
  });
  return found.sort((a, b) => a.index - b.index).map(({ index, ...rest }) => rest);
}

/** Is this amount (same currency, same value) among the allowed ones? */
export function amountIsGrounded(mention, allowed) {
  return allowed.some((a) => a.currency === mention.currency && a.amountMinor === mention.amountMinor);
}

// ---------- Discounts ----------

const DISCOUNT_STRONG = [
  /\b\d{1,3}\s?(%|percent|per cent|pc)\s*(off|discount|concession|scholarship|waiver|cashback|kam)\b/i,
  /\b(discount|concession|scholarship|waiver|rebate|cashback)\s+(of|worth)\s+/i,
  /\b(flat|extra|special)\s+(₹|rs\.?|inr|\$)?\s?\d[\d,]*\s?(k)?\s*(off|discount)\b/i,
  /\b(coupon|promo)\s*(code)?\s*[:=]?\s*[A-Z0-9]{4,}\b/,
  /\bearly[\s-]?bird\b/i,
  /\b(we|i) (can|will|could) (offer|give|apply|waive)\b/i,
  /\b(offer|special|discounted|reduced) (price|fee|fees|rate)\b/i,
  /\bfees? (kam|kum) (kar|ho)\b/i,
];
const DISCOUNT_WEAK = /\b(discount|discounts|concession|scholarship|scholarships|waiver|rebate|offer|chhoot|chhut)\b/i;
const NEGATION = /\b(no|not|cannot|can't|cant|unable|don't|dont|nahi|nahin)\b[^.!?\n]{0,40}$/i;

/**
 * Does a text offer a discount? `offer` for concrete offers (10% off, a coupon, "we can waive"),
 * `mention` for the word alone (not negated: "no discounts" doesn't count), otherwise null.
 */
export function findDiscount(text) {
  const source = String(text ?? '');
  for (const pattern of DISCOUNT_STRONG) {
    const match = source.match(pattern);
    if (match) return { level: 'offer', text: match[0].trim() };
  }
  const weak = source.match(DISCOUNT_WEAK);
  if (weak && !NEGATION.test(source.slice(Math.max(0, weak.index - 60), weak.index))) {
    return { level: 'mention', text: weak[0] };
  }
  return null;
}

// ---------- Handover topics ----------

/**
 * Topics a person must handle. Companies pick theirs in the `ai.handoverTopics` setting.
 * Keywords cover English and romanised Hindi; matching is on word boundaries.
 */
export const HANDOVER_TOPICS = [
  {
    key: 'refund',
    label: 'Refunds',
    patterns: [/\brefunds?\b|\brefunded\b|\bmoney back\b|\bchargeback\b/i, /\b(return|give back)\b[^.\n]{0,20}\b(money|fees?|payment|amount)\b/i, /\b(paise|paisa|paisey|rupaye|fees?)\b[^.\n]{0,15}\b(wapas|vapas|wapis|vapis)\b/i],
  },
  {
    key: 'complaint',
    label: 'Complaints',
    patterns: [/\bcomplain(t|ts|ed|ing)?\b|\bshikayat\b/i, /\b(not happy|unhappy|disappointed|very bad|worst|terrible|pathetic|horrible|useless|fraud|scam|cheat(ed|ing)?|bakwas|bekar|ghatiya)\b/i, /\bescalat(e|ion)\b/i],
  },
  {
    key: 'cancellation',
    label: 'Cancellations and withdrawals',
    patterns: [/\bcancel(l?ed|ling|lation)?\b[^.\n]{0,30}\b(admission|enrol(l)?ment|course|batch|subscription|seat|registration|classes)\b/i, /\b(withdraw|discontinue|drop out of|leave the (course|batch))\b/i, /\b(band|cancel) (karna|karo|kar do|karwana)\b/i],
  },
  {
    key: 'legal',
    label: 'Legal threats',
    patterns: [/\b(lawyer|advocate|legal (notice|action)|court|consumer (forum|court)|police|fir|sue)\b/i],
  },
  {
    key: 'payment_dispute',
    label: 'Payment disputes',
    patterns: [/\b(charged|deducted|debited|paid) (twice|two times|double)\b|\bdouble (charged|payment|deduction)\b/i, /\b(amount|money|paise) (deducted|kat gaye|cut)\b[^.\n]{0,40}\b(not|but|failed|nahi)\b/i, /\bwrong (amount|charge)\b/i],
  },
  {
    key: 'safety',
    label: 'Safety and wellbeing',
    patterns: [/\b(harass(ed|ment)?|abuse(d)?|threat(en(ed)?)?|bully(ing)?|suicid(e|al)|self[\s-]?harm|depress(ed|ion))\b/i],
  },
];

export const HANDOVER_TOPIC_KEYS = HANDOVER_TOPICS.map((t) => t.key);

/** Handover topics a text touches, limited to `keys` (default all): [{ key, label, text }]. */
export function findTopics(text, keys = HANDOVER_TOPIC_KEYS) {
  const source = String(text ?? '');
  const found = [];
  for (const topic of HANDOVER_TOPICS) {
    if (!keys.includes(topic.key)) continue;
    for (const pattern of topic.patterns) {
      const match = source.match(pattern);
      if (match) {
        found.push({ key: topic.key, label: topic.label, text: match[0].trim() });
        break;
      }
    }
  }
  return found;
}

// ---------- Links ----------

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;

/** Web links in a text, without trailing punctuation. */
export function findLinks(text) {
  return [...String(text ?? '').matchAll(URL_PATTERN)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
}

// ---------- Language ----------

/** Romanised Hindi words that rarely appear in English sentences. */
const HINGLISH_MARKERS = new Set(
  (
    'hai hain hoon hun mera meri mere mujhe mujhko humko hamara hamari kya kitni kitna kitne karna karni karne chahiye chahte chahti ' +
    'nahi nahin aap apka apki aapka aapki hum beta beti bachcha bachche bacchon kaise kab kahan kaha wala wali liye bhi toh aur karo ' +
    'karein kijiye dijiye batao bataiye bataye sakte sakti sakta padhai padhna taiyari tayari thi tha hoga hogi accha acha theek thik ' +
    'ji jaankari jankari baat krna krni krne milega milegi kyunki lekin abhi agar shuru wapas paise samay din raha rahi'
  ).split(/\s+/),
);

const SCRIPTS = [
  [/[ऀ-ॿ]/, 'hi'],
  [/[ঀ-৿]/, 'bn'],
  [/[਀-੿]/, 'pa'],
  [/[઀-૿]/, 'gu'],
  [/[஀-௿]/, 'ta'],
  [/[ఀ-౿]/, 'te'],
  [/[ಀ-೿]/, 'kn'],
  [/[ഀ-ൿ]/, 'ml'],
  [/[؀-ۿ]/, 'ar'],
];

/** The language of a message: { language (ISO 639-1), hinglish (Hindi written in Latin letters) }. */
export function detectLanguage(text) {
  const source = String(text ?? '');
  for (const [pattern, language] of SCRIPTS) {
    if (pattern.test(source)) return { language, hinglish: false };
  }
  const words = source.toLowerCase().match(/[a-z]+/g) ?? [];
  const markers = words.filter((w) => HINGLISH_MARKERS.has(w)).length;
  if (markers >= 2 || (words.length > 0 && markers / words.length >= 0.15 && markers >= 1)) return { language: 'hi', hinglish: true };
  return { language: 'en', hinglish: false };
}

// ---------- Keywords ----------

const STOPWORDS = new Set(
  (
    'a an the and or but if of to in on at for from by with about as is are was were be been am do does did have has had i me my we our ' +
    'you your he she his her it its they them their this that these those there here what which who whom when where why how can could ' +
    'would should will shall may might must please hi hello hey dear sir madam ma am pm ok okay thanks thank regards kindly also just ' +
    'want wants need needs know tell like get any some more much very so too not no yes us let would' +
    ' hai hain ho hoon hun ka ki ke ko se me mein par pe kya koi kuch bhi toh aur ya ji mera meri mere hum aap apka apki aapka aapki ' +
    'tha thi the hoga hogi raha rahi chahiye chahte karna karni karne kar karo karein batao bataiye bataye kitna kitni kitne'
  ).split(/\s+/),
);

/** Lower-case content words, plural "s" dropped ("fees" → "fee"), without English and Hinglish stopwords. */
export function keywords(text) {
  const words = String(text ?? '').toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = [];
  for (const raw of words) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const word = raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

/** Share of `query` keywords found in `text` (0..1). */
export function keywordOverlap(query, text) {
  const wanted = Array.isArray(query) ? query : keywords(query);
  if (wanted.length === 0) return 0;
  const have = new Set(keywords(text));
  return wanted.filter((w) => have.has(w)).length / wanted.length;
}

/** Split prose into sentences (keeps the punctuation). */
export function sentences(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?।])\s+(?=[A-Z0-9"'(ऀ-ॿ])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- Personal data in free text ----------

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_IN_TEXT = /(?<![\w])(?:\+|00)?\d[\d\s().-]{7,16}\d(?![\w])/g;

/** Mask phone numbers and email addresses inside free text (for people without contacts.view_pii). */
export function maskPiiText(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(EMAIL_IN_TEXT, (email) => maskEmail(email) ?? '•••')
    .replace(PHONE_IN_TEXT, (phone) => {
      const digits = phone.replace(/\D/g, '');
      if (digits.length < 8) return phone;
      // Longer than any phone: numbers next to each other ("98765 43210 91234 56789", or across
      // lines of a CSV). Hide every digit but the last three rather than show them.
      if (digits.length > 15) return phone.replace(/\d(?=(?:\D*\d){3})/g, '•');
      return maskPhone(phone.trim().startsWith('+') ? `+${digits}` : digits) ?? phone;
    });
}

// Whole-string ids and dates inside JSON are never personal data, but runs of their digits can look
// like a phone number ("…-1234-5678-9012-…", "2026-11-12"), so maskPiiDeep leaves them alone.
const ID_OR_DATE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?)$/i;

/** Apply maskPiiText to every string inside a JSON value (ids and ISO dates kept as they are). */
export function maskPiiDeep(value) {
  if (typeof value === 'string') return ID_OR_DATE.test(value) ? value : maskPiiText(value);
  if (Array.isArray(value)) return value.map(maskPiiDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskPiiDeep(v)]));
  return value;
}

/**
 * Put back hidden values a reviewer could not see: a string in `edited` that equals the masked
 * form of the original at the same path is replaced by the original.
 */
export function restoreMasked(edited, original) {
  if (typeof edited === 'string') {
    return typeof original === 'string' && edited !== original && maskPiiText(original) === edited ? original : edited;
  }
  if (Array.isArray(edited)) return edited.map((item, i) => restoreMasked(item, Array.isArray(original) ? original[i] : undefined));
  if (edited && typeof edited === 'object') {
    return Object.fromEntries(Object.entries(edited).map(([k, v]) => [k, restoreMasked(v, original && typeof original === 'object' ? original[k] : undefined)]));
  }
  return edited;
}

/** Every string inside a JSON value, joined (for scanning outputs). */
export function allText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(allText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(allText).join('\n');
  return '';
}

/** Shorten to `max` characters on a word boundary, with an ellipsis. */
export function clip(text, max = 200) {
  const source = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (source.length <= max) return source;
  const cut = source.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
