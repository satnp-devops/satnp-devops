'use client';

import { Icon } from '@/components/icons';
import { previewParts, renderTemplate, type RenderInput } from '@/lib/messaging/render';
import './messaging.css';

function Highlighted({ text }: { text: string }) {
  return (
    <>
      {previewParts(text).map((part, i) =>
        part.variable ? (
          <mark key={i} className="msg-var">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/**
 * How a template (or a free-text message) will look to the person, with the variables filled in.
 * Variables still missing a value are highlighted, like {{booking_link}}.
 */
export function TemplatePreview({ template, variables, label = 'Preview' }: { template: RenderInput; variables: Record<string, string>; label?: string }) {
  const rendered = renderTemplate(template, variables);
  const missing = rendered.missing.length;

  return (
    <figure className={`msg-preview msg-preview--${template.channel}`} aria-label={label}>
      {template.channel === 'whatsapp' ? (
        <div className="msg-bubble">
          {rendered.header ? (
            <p className="msg-bubble__header">
              <Highlighted text={rendered.header} />
            </p>
          ) : null}
          <p className="msg-bubble__body">{rendered.body ? <Highlighted text={rendered.body} /> : <span className="muted">Your message</span>}</p>
          {rendered.footer ? <p className="msg-bubble__footer">{rendered.footer}</p> : null}
          {rendered.buttons.length ? (
            <div className="msg-bubble__buttons">
              {rendered.buttons.map((button, i) => (
                <span key={i} className="msg-bubble__button">
                  <Icon name={button.type === 'url' ? 'external' : button.type === 'phone' ? 'phone' : 'arrowRight'} size={14} />
                  {button.text || 'Button'}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : template.channel === 'email' ? (
        <div className="msg-email">
          <p className="msg-email__subject">{rendered.subject ? <Highlighted text={rendered.subject} /> : <span className="muted">Subject</span>}</p>
          <p className="msg-email__body">{rendered.body ? <Highlighted text={rendered.body} /> : <span className="muted">Your message</span>}</p>
        </div>
      ) : (
        <div className="msg-sms">{rendered.body ? <Highlighted text={rendered.body} /> : <span className="muted">Your message</span>}</div>
      )}
      {missing > 0 ? (
        <figcaption className="msg-preview__note">
          {missing === 1 ? '1 variable still needs a value' : `${missing} variables still need values`}
        </figcaption>
      ) : null}
    </figure>
  );
}
