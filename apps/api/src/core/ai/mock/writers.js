import { clip, detectLanguage, keywordOverlap, keywords, sentences } from '../text.js';

// Template writers behind the mock: knowledge-base answers, follow-ups, payment reminders and the
// generic generate(). Deterministic, in English or Hinglish to match the family.

const first = (name) => (name ? String(name).trim().split(/\s+/)[0] : '');

/** How well an article answers a question (0..1): words shared with the whole article and with its title and tags. */
export function articleRelevance(question, article) {
  const wanted = keywords(question);
  if (!wanted.length) return 0;
  const body = keywordOverlap(wanted, `${article.title} ${article.body} ${(article.tags ?? []).join(' ')}`);
  const head = keywordOverlap(wanted, `${article.title} ${(article.tags ?? []).join(' ')}`);
  return Math.round((0.6 * body + 0.4 * head) * 100) / 100;
}

export const RELEVANCE_FLOOR = 0.25;

const HOLDING = {
  en: (name) => `Hi${name ? ` ${name}` : ''}, thank you for your message. One of our counsellors will get back to you shortly.`,
  hi: (name) => `Namaste${name ? ` ${name} ji` : ''}, aapke message ke liye dhanyavaad. Hamare counsellor aapse jaldi sampark karenge.`,
};

/**
 * Answer from the approved knowledge base only. No relevant article (or a handover reason) gives
 * a holding message and handover: true.
 */
export function answerFromKnowledge(input, articles, { handoverReason = null } = {}) {
  const language = input.language ?? detectLanguage(input.message).language;
  const tongue = language === 'hi' ? 'hi' : 'en';
  const name = first(input.contactName);
  const ranked = articles
    .map((article) => ({ article, relevance: articleRelevance(input.message, article) }))
    .sort((a, b) => b.relevance - a.relevance);
  const best = ranked[0];
  if (handoverReason || !best || best.relevance < RELEVANCE_FLOOR) {
    return {
      reply: HOLDING[tongue](name),
      handover: true,
      handoverReason: handoverReason ?? 'not_in_knowledge_base',
      sources: [],
      confidence: handoverReason ? 0.9 : 0.35,
    };
  }
  const wanted = keywords(input.message);
  const lines = sentences(best.article.body)
    .map((sentence, index) => ({ sentence, index, score: keywordOverlap(wanted, sentence) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen = lines.filter((l) => l.score > 0).slice(0, 2);
  const answer = (chosen.length ? chosen : lines.slice(0, 1)).sort((a, b) => a.index - b.index).map((l) => l.sentence).join(' ');
  const greeting = tongue === 'hi' ? `Namaste${name ? ` ${name} ji` : ''}! ` : `Hi${name ? ` ${name}` : ''}! `;
  const closing = tongue === 'hi' ? ' Aur kuch jaanna ho toh bataiye.' : ' Is there anything else you would like to know?';
  return {
    reply: clip(`${greeting}${answer}${closing}`, 1200),
    handover: false,
    handoverReason: null,
    sources: [best.article.id],
    confidence: Math.round(Math.min(0.92, 0.45 + best.relevance * 0.5) * 100) / 100,
  };
}

const GOAL_LINES = {
  book_demo: {
    en: (c) => `Following up on ${c.about}. Would you like to book a free demo session this week?${c.link ? ` You can pick a time here: ${c.link}` : ' I can share a few time slots.'}`,
    hi: (c) => `${c.about} ke baare mein follow up kar rahe hain. Kya aap is hafte ek free demo session book karna chahenge?${c.link ? ` Yahan time chun sakte hain: ${c.link}` : ' Main kuch time slots share kar sakta hoon.'}`,
  },
  share_details: {
    en: (c) => `As promised, I have the program details we discussed for ${c.about}. Shall I share them here, or would a quick call be easier?`,
    hi: (c) => `Jaisa baat hui thi, ${c.about} ke liye program details taiyar hain. Kya main yahin share karun, ya ek chhoti call better rahegi?`,
  },
  check_in: {
    en: (c) => `Just checking in on ${c.about}. Let me know if you have any questions at all.`,
    hi: (c) => `${c.about} ke baare mein haal-chaal jaanne ke liye message kiya. Koi bhi sawaal ho toh zaroor bataiye.`,
  },
  reengage: {
    en: (c) => `It has been a while since we spoke about ${c.about}. Are you still exploring options? I would be happy to help.`,
    hi: (c) => `${c.about} ke baare mein baat kiye kaafi samay ho gaya. Kya aap abhi bhi options dekh rahe hain? Main madad ke liye hoon.`,
  },
  next_step: {
    en: (c) => `A quick reminder about the next step for ${c.about}. Let me know if you need any help completing it.`,
    hi: (c) => `${c.about} ke agle step ke liye ek chhota sa reminder. Koi madad chahiye toh bataiye.`,
  },
};

/** A follow-up message a person approves before it is sent. */
export function writeFollowUp(input, { companyName } = {}) {
  const tongue = input.language === 'hi' ? 'hi' : 'en';
  const name = first(input.contactName);
  const about = [input.studentName ? `${first(input.studentName)}'s` : 'your', input.exam ? `${input.exam} preparation` : 'enquiry'].join(' ');
  const signer = [input.counsellorName ? first(input.counsellorName) : null, companyName].filter(Boolean).join(tongue === 'hi' ? ', ' : ' from ');
  const intro = tongue === 'hi' ? `Namaste${name ? ` ${name} ji` : ''}, ${signer ? `main ${signer} se. ` : ''}` : `Hi${name ? ` ${name}` : ''}, ${signer ? `this is ${signer}. ` : ''}`;
  const line = (GOAL_LINES[input.goal] ?? GOAL_LINES.check_in)[tongue]({ about, link: input.bookingLink ?? null });
  const message = `${intro}${line}`;
  return {
    channel: input.channel,
    subject: input.channel === 'email' ? `${companyName ? `${companyName}: ` : ''}${input.goal === 'book_demo' ? 'Your free demo session' : 'Following up'}` : null,
    message: input.channel === 'sms' ? clip(message, 300) : message,
    confidence: input.contactName ? 0.8 : 0.65,
  };
}

/** "₹45,000" for INR, "$1,200.50" for USD. */
export function formatAmount(amountMinor, currency) {
  const major = amountMinor / 100;
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(major);
}

const TONE_LINES = {
  friendly: {
    en: (c) => `a friendly reminder that ${c.amount}${c.invoice} is due ${c.days === 0 ? 'today' : `on ${c.dueDate}`}.`,
    hi: (c) => `ek friendly reminder: ${c.amount}${c.invoice} ki payment ${c.days === 0 ? 'aaj' : c.dueDate + ' ko'} due hai.`,
  },
  gentle: {
    en: (c) => `our records show ${c.amount}${c.invoice} was due on ${c.dueDate} and is still open. If you have already paid, please ignore this message.`,
    hi: (c) => `hamare records ke hisaab se ${c.amount}${c.invoice} ki payment ${c.dueDate} ko due thi aur abhi baaki hai. Agar aapne payment kar di hai toh is message ko ignore karein.`,
  },
  firm: {
    en: (c) => `${c.amount}${c.invoice} has been overdue since ${c.dueDate} (${c.days} days). Please complete the payment at the earliest to keep ${c.student} enrolled without interruption.`,
    hi: (c) => `${c.amount}${c.invoice} ki payment ${c.dueDate} se ${c.days} din overdue hai. ${c.student} ki classes bina rukawat chalti rahein, iske liye kripya jaldi payment karein.`,
  },
  final: {
    en: (c) => `${c.amount}${c.invoice} is now ${c.days} days overdue. Our accounts team will reach out to you to help settle it.`,
    hi: (c) => `${c.amount}${c.invoice} ki payment ab ${c.days} din overdue hai. Hamari accounts team aapse sampark karegi.`,
  },
};

export function toneFor(daysOverdue) {
  if (daysOverdue <= 0) return 'friendly';
  if (daysOverdue <= 7) return 'gentle';
  if (daysOverdue <= 30) return 'firm';
  return 'final';
}

/** A payment reminder that states only the amount and date it was given. */
export function writePaymentReminder(input, { companyName } = {}) {
  const tongue = input.language === 'hi' ? 'hi' : 'en';
  const tone = toneFor(input.daysOverdue);
  const name = first(input.contactName);
  const facts = {
    amount: formatAmount(input.amountDueMinor, input.currency),
    invoice: input.invoiceNumber ? (tongue === 'hi' ? ` (invoice ${input.invoiceNumber})` : ` for invoice ${input.invoiceNumber}`) : '',
    dueDate: input.dueDate,
    days: Math.abs(input.daysOverdue),
    student: input.studentName ? `${first(input.studentName)}` : tongue === 'hi' ? 'aapke bachche' : 'your child',
  };
  const greeting = tongue === 'hi' ? `Namaste${name ? ` ${name} ji` : ''}, ` : `Hi${name ? ` ${name}` : ''}, `;
  const link = input.paymentLink ? (tongue === 'hi' ? ` Payment link: ${input.paymentLink}` : ` You can pay here: ${input.paymentLink}`) : '';
  const sign = companyName ? (tongue === 'hi' ? ` – ${companyName}` : ` – ${companyName}`) : '';
  return {
    message: `${greeting}${TONE_LINES[tone][tongue](facts)}${link}${sign}`,
    tone,
    escalate: input.daysOverdue > 30 || input.remindersSent >= 3,
    confidence: 0.85,
  };
}

/** Generic generate() mock: a short, clearly marked draft built from the prompt and the facts given. */
export function draftText(prompt, context = {}) {
  const facts = Object.entries(context)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${clip(String(v), 60)}`);
  return {
    text: `Draft: ${clip(prompt, 240)}${facts.length ? `\n\n(${facts.join('; ')})` : ''}`,
    confidence: 0.6,
  };
}
