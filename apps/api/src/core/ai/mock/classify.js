import { keywords } from '../text.js';
import { findExams } from './intake.js';

// Keyword classifiers: which company and product line a shared-channel enquiry is for, and the
// generic classify() over caller-given labels.

const GENERIC = new Set(['group', 'batch', 'course', 'program', 'programme', 'class', 'classe', 'classroom', 'coaching', 'tuition', 'centre', 'center', 'institute', 'academy', 'online', 'offline', 'plan', 'package', 'product', 'service']);

const squash = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const round = (n) => Math.round(n * 100) / 100;

/** Confidence from the best score and its lead over the runner-up. */
export function confidenceFrom(best, second) {
  if (best <= 0) return 0.2;
  return round(Math.min(0.95, 0.35 + 0.3 * Math.min(best, 1.5) / 1.5 + 0.35 * Math.min(best - second, 1)));
}

function termHits(terms, words, exams) {
  let hits = 0;
  for (const term of terms) {
    const word = term.toLowerCase();
    if (words.has(word) || exams.some((exam) => exam.toLowerCase().split(' ')[0] === word)) hits += 1;
  }
  return hits;
}

/**
 * Pick the company and product line for a message.
 * candidates: [{ companyId, companyName, keywords?, productLines: [{ id, name, keywords? }] }]
 * @returns {{ companyId, productLineId, confidence, rationale, alternatives }}
 */
export function classifyCompany(text, candidates) {
  const source = String(text ?? '');
  const words = new Set(keywords(source));
  const exams = findExams(source);
  const squashed = squash(source);
  const options = [];
  for (const candidate of candidates) {
    let companyScore = 0;
    const reasons = [];
    const nameKey = squash(candidate.companyName);
    if (nameKey.length >= 4 && squashed.includes(nameKey)) {
      companyScore += 1;
      reasons.push(`mentions ${candidate.companyName}`);
    }
    const companyTerms = termHits(candidate.keywords ?? [], words, exams);
    if (companyTerms) {
      companyScore += Math.min(0.6, companyTerms * 0.3);
      reasons.push(`talks about ${candidate.companyName}'s subjects`);
    }
    const lines = candidate.productLines?.length ? candidate.productLines : [null];
    for (const line of lines) {
      let lineScore = 0;
      if (line) {
        const nameTerms = keywords(line.name).filter((w) => !GENERIC.has(w));
        const nameHits = termHits(nameTerms, words, exams);
        const extraHits = termHits(line.keywords ?? [], words, exams);
        lineScore = Math.min(1, nameHits * 0.5 + extraHits * 0.3);
      }
      options.push({
        companyId: candidate.companyId,
        companyName: candidate.companyName,
        productLineId: line && lineScore > 0 ? line.id : null,
        productLineName: line && lineScore > 0 ? line.name : null,
        score: companyScore + lineScore,
        reasons: lineScore > 0 ? [...reasons, `matches ${line.name}`] : reasons,
      });
    }
  }
  // Best option per company, then rank companies.
  const perCompany = new Map();
  for (const option of options) {
    const current = perCompany.get(option.companyId);
    if (!current || option.score > current.score) perCompany.set(option.companyId, option);
  }
  const ranked = [...perCompany.values()].sort((a, b) => b.score - a.score || a.companyName.localeCompare(b.companyName));
  const [best, second] = ranked;
  if (!best) return { companyId: null, productLineId: null, confidence: 0, rationale: 'No companies to choose from.', alternatives: [] };
  const confidence = confidenceFrom(best.score, second?.score ?? 0);
  return {
    companyId: best.companyId,
    productLineId: best.productLineId,
    confidence,
    rationale: best.score > 0 ? `The message ${best.reasons.join(' and ')}.` : 'Nothing in the message points to one company.',
    alternatives: ranked.slice(1, 3).map((option) => ({
      companyId: option.companyId,
      productLineId: option.productLineId,
      confidence: confidenceFrom(option.score, best.score),
    })),
  };
}

/**
 * Generic classify(): labels [{ key, label, description?, keywords? }] scored by shared words.
 * @returns {{ label, confidence, scores: Record<string, number>, rationale }}
 */
export function classifyLabels(text, labels) {
  const words = new Set(keywords(text));
  const exams = findExams(text);
  const scores = {};
  for (const label of labels) {
    const terms = [...new Set([...keywords(label.label), ...keywords(label.description ?? ''), ...(label.keywords ?? []).map((k) => k.toLowerCase())])];
    const hits = termHits(terms, words, exams);
    scores[label.key] = round(terms.length ? Math.min(1, hits / Math.min(terms.length, 3)) : 0);
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  return {
    label: best && best[1] > 0 ? best[0] : null,
    confidence: best ? confidenceFrom(best[1], second?.[1] ?? 0) : 0,
    scores,
    rationale: best && best[1] > 0 ? `Shares the most words with "${labels.find((l) => l.key === best[0])?.label}".` : 'No label matches the text.',
  };
}
