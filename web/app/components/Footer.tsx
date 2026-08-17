'use client';

import React from 'react';
import { Network, ShieldCheck } from 'lucide-react';

export const Footer: React.FC = () => {
  return (
    <footer style={{ borderTop: '1px solid #2a2a2a', background: '#050505', padding: '40px 32px 30px' }}>
      <div style={{ maxWidth: '1380px', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '24px', marginBottom: '32px' }}>
          {/* Logo Mark + Wordmark */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ width: '24px', height: '24px', border: '1px solid #ff6a1a', borderRadius: '3px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,106,26,0.1)' }}>
              <Network size={14} color="#ff6a1a" />
            </div>
            <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 800, fontSize: '1.1rem', color: '#f5f5f5' }}>GRAPHYTI</span>
          </div>

          {/* Plain Text Nav Links */}
          <div style={{ display: 'flex', gap: '24px', fontSize: '0.85rem', color: '#8a8a8a' }}>
            <a href="#architecture" style={{ color: '#8a8a8a', textDecoration: 'none' }}>Open Source</a>
            <a href="#graph" style={{ color: '#8a8a8a', textDecoration: 'none' }}>TypeScript</a>
            <a href="#hydradb" style={{ color: '#8a8a8a', textDecoration: 'none' }}>HydraDB</a>
            <a href="https://github.com" target="_blank" rel="noreferrer" style={{ color: '#8a8a8a', textDecoration: 'none' }}>@graphyti_cli</a>
          </div>
        </div>

        {/* Legal & Guarantee Line */}
        <div style={{ borderTop: '1px solid #1a1a1a', paddingTop: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', fontSize: '0.78rem', color: '#555555' }}>
          <div>MIT License — Graphyti CLI Hackathon Submission</div>
          <div style={{ display: 'flex', gap: '16px' }}>
            <span style={{ cursor: 'pointer' }}>Privacy Policy</span>
            <span style={{ cursor: 'pointer' }}>Terms of Use</span>
          </div>
        </div>
      </div>
    </footer>
  );
};
