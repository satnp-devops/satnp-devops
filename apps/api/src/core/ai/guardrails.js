import { amountIsGrounded, findDiscount, findLinks, findMoney, findTopics, injectionHints } from './text.js';

// Guardrails, enforced by the runner on every AI call (docs/platform/AI.md "Guardrails"). Pure.
//
// Each check returns { check, outcome, message, details? }:
//   pass      fine
//   flag      a person should look before the output is used
//   block     the output must not be used as it is (a person may still approve or edit it)
//   handover  a person must handle this instead of the AI
// Any flag, block or handover, a confidence below the company's threshold, or an agent that always
// needs approval puts the output in the review queue.

export const OUTCOMES = ['pass', 'flag', 'block', 'handover'];

const result = (check, outcome, message, details) => ({ check, outcome, message, ...(details ? { details } : {}) });
const list = (items) => items.map((i) => `“${i}”`).join(', ');

/**
 * Checks before calling the model, on the untrusted text. A `handover` (a handover topic on an
 * agent that writes to families) means the model is not called at all.
 * @returns {{ results: object[], handover: { reason: string } | null }}
 */
export function preChecks({ agent, input, settings }) {
  const results = [];
  const text = agent.untrusted(input) ?? '';

  results.push(
    settings.enabledAgents.includes(agent.key)
      ? result('agent_enabled', 'pass', 'The agent is switched on for this company.')
      : result('agent_enabled', 'flag', 'The agent is switched off for this company: a live call would be skipped.'),
  );

  const topics = findTopics(text, settings.handoverTopics);
  let handover = null;
  if (topics.length) {
    const outcome = agent.onTopic === 'handover' ? 'handover' : 'flag';
    results.push(
      result('handover_topic', outcome, `The message is about ${topics.map((t) => t.label.toLowerCase()).join(' and ')}: a person must handle it.`, {
        topics: topics.map((t) => t.key),
        matched: topics.map((t) => t.text),
      }),
    );
    if (outcome === 'handover') handover = { reason: topics[0].key };
  } else {
    results.push(result('handover_topic', 'pass', 'No handover topics.'));
  }

  const hints = injectionHints(text);
  results.push(
    hints.length
      ? result('prompt_injection', 'flag', `The message tries to instruct the AI: ${list(hints)}. It was treated as data only.`, { matched: hints })
      : result('prompt_injection', 'pass', 'No attempt to instruct the AI.'),
  );
  return { results, handover };
}

/**
 * Checks on the model's output. Customer-facing agents get the money, discount and link checks;
 * each agent adds its own (agent.check).
 */
export function postChecks({ agent, input, context, output, settings }) {
  const results = [];
  if (agent.customerFacing && agent.outputText) {
    const text = agent.outputText(output) ?? '';
    const facts = agent.factAmounts?.(input) ?? [];
    const sources = agent.sourceAmounts?.(context) ?? [];
    const amounts = findMoney(text).filter((m) => !amountIsGrounded(m, facts));
    if (amounts.length === 0) {
      results.push(result('fee_amount', 'pass', facts.length && findMoney(text).length ? 'States only the amount on record.' : 'Quotes no fees.'));
    } else if (!settings.mayQuoteFees) {
      results.push(result('fee_amount', 'block', `Quotes ${list(amounts.map((a) => a.text))}, but this company doesn't let the AI quote fees.`, { amounts: amounts.map((a) => a.text) }));
    } else {
      const ungrounded = amounts.filter((m) => !amountIsGrounded(m, sources));
      results.push(
        ungrounded.length
          ? result('fee_amount', 'block', `Quotes ${list(ungrounded.map((a) => a.text))}, which the knowledge base doesn't state.`, { amounts: ungrounded.map((a) => a.text) })
          : result('fee_amount', 'pass', 'Fees quoted as the knowledge base states them.'),
      );
    }

    const discount = findDiscount(text);
    if (!discount || settings.mayQuoteDiscounts) {
      results.push(result('discount', 'pass', discount ? 'Mentions a discount, which this company allows.' : 'Offers no discounts.'));
    } else {
      results.push(
        result(
          'discount',
          discount.level === 'offer' ? 'block' : 'flag',
          discount.level === 'offer' ? `Offers a discount (${list([discount.text])}), which this company doesn't allow.` : `Mentions ${list([discount.text])}; discounts need a person.`,
        ),
      );
    }

    const allowed = new Set((agent.allowedLinks?.(input, context) ?? []).map((l) => l.toLowerCase()));
    const strange = findLinks(text).filter((link) => !allowed.has(link.toLowerCase()));
    results.push(
      strange.length
        ? result('links', 'block', `Adds a link that wasn't given: ${list(strange)}.`, { links: strange })
        : result('links', 'pass', 'Only links that were given.'),
    );
  }
  for (const extra of agent.check?.(output, input, context) ?? []) results.push(extra);
  return results;
}

/**
 * The final status: completed, or pending_review with the reasons (check names). A handover
 * decided before the model call counts like any other.
 */
export function decide({ agent, results, confidence, threshold }) {
  const reasons = results.filter((r) => r.outcome !== 'pass' && r.check !== 'agent_enabled').map((r) => r.check);
  const all = [...results];
  if (confidence < threshold) {
    reasons.push('low_confidence');
    all.push(result('confidence', 'flag', `Confidence ${confidence.toFixed(2)} is below the ${threshold.toFixed(2)} this company needs.`));
  } else {
    all.push(result('confidence', 'pass', `Confidence ${confidence.toFixed(2)} meets the ${threshold.toFixed(2)} needed.`));
  }
  if (agent.alwaysReview) {
    reasons.push('approval_required');
    all.push(result('approval_required', 'flag', 'A person approves every draft from this agent before it is used.'));
  }
  const unique = [...new Set(reasons)];
  return { status: unique.length ? 'pending_review' : 'completed', reviewReasons: unique, guardrails: all };
}
