'use client';

import { StatusPill } from '@/components/crm';
import { cx } from '@/components/ui';
import { OUTCOME_LABEL, OUTCOME_TONE, checkLabel, percent, reasonLabel } from '@/lib/ai/display';
import type { GuardrailResult } from '@/lib/ai/types';
import './ai.css';

/** Every guardrail check with its decision and reason. */
export function GuardrailList({ results }: { results: readonly GuardrailResult[] }) {
  if (results.length === 0) return <p className="small muted">No checks ran.</p>;
  return (
    <ul className="ai-guardrails">
      {results.map((result, i) => (
        <li key={`${result.check}-${i}`}>
          <span className="ai-guardrails__check">
            {checkLabel(result.check)}
            <span>
              <StatusPill tone={OUTCOME_TONE[result.outcome]}>{OUTCOME_LABEL[result.outcome]}</StatusPill>
            </span>
          </span>
          <span className="ai-guardrails__message">{result.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** Why an output waits for a person. */
export function ReasonChips({ reasons }: { reasons: readonly string[] }) {
  if (reasons.length === 0) return null;
  return (
    <div className="ai-item__reasons" aria-label="Why it needs review">
      {reasons.map((reason) => (
        <span key={reason} className="ai-reason">
          {reasonLabel(reason)}
        </span>
      ))}
    </div>
  );
}

/** Confidence as a bar, with the company's threshold marked. */
export function ConfidenceMeter({ confidence, threshold }: { confidence: number | null; threshold: number | null }) {
  if (confidence === null) return <span className="small muted">No confidence (the call failed)</span>;
  const low = threshold !== null && confidence < threshold;
  return (
    <div className="ai-meter">
      <div
        className="ai-meter__bar"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(confidence * 100)}
        aria-label={`Confidence ${percent(confidence)}${threshold !== null ? `, needs ${percent(threshold)}` : ''}`}
      >
        <span className={cx('ai-meter__fill', low && 'ai-meter__fill--low')} style={{ width: `${Math.round(confidence * 100)}%` }} />
        {threshold !== null ? <span className="ai-meter__mark" style={{ left: `calc(${Math.round(threshold * 100)}% - 1px)` }} aria-hidden="true" /> : null}
      </div>
      <div className="ai-meter__label">
        <span>Confidence {percent(confidence)}</span>
        {threshold !== null ? <span>Needs {percent(threshold)}</span> : null}
      </div>
    </div>
  );
}
