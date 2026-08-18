'use client';

import { useState } from 'react';

const COMMAND = 'npx graphyti';

export function StartButton() {
  const [copied, setCopied] = useState(false);

  return (
    <a
      className="btn-pill-outlined"
      href="#start"
      onClick={(event) => {
        event.preventDefault();
        navigator.clipboard.writeText(COMMAND).catch(() => undefined);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
        document.getElementById('start')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }}
    >
      {copied ? 'Copied' : 'Start'}
    </a>
  );
}
