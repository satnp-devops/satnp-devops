'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Spinner } from '@/components/ui';
import type { PublicForm } from '@/lib/intake/types';
import '@/components/intake/intake.css';

// The hosted website form (/f/<key>), shown on its own or inside the embed iframe. No session:
// it talks to the public intake endpoints only. The render token proves when the form was shown;
// the hidden "website" field is the honeypot.

type Values = Record<string, string | boolean>;

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;

function postHeight() {
  if (window.parent === window) return;
  window.parent.postMessage({ type: 'phoenix-form-height', height: document.documentElement.scrollHeight }, '*');
}

export function PublicFormView({ formKey }: { formKey: string }) {
  const [form, setForm] = useState<PublicForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({});
  const [consent, setConsent] = useState(false);
  const [hp, setHp] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const ref = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    ref.current = params.get('ref');
    const query = ref.current ? `?ref=${encodeURIComponent(ref.current)}` : '';
    fetch(`/api/v1/public/forms/${encodeURIComponent(formKey)}${query}`, { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'This form is not available.' : 'The form could not be loaded. Please try again.');
        const json = (await res.json()) as { data: PublicForm };
        setForm(json.data);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'The form could not be loaded.'));
  }, [formKey]);

  useEffect(() => {
    postHeight();
    const observer = new ResizeObserver(postHeight);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [form, done, errors]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSending(true);
    setErrors({});
    setFormError(null);
    const params = new URLSearchParams(window.location.search);
    const utm = Object.fromEntries(UTM_KEYS.map((k) => [k, params.get(`utm_${k}`) ?? '']).filter(([, v]) => v));
    // Inside the embed the referrer is the page the form sits on; on its own it is this page.
    const pageUrl = window.parent !== window && document.referrer ? document.referrer : window.location.href;
    try {
      const res = await fetch(`/api/v1/public/forms/${encodeURIComponent(form.key)}/submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Phoenix-Client': 'web-form' },
        body: JSON.stringify({
          fields: values,
          consent,
          token: form.token,
          hp,
          pageUrl: pageUrl.slice(0, 2000),
          ...(document.referrer ? { referrer: document.referrer.slice(0, 2000) } : {}),
          ...(ref.current ? { ref: ref.current } : {}),
          ...(Object.keys(utm).length ? { utm } : {}),
        }),
      });
      const json = (await res.json().catch(() => null)) as { data?: { thankYou: PublicForm['thankYou'] }; error?: { message?: string; details?: Array<{ path: string; message: string }> } } | null;
      if (res.status === 201 && json?.data) {
        const thankYou = json.data.thankYou;
        if (thankYou.mode === 'redirect') {
          (window.top ?? window).location.href = thankYou.redirectUrl;
          return;
        }
        setDone(thankYou.message);
        return;
      }
      if (res.status === 422 && json?.error?.details) {
        const next: Record<string, string> = {};
        for (const d of json.error.details) next[d.path.replace(/^body\.(fields\.)?/, '')] = d.message;
        setErrors(next);
        return;
      }
      setFormError(res.status === 429 ? 'Too many tries from this device. Please try again later.' : json?.error?.message ?? 'Something went wrong. Please try again.');
    } catch {
      setFormError("Can't reach the server. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  }

  if (loadError) {
    return (
      <main className="intake-public">
        <div className="intake-public__card">
          <Alert tone="error">{loadError}</Alert>
        </div>
      </main>
    );
  }
  if (!form) {
    return (
      <main className="intake-public">
        <div className="intake-public__card">
          <Spinner label="Loading the form" />
        </div>
      </main>
    );
  }
  if (done) {
    return (
      <main className="intake-public">
        <div className="intake-public__card" role="status">
          <h1>Thank you</h1>
          <p>{done}</p>
        </div>
      </main>
    );
  }

  const set = (key: string, value: string | boolean) => setValues((v) => ({ ...v, [key]: value }));
  return (
    <main className="intake-public">
      <form className="intake-public__card" onSubmit={(e) => void submit(e)} noValidate>
        <h1>{form.name}</h1>
        {form.fields.map((f) =>
          f.type === 'checkbox' ? (
            <label key={f.key} className="intake-public__consent">
              <input type="checkbox" checked={values[f.key] === true} onChange={(e) => set(f.key, e.target.checked)} />
              <span>
                {f.label}
                {errors[f.key] ? <span className="field__error"> {errors[f.key]}</span> : null}
              </span>
            </label>
          ) : (
            <Field key={f.key} label={f.label} optional={!f.required} hint={f.help ?? undefined} error={errors[f.key]}>
              {(control) =>
                f.type === 'textarea' ? (
                  <textarea {...control} className="textarea" rows={4} placeholder={f.placeholder ?? undefined} value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)} />
                ) : f.type === 'select' ? (
                  <select {...control} className="select" value={String(values[f.key] ?? '')} onChange={(e) => set(f.key, e.target.value)}>
                    <option value="">Choose…</option>
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    {...control}
                    className="input"
                    type={f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : f.type === 'number' ? 'number' : 'text'}
                    autoComplete={f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : undefined}
                    inputMode={f.type === 'phone' ? 'tel' : undefined}
                    placeholder={f.placeholder ?? undefined}
                    required={f.required}
                    value={String(values[f.key] ?? '')}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                )
              }
            </Field>
          ),
        )}
        {form.spam.honeypot ? (
          <div className="intake-public__hp" aria-hidden="true">
            <label>
              Website
              <input type="text" name="website" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} />
            </label>
          </div>
        ) : null}
        {form.consent ? (
          <label className="intake-public__consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} aria-invalid={errors.consent ? true : undefined} />
            <span>
              {form.consent.text}
              {errors.consent ? <span className="field__error"> {errors.consent}</span> : null}
            </span>
          </label>
        ) : null}
        {form.spam.captcha !== 'none' ? <Alert tone="info">This form uses a robot check that loads with the company&apos;s website.</Alert> : null}
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Button type="submit" variant="primary" block loading={sending}>
          Send
        </Button>
        <p className="intake-public__foot">Your details are used to answer this enquiry.</p>
      </form>
    </main>
  );
}
