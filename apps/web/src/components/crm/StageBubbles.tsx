'use client';

import { useRef, type KeyboardEvent } from 'react';
import { Icon } from '../icons';
import { cx } from '../ui';
import './crm.css';

export type StageOutcome = 'won' | 'lost';

/** A pipeline stage, in pipeline order. Won and lost stages carry an outcome. */
export interface StageBubble {
  id: string;
  name: string;
  outcome?: StageOutcome | null;
}

type BubbleState = 'passed' | 'current' | 'upcoming';

/**
 * Which bubbles are filled. Open stages before the current one are passed. A won deal passed
 * every open stage; a lost deal passed the open stages up to `reachedId`, the furthest one it got to.
 */
export function stageStates(stages: readonly StageBubble[], currentId: string | null, reachedId?: string | null): BubbleState[] {
  const currentIndex = stages.findIndex((stage) => stage.id === currentId);
  const current = stages[currentIndex];
  if (!current) return stages.map(() => 'upcoming');
  const reachedIndex = current.outcome === 'won' ? stages.length : stages.findIndex((stage) => stage.id === reachedId);
  return stages.map((stage, index) => {
    if (index === currentIndex) return 'current';
    if (stage.outcome) return 'upcoming';
    if (!current.outcome) return index < currentIndex ? 'passed' : 'upcoming';
    return index <= reachedIndex ? 'passed' : 'upcoming';
  });
}

const STATE_TEXT: Record<BubbleState, string> = { passed: 'done', current: 'current stage', upcoming: 'not reached' };

function stateText(stage: StageBubble, state: BubbleState): string {
  if (state === 'current' && stage.outcome) return stage.outcome === 'won' ? 'won, current stage' : 'lost, current stage';
  return STATE_TEXT[state];
}

/**
 * Stage progress drawn as filled answer-sheet bubbles: one per stage in order, filled for stages
 * passed, a ring and fill on the current one, green when won and red when lost. Every bubble has
 * a text label (visible in the full size, read aloud in both), so colour is never the only signal.
 * With `onSelect`, bubbles are buttons for moving the deal (arrow keys move between them).
 */
export function StageBubbles({
  stages,
  currentId,
  reachedId,
  size = 'compact',
  label = 'Stage progress',
  showCurrent = true,
  onSelect,
  disabled = false,
}: {
  stages: readonly StageBubble[];
  currentId: string | null;
  reachedId?: string | null;
  size?: 'compact' | 'full';
  label?: string;
  /** Compact only: the current stage's name after the bubbles. */
  showCurrent?: boolean;
  onSelect?: (stage: StageBubble) => void;
  disabled?: boolean;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const states = stageStates(stages, currentId, reachedId);
  const currentIndex = states.indexOf('current');
  const current = stages[currentIndex];
  const full = size === 'full';
  const focusIndex = currentIndex >= 0 ? currentIndex : 0;

  function onKeyDown(event: KeyboardEvent<HTMLOListElement>) {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (index < 0) return;
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(index + 1, buttons.length - 1);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(index - 1, 0);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  }

  const outcomeClass = (stage: StageBubble) => (stage.outcome ? `crm-stage--${stage.outcome}` : undefined);

  return (
    <div className={cx('crm-stages', full ? 'crm-stages--full' : 'crm-stages--compact')}>
      <ol ref={listRef} className="crm-stages__list" aria-label={label} onKeyDown={onSelect ? onKeyDown : undefined}>
        {stages.map((stage, index) => {
          const state = states[index] ?? 'upcoming';
          const isCurrent = state === 'current';
          const bubble = (
            <span className="crm-stage__bubble" aria-hidden="true">
              {full ? <BubbleGlyph stage={stage} state={state} number={index + 1} /> : null}
            </span>
          );
          const name = (
            <span className={full ? 'crm-stage__name' : 'visually-hidden'}>
              {onSelect && !isCurrent ? <span className="visually-hidden">Move to </span> : null}
              {stage.name}
              <span className="visually-hidden">, {stateText(stage, state)}</span>
            </span>
          );
          return (
            <li
              key={stage.id}
              className={cx('crm-stage', `crm-stage--${state}`, outcomeClass(stage))}
              aria-current={isCurrent && !onSelect ? 'step' : undefined}
              title={full ? undefined : stage.name}
            >
              {onSelect ? (
                <button
                  type="button"
                  className="crm-stage__button"
                  aria-current={isCurrent ? 'step' : undefined}
                  tabIndex={index === focusIndex ? 0 : -1}
                  disabled={disabled}
                  onClick={() => {
                    if (!isCurrent) onSelect(stage);
                  }}
                >
                  {bubble}
                  {name}
                </button>
              ) : (
                <>
                  {bubble}
                  {name}
                </>
              )}
            </li>
          );
        })}
      </ol>
      {!full && showCurrent && current ? (
        <span className={cx('crm-stages__current', current.outcome && `crm-stages__current--${current.outcome}`)} aria-hidden="true">
          {current.name}
        </span>
      ) : null}
      {full ? (
        <p className="crm-stages__summary" aria-hidden="true">
          {current ? (
            <>
              <strong>{current.name}</strong>
              {current.outcome ? null : ` · stage ${currentIndex + 1} of ${stages.filter((stage) => !stage.outcome).length}`}
            </>
          ) : (
            'No stage yet'
          )}
        </p>
      ) : null}
    </div>
  );
}

/** Inside a full-size bubble: the stage number like an answer sheet, a tick when won, a cross when lost. */
function BubbleGlyph({ stage, state, number }: { stage: StageBubble; state: BubbleState; number: number }) {
  if (state === 'current' && stage.outcome === 'won') return <Icon name="check" size={14} strokeWidth={2.4} />;
  if (state === 'current' && stage.outcome === 'lost') return <Icon name="x" size={14} strokeWidth={2.4} />;
  if (stage.outcome === 'won' && state === 'upcoming') return <Icon name="check" size={13} />;
  if (stage.outcome === 'lost' && state === 'upcoming') return <Icon name="x" size={13} />;
  return <>{number}</>;
}
