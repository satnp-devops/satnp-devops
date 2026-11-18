'use client';

import { useState, type FormEvent } from 'react';
import { Dialog, DialogBody, DialogFooter } from '@/components/dialog';
import { Button, ErrorAlert, Field } from '@/components/ui';
import { fieldErrorsOf, formErrorOf } from '@/lib/api';
import type { DealDetail } from '@/lib/crm/types';
import { useAddNote, useAddTask, useDealAction, useDealOwners } from '@/lib/deals/hooks';
import { leadName } from './columns';

/** Give the lead to someone who works at its team (GET /crm/people with deals.manage there). */
export function AssignDialog({
  deal,
  open,
  onClose,
  onDone,
}: {
  deal: DealDetail;
  open: boolean;
  onClose: () => void;
  onDone: (deal: DealDetail) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Assign lead" description={`Who should work on ${leadName(deal)}?`}>
      <AssignForm deal={deal} onClose={onClose} onDone={onDone} />
    </Dialog>
  );
}

function AssignForm({ deal, onClose, onDone }: { deal: DealDetail; onClose: () => void; onDone: (deal: DealDetail) => void }) {
  const owners = useDealOwners(deal.unit.id);
  const action = useDealAction(deal.id);
  const [ownerId, setOwnerId] = useState(deal.owner?.id ?? '');
  const errors = fieldErrorsOf(action.error);

  function submit(event: FormEvent) {
    event.preventDefault();
    action.mutate({ type: 'assign', body: { ownerUserId: ownerId || null } }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={submit}>
      <DialogBody>
        <Field label="Owner" error={errors.ownerUserId} hint={`People who can work on leads in ${deal.unit.name}`}>
          {(control) => (
            <select {...control} className="select" value={ownerId} onChange={(event) => setOwnerId(event.target.value)} disabled={owners.isPending}>
              <option value="">{owners.isPending ? 'Loading people…' : 'Unassigned'}</option>
              {deal.owner && !(owners.data ?? []).some((person) => person.id === deal.owner?.id) ? (
                <option value={deal.owner.id}>{deal.owner.name}</option>
              ) : null}
              {(owners.data ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {owners.isError ? <ErrorAlert error={owners.error} title="Couldn't load the people of this team" /> : null}
        <ErrorAlert error={formErrorOf(action.error, ['ownerUserId'])} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={action.isPending}>
          Assign
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A note on the lead's timeline. */
export function NoteDialog({ deal, open, onClose, onDone }: { deal: DealDetail; open: boolean; onClose: () => void; onDone: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Add a note" description={`On ${leadName(deal)} (${deal.ref})`}>
      <NoteForm deal={deal} onClose={onClose} onDone={onDone} />
    </Dialog>
  );
}

function NoteForm({ deal, onClose, onDone }: { deal: DealDetail; onClose: () => void; onDone: () => void }) {
  const addNote = useAddNote(deal.id);
  const [body, setBody] = useState('');
  const [empty, setEmpty] = useState(false);
  const errors = fieldErrorsOf(addNote.error);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) {
      setEmpty(true);
      return;
    }
    addNote.mutate(body.trim(), { onSuccess: onDone });
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogBody>
        <Field label="Note" error={empty && !body.trim() ? 'Write something first' : errors.body}>
          {(control) => (
            <textarea
              {...control}
              className="textarea"
              rows={5}
              maxLength={20000}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              autoFocus
            />
          )}
        </Field>
        <ErrorAlert error={formErrorOf(addNote.error, ['body'])} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={addNote.isPending}>
          Add note
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Tomorrow at 10:00 in the viewer's time zone, as a datetime-local value. */
function tomorrowMorning(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(10, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T10:00`;
}

/** A follow-up task on the lead, assigned to the creator by default. */
export function TaskDialog({ deal, open, onClose, onDone }: { deal: DealDetail; open: boolean; onClose: () => void; onDone: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Add a task" description={`For ${leadName(deal)} (${deal.ref})`}>
      <TaskForm deal={deal} onClose={onClose} onDone={onDone} />
    </Dialog>
  );
}

function TaskForm({ deal, onClose, onDone }: { deal: DealDetail; onClose: () => void; onDone: () => void }) {
  const addTask = useAddTask(deal.id);
  const [title, setTitle] = useState(`Follow up with ${leadName(deal)}`);
  const [due, setDue] = useState(tomorrowMorning);
  const errors = fieldErrorsOf(addTask.error);

  function submit(event: FormEvent) {
    event.preventDefault();
    const dueAt = due ? new Date(due) : null;
    addTask.mutate({ title: title.trim(), dueAt: dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt.toISOString() : null }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={submit}>
      <DialogBody>
        <Field label="Task" error={errors.title}>
          {(control) => (
            <input {...control} className="input" required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
          )}
        </Field>
        <Field label="Due" optional error={errors.dueAt} hint="In your time zone">
          {(control) => <input {...control} type="datetime-local" className="input" value={due} onChange={(event) => setDue(event.target.value)} />}
        </Field>
        <ErrorAlert error={formErrorOf(addTask.error, ['title', 'dueAt'])} />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={addTask.isPending}>
          Add task
        </Button>
      </DialogFooter>
    </form>
  );
}
