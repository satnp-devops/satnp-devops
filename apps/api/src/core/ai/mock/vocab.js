// Vocabularies the rule-based mock reads enquiries with: cities and their time zones, exams,
// school boards, months and calling codes. Plain data, so adding a city or an exam is one line.

const IST = 'Asia/Kolkata';

/** [name as shown, time zone, country, ...other spellings] */
const CITY_ROWS = [
  ['Mumbai', IST, 'IN', 'bombay'],
  ['Navi Mumbai', IST, 'IN'],
  ['Thane', IST, 'IN'],
  ['Delhi', IST, 'IN', 'new delhi', 'dilli'],
  ['Noida', IST, 'IN', 'greater noida'],
  ['Gurugram', IST, 'IN', 'gurgaon'],
  ['Ghaziabad', IST, 'IN'],
  ['Faridabad', IST, 'IN'],
  ['Bengaluru', IST, 'IN', 'bangalore', 'bengaluru city'],
  ['Hyderabad', IST, 'IN', 'secunderabad'],
  ['Chennai', IST, 'IN', 'madras'],
  ['Kolkata', IST, 'IN', 'calcutta'],
  ['Pune', IST, 'IN', 'poona'],
  ['Ahmedabad', IST, 'IN'],
  ['Surat', IST, 'IN'],
  ['Vadodara', IST, 'IN', 'baroda'],
  ['Jaipur', IST, 'IN'],
  ['Kota', IST, 'IN'],
  ['Udaipur', IST, 'IN'],
  ['Jodhpur', IST, 'IN'],
  ['Lucknow', IST, 'IN'],
  ['Kanpur', IST, 'IN'],
  ['Varanasi', IST, 'IN', 'banaras'],
  ['Prayagraj', IST, 'IN', 'allahabad'],
  ['Agra', IST, 'IN'],
  ['Meerut', IST, 'IN'],
  ['Patna', IST, 'IN'],
  ['Ranchi', IST, 'IN'],
  ['Bhubaneswar', IST, 'IN'],
  ['Guwahati', IST, 'IN'],
  ['Raipur', IST, 'IN'],
  ['Nagpur', IST, 'IN'],
  ['Nashik', IST, 'IN'],
  ['Aurangabad', IST, 'IN'],
  ['Indore', IST, 'IN'],
  ['Bhopal', IST, 'IN'],
  ['Chandigarh', IST, 'IN', 'mohali', 'panchkula'],
  ['Ludhiana', IST, 'IN'],
  ['Amritsar', IST, 'IN'],
  ['Jalandhar', IST, 'IN'],
  ['Dehradun', IST, 'IN'],
  ['Shimla', IST, 'IN'],
  ['Jammu', IST, 'IN'],
  ['Srinagar', IST, 'IN'],
  ['Kochi', IST, 'IN', 'cochin', 'ernakulam'],
  ['Thiruvananthapuram', IST, 'IN', 'trivandrum'],
  ['Kozhikode', IST, 'IN', 'calicut'],
  ['Coimbatore', IST, 'IN'],
  ['Madurai', IST, 'IN'],
  ['Mysuru', IST, 'IN', 'mysore'],
  ['Mangaluru', IST, 'IN', 'mangalore'],
  ['Visakhapatnam', IST, 'IN', 'vizag'],
  ['Vijayawada', IST, 'IN'],
  ['Goa', IST, 'IN', 'panaji', 'margao'],
  ['Dubai', 'Asia/Dubai', 'AE'],
  ['Abu Dhabi', 'Asia/Dubai', 'AE'],
  ['Sharjah', 'Asia/Dubai', 'AE'],
  ['Doha', 'Asia/Qatar', 'QA'],
  ['Riyadh', 'Asia/Riyadh', 'SA'],
  ['Jeddah', 'Asia/Riyadh', 'SA'],
  ['Muscat', 'Asia/Muscat', 'OM'],
  ['Kuwait', 'Asia/Kuwait', 'KW', 'kuwait city'],
  ['Manama', 'Asia/Bahrain', 'BH', 'bahrain'],
  ['Singapore', 'Asia/Singapore', 'SG'],
  ['Kuala Lumpur', 'Asia/Kuala_Lumpur', 'MY'],
  ['Hong Kong', 'Asia/Hong_Kong', 'HK'],
  ['Kathmandu', 'Asia/Kathmandu', 'NP'],
  ['Dhaka', 'Asia/Dhaka', 'BD'],
  ['Colombo', 'Asia/Colombo', 'LK'],
  ['London', 'Europe/London', 'GB'],
  ['New York', 'America/New_York', 'US', 'nyc'],
  ['New Jersey', 'America/New_York', 'US'],
  ['Boston', 'America/New_York', 'US'],
  ['Chicago', 'America/Chicago', 'US'],
  ['Dallas', 'America/Chicago', 'US'],
  ['San Francisco', 'America/Los_Angeles', 'US', 'bay area'],
  ['Seattle', 'America/Los_Angeles', 'US'],
  ['Toronto', 'America/Toronto', 'CA'],
  ['Vancouver', 'America/Vancouver', 'CA'],
  ['Sydney', 'Australia/Sydney', 'AU'],
  ['Melbourne', 'Australia/Melbourne', 'AU'],
];

export const CITIES = CITY_ROWS.map(([name, timeZone, country, ...aliases]) => ({
  name,
  timeZone,
  country,
  spellings: [name.toLowerCase(), ...aliases],
}));

/** Longest spellings first, so "navi mumbai" wins over "mumbai" and "new delhi" over "delhi". */
export const CITY_SPELLINGS = CITIES.flatMap((city) => city.spellings.map((spelling) => ({ spelling, city }))).sort(
  (a, b) => b.spelling.length - a.spelling.length,
);

/** Calling code → time zone, only where the country has one main zone. */
export const CALLING_CODE_ZONES = [
  ['971', 'Asia/Dubai'],
  ['974', 'Asia/Qatar'],
  ['966', 'Asia/Riyadh'],
  ['968', 'Asia/Muscat'],
  ['965', 'Asia/Kuwait'],
  ['973', 'Asia/Bahrain'],
  ['977', 'Asia/Kathmandu'],
  ['880', 'Asia/Dhaka'],
  ['94', 'Asia/Colombo'],
  ['91', IST],
  ['65', 'Asia/Singapore'],
  ['60', 'Asia/Kuala_Lumpur'],
  ['44', 'Europe/London'],
];

/** Time zone abbreviations people write ("call after 6 pm IST"). */
export const ZONE_WORDS = [
  [/\bIST\b|\bindia time\b/, IST],
  [/\bGST\b|\bgulf time\b|\bUAE time\b/i, 'Asia/Dubai'],
  [/\bSGT\b|\bsingapore time\b/i, 'Asia/Singapore'],
  [/\b(EST|EDT)\b|\beastern time\b/, 'America/New_York'],
  [/\b(PST|PDT)\b|\bpacific time\b/, 'America/Los_Angeles'],
  [/\b(BST|GMT)\b|\buk time\b/i, 'Europe/London'],
];

/**
 * Exams and programs. `pattern` must match on its own; `caseSensitive` ones are common words in
 * lower case ("act", "cat"), so only their capitals count.
 */
export const EXAMS = [
  { name: 'JEE Advanced', pattern: /\bjee[\s-]*(adv|advanced|advance)\b|\biit[\s-]?jee\b/i },
  { name: 'JEE Main', pattern: /\bjee[\s-]*(main|mains)?\b/i },
  { name: 'NEET', pattern: /\bneet([\s-]?ug)?\b/i },
  { name: 'SAT', pattern: /\b(digital\s+)?sat\b(?!urday)/i },
  { name: 'PSAT', pattern: /\bpsat\b/i },
  { name: 'ACT', pattern: /\bACT\b/, caseSensitive: true },
  { name: 'AP', pattern: /\bAP (exams?|courses?|calculus|physics|chemistry|biology|computer science)\b|\badvanced placement\b/i },
  { name: 'IELTS', pattern: /\bielts\b/i },
  { name: 'TOEFL', pattern: /\btoefl\b/i },
  { name: 'PTE', pattern: /\bPTE\b/ },
  { name: 'Duolingo English Test', pattern: /\bduolingo\b|\bDET\b/ },
  { name: 'GRE', pattern: /\bgre\b/i },
  { name: 'GMAT', pattern: /\bgmat\b/i },
  { name: 'CAT', pattern: /\bCAT\b/, caseSensitive: true },
  { name: 'CUET', pattern: /\bcuet\b/i },
  { name: 'CLAT', pattern: /\bclat\b/i },
  { name: 'NDA', pattern: /\bNDA\b/ },
  { name: 'BITSAT', pattern: /\bbitsat\b/i },
  { name: 'UCAT', pattern: /\bucat\b/i },
  { name: 'Olympiad', pattern: /\bolympiads?\b|\b(IMO|NSO|IOQM|INMO)\b/i },
  { name: 'NTSE', pattern: /\bntse\b/i },
  { name: 'Board exams', pattern: /\bboard (exams?|preparation|prep)\b/i },
];

export const BOARDS = [
  { name: 'CBSE', pattern: /\bcbse\b/i },
  { name: 'ICSE', pattern: /\bicse\b/i },
  { name: 'ISC', pattern: /\bISC\b/ },
  { name: 'IB', pattern: /\bIB\b|\binternational baccalaureate\b/i },
  { name: 'IGCSE', pattern: /\bigcse\b|\bcambridge\b/i },
  { name: 'State board', pattern: /\bstate board\b|\b(SSC|HSC)\b/i },
];

export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export const MONTH_PATTERN = String.raw`jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`;
export const monthIndex = (word) => MONTHS.findIndex((m) => m.startsWith(String(word).toLowerCase().slice(0, 3)));

export const ROMAN_GRADES = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };

export const NUMBER_WORDS = { one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };
