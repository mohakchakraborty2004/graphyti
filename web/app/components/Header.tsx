'use client';

import React from 'react';
import { Network, Github, Terminal } from 'lucide-react';

export const Header: React.FC = () => {
  const [copied, setCopied] = React.useState(false);

  const copyInstall = () => {
    navigator.clipboard.writeText('npm install -g graphyti');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <header
      style={{
        borderBottom: '1px solid #2a2a2a',
        padding: '18px 32px',
        background: '#0a0a0a',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}
    >
      <div
        style={{
          maxWidth: '1380px',
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        {/* Minimal Logo Mark + Wordmark */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '28px',
              height: '28px',
              border: '1.5px solid #ff6a1a',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(255, 106, 26, 0.08)',
            }}
          >
            <Network size={16} color="#ff6a1a" />
          </div>
          <span
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '1.15rem',
              fontWeight: 800,
              letterSpacing: '-0.02em',
              color: '#f5f5f5',
            }}
          >
            GRAPHYTI
          </span>
          <span style={{ fontSize: '0.7rem', color: '#8a8a8a', fontFamily: 'var(--font-mono)', marginLeft: '4px' }}>
            v1.0
          </span>
        </div>

        {/* Minimal Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button
            onClick={copyInstall}
            className="btn-pill-outlined"
            style={{ padding: '6px 16px', fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}
          >
            <Terminal size={14} color="#ff6a1a" />
            <span>{copied ? 'Copied npx graphyti' : 'npm i -g graphyti'}</span>
          </button>
        </div>
      </div>
    </header>
  );
};
