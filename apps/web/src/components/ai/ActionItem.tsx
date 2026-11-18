'use client';

import { RelativeTime, StatusPill } from '@/components/crm';
import { Badge, Button } from '@/components/ui';
import { STATUS_LABEL, STATUS_TONE, outputHeadline, percent } from '@/lib/ai/display';
import type { AiAction } from '@/lib/ai/types';
import { ReasonChips } from './Guardrails';
import './ai.css';

/** What an AI action is about, in a few words: "D-1042 · Aarav Mehta SAT". */
export function actionSubject(action: AiAction): string {
  return [action.subject.dealRef, action.subject.dealTitle ?? action.subject.contactName ?? action.subject.accountName].filter(Boolean).join(' · ');
}

/** One AI action in a list (review queue, activity): agent, status, what came in and what it answered. */
export function ActionItem({ item, showCompany, onOpen }: { item: AiAction; showCompany: boolean; onOpen: () => void }) {
  const headline = outputHeadline(item.output);
  const subject = actionSubject(item);
  const reviewable = item.canReview && item.status === 'pending_review';
  return (
    <li className="ai-item">
      <div className="ai-item__main">
        <div className="ai-item__title">
          <span>{item.agentLabel}</span>
          <StatusPill tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</StatusPill>
          {item.mock ? <Badge title="Answered by the offline mock model">Mock</Badge> : null}
          {item.trigger === 'test' ? <Badge title="Run from the test panel">Test</Badge> : null}
        </div>
        <div className="ai-item__meta">
          {showCompany ? <span>{item.company.name}</span> : null}
          {subject ? <span>{subject}</span> : null}
          <span>
            <RelativeTime value={item.createdAt} sans />
          </span>
          <span>Confidence {percent(item.confidence)}</span>
          {item.reviewer ? <span>Reviewed by {item.reviewer.name}</span> : null}
        </div>
        {item.inputSummary ? <p className="ai-item__input">“{item.inputSummary}”</p> : null}
        {headline ? <p className="ai-item__output">{headline}</p> : null}
        {item.error ? <p className="ai-item__output ai-item__error">{item.error.message ?? item.error.code}</p> : null}
        <ReasonChips reasons={item.reviewReasons} />
      </div>
      <div className="ai-item__actions">
        <Button
          variant={reviewable ? 'primary' : 'default'}
          size="sm"
          onClick={onOpen}
          aria-label={`${reviewable ? 'Review' : 'View'} ${item.agentLabel} output${subject ? ` for ${subject}` : ''}`}
        >
          {reviewable ? 'Review' : 'View'}
        </Button>
      </div>
    </li>
  );
}
