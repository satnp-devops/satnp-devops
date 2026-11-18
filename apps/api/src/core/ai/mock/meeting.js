import { clip, keywordOverlap, keywords, sentences } from '../text.js';
import { findExams } from './intake.js';

// Extractive meeting summaries: the sentences that carry goals, concerns and next steps, and the
// catalogue program that best matches what was discussed.

const KEY = /\b(target|goal|score|aim|dream|college|university|weak|strong|struggl|batch|timing|schedule|weekend|evening|online|offline|fee|budget|instal|exam|attempt|mock|practice|syllabus|chapter|subject|math|maths|physics|chemistry|biology|english|reading|writing|verbal|quant)/i;
const CONCERN = /\b(worried|worry|concern|concerned|problem|issue|difficult|hard|weak|expensive|costly|tension|afraid|nervous|struggl|not sure|confused|doubt|clash|busy|tight)/i;
const NEXT = /\b(will send|will share|i'll send|we'll send|follow up|follow-up|next week|tomorrow|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|book(ed)? (a|the) (demo|slot|session)|payment link|send (the|a) (link|proposal|quote|fee)|enrol|register|call (you|again|back)|think about it|discuss with)/i;
const POSITIVE = /\b(great|good|happy|excited|interested|liked|helpful|clear|sounds good|perfect|thank you|thanks)\b/i;
const NEGATIVE = /\b(not interested|too expensive|unhappy|disappointed|waste|no time|not convinced|bad)\b/i;

const FORMAT_HINTS = [
  [/\b(1[:-]1|one[\s-]on[\s-]one|one to one|personal(ised)? (mentor|coaching|classes)|private (tutor|classes)|mentorship)\b/i, ['mentorship', '1:1', 'one', 'personal', 'private']],
  [/\b(group|batch|classroom|cohort)\b/i, ['group', 'batch']],
  [/\b(crash course|fast[\s-]?track|intensive|last[\s-]minute)\b/i, ['crash', 'fast', 'intensive']],
  [/\b(test series|mock tests?|practice tests?)\b/i, ['test', 'series', 'mock']],
];

/** Score each program against the transcript: exam names count most, then format words, then overlap. */
export function suggestProgram(transcript, programs = []) {
  if (!programs.length) return null;
  const exams = findExams(transcript).map((e) => e.toLowerCase());
  // The format talked about most ("one on one" twice beats "group batch" once).
  const counted = FORMAT_HINTS.map(([pattern, words]) => ({ words, count: (transcript.match(new RegExp(pattern.source, 'gi')) ?? []).length }))
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count);
  const formats = counted.length ? counted[0].words : [];
  const scored = programs.map((program) => {
    const text = `${program.name} ${program.description ?? ''} ${(program.keywords ?? []).join(' ')}`;
    const lower = text.toLowerCase();
    let score = keywordOverlap(keywords(text), transcript) * 0.3;
    if (exams.some((exam) => lower.includes(exam.split(' ')[0]))) score += 0.5;
    if (formats.some((word) => lower.includes(word))) score += 0.3;
    return { program, score };
  });
  scored.sort((a, b) => b.score - a.score || a.program.name.localeCompare(b.program.name));
  const best = scored[0];
  if (!best || best.score < 0.3) return null;
  const reasons = [
    exams.length ? `discussed ${findExams(transcript).join(', ')}` : null,
    formats.length ? `asked for ${formats[0] === '1:1' || formats[0] === 'mentorship' ? 'one-to-one help' : `a ${formats[0]} format`}` : null,
  ].filter(Boolean);
  return {
    productId: best.program.id ?? null,
    name: best.program.name,
    reason: reasons.length ? `The family ${reasons.join(' and ')}.` : 'Closest match to what was discussed.',
    score: Math.round(Math.min(1, best.score) * 100) / 100,
  };
}

/** Summarise a sales or counselling call. Pure and deterministic. */
export function summariseMeeting(input) {
  const transcript = String(input.transcript ?? '');
  const all = sentences(transcript.replace(/^\s*[A-Za-z ]{1,30}:\s*/gm, ''));
  const pick = (pattern, max) => all.filter((s) => pattern.test(s)).slice(0, max).map((s) => clip(s, 220));
  const keyPoints = pick(KEY, 5);
  const concerns = pick(CONCERN, 3);
  const nextSteps = pick(NEXT, 3);
  const suggested = suggestProgram(transcript, input.programs ?? []);
  const positive = all.filter((s) => POSITIVE.test(s)).length;
  const negative = all.filter((s) => NEGATIVE.test(s)).length;
  const sentiment = negative > positive ? 'negative' : positive > negative ? 'positive' : 'neutral';
  const opening = all.slice(0, 2).map((s) => clip(s, 200)).join(' ');
  const exams = findExams(transcript);
  const summary = clip(
    [exams.length ? `Discussed ${exams.join(', ')} preparation.` : null, keyPoints[0] ?? opening, concerns[0] ? `Concern: ${concerns[0]}` : null]
      .filter(Boolean)
      .join(' '),
    600,
  );
  const coverage = [keyPoints.length > 0, nextSteps.length > 0, Boolean(suggested), all.length >= 4].filter(Boolean).length;
  return {
    summary: summary || 'Short call with little to summarise.',
    keyPoints,
    concerns,
    nextSteps,
    suggestedProgram: suggested ? { productId: suggested.productId, name: suggested.name, reason: suggested.reason } : null,
    sentiment,
    confidence: Math.round(Math.min(0.9, 0.4 + coverage * 0.12) * 100) / 100,
  };
}

/** Generic summarise() mock: the opening, the sentences with the most content words, and action items. */
export function summariseText(transcript) {
  const all = sentences(transcript);
  const ranked = [...all].map((s, i) => ({ s, i, weight: keywords(s).length })).sort((a, b) => b.weight - a.weight || a.i - b.i);
  const top = ranked.slice(0, 3).sort((a, b) => a.i - b.i).map((r) => clip(r.s, 220));
  return {
    summary: clip(top.join(' '), 600) || 'Nothing to summarise.',
    keyPoints: top,
    actionItems: all.filter((s) => NEXT.test(s)).slice(0, 5).map((s) => clip(s, 220)),
    confidence: all.length >= 3 ? 0.7 : 0.45,
  };
}
