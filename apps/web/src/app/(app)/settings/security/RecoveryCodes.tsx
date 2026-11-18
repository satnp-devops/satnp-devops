'use client';

import { Button, CopyButton } from '@/components/ui';

/** One-time recovery codes, shown once, with ways to keep them. */
export function RecoveryCodes({ codes, email }: { codes: string[]; email: string }) {
  const text = [
    'Phoenix Platform recovery codes',
    `Account: ${email}`,
    'Each code works once. Keep them somewhere safe, like a password manager.',
    '',
    ...codes,
  ].join('\n');

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'phoenix-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="stack gap-8">
      <ul className="code-block" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="row gap-8">
        <CopyButton text={codes.join('\n')} label="Copy codes" />
        <Button size="sm" icon="download" onClick={download}>
          Download
        </Button>
      </div>
    </div>
  );
}
