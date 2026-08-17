'use client';

import React, { useState } from 'react';
import { ShieldCheck, Network, Zap, Cpu, ArrowUpRight, Terminal, Check, Copy } from 'lucide-react';
import { AsciiNoiseField } from './AsciiNoiseField';

interface HeroSectionProps {
  onScrollToTerminal: () => void;
  onScrollToBlastRadius: () => void;
}

export const HeroSection: React.FC<HeroSectionProps> = ({ onScrollToTerminal, onScrollToBlastRadius }) => {
  const [copied, setCopied] = useState(false);

  const copyQuickstart = () => {
    navigator.clipboard.writeText('npx graphyti graph init');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const sidebarPanels = [
    {
      icon: ShieldCheck,
      label: 'Verify',
      subtext: 'Dual-layer check: local ts-morph AST re-parse + HydraDB relation cross-check before disk write.',
    },
    {
      icon: Network,
      label: 'Graph',
      subtext: 'HydraDB knowledge store maintains ground truth model edges and dependency relations.',
    },
    {
      icon: Zap,
      label: 'Blast Radius',
      subtext: 'Computes exact dependent API routes, Prisma schemas, and rendering components before execution.',
    },
    {
      icon: Cpu,
      label: 'Scoped Edits',
      subtext: 'Anchored AST structural mutations — zero surface area for silent full-file deletions.',
    },
  ];

  return (
    <section style={{ position: 'relative', minHeight: 'calc(100vh - 70px)', padding: '60px 32px 40px', background: '#0a0a0a', overflow: 'hidden' }}>
      {/* Decorative Grid Dot Pattern Top-Right */}
      <div className="top-right-grid"></div>

      <div style={{ maxWidth: '1380px', margin: '0 auto', position: 'relative', zIndex: 1 }}>
        {/* Top Grid Container: Left Headline/CTA + Right Sidebar */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 1.2fr) minmax(280px, 0.8fr)', gap: '48px', marginBottom: '40px' }}>
          
          {/* Left Column: Headline, Subhead, Outlined Pill Buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ fontSize: '0.8rem', color: '#ff6a1a', fontFamily: 'var(--font-mono)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '16px' }}>
              // ZERO STRUCTURAL HALLUCINATION
            </div>

            <h1
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 'clamp(2.8rem, 5vw, 4.8rem)',
                fontWeight: 800,
                lineHeight: 1.05,
                letterSpacing: '-0.04em',
                color: '#f5f5f5',
                marginBottom: '20px',
              }}
            >
              Code that verifies itself.
            </h1>

            <p
              style={{
                fontSize: '1.15rem',
                color: '#8a8a8a',
                lineHeight: 1.6,
                maxWidth: '580px',
                marginBottom: '36px',
              }}
            >
              Graphyti builds a real graph of your codebase and checks every AI-generated change against it before anything gets written to disk.
            </p>

            {/* Two Outlined Pill Buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
              <button onClick={onScrollToTerminal} className="btn-pill-outlined btn-pill-accent">
                <span>Build</span>
                <ArrowUpRight size={16} />
              </button>

              <button onClick={copyQuickstart} className="btn-pill-outlined">
                <Terminal size={15} color="#8a8a8a" />
                <span>{copied ? 'Copied quickstart' : 'Start (npx graphyti)'}</span>
                {copied ? <Check size={14} color="#ff6a1a" /> : <Copy size={14} color="#8a8a8a" />}
              </button>
            </div>
          </div>

          {/* Right Sidebar: Divided into 4 Hairline Panels */}
          <div
            style={{
              borderLeft: '1px solid #2a2a2a',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
            }}
          >
            {sidebarPanels.map((panel, idx) => {
              const Icon = panel.icon;
              return (
                <div
                  key={idx}
                  style={{
                    padding: '20px 24px',
                    borderBottom: idx < sidebarPanels.length - 1 ? '1px solid #2a2a2a' : 'none',
                    transition: 'background 0.2s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                    <div
                      style={{
                        width: '24px',
                        height: '24px',
                        borderRadius: '3px',
                        border: '1px solid #2a2a2a',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: '#0d0d0d',
                      }}
                    >
                      <Icon size={14} color="#ff6a1a" />
                    </div>

                    {/* Light Italic Serif Label for Contrast */}
                    <span className="font-serif-italic" style={{ fontSize: '1.35rem', color: '#f5f5f5' }}>
                      {panel.label}
                    </span>
                  </div>

                  <p style={{ fontSize: '0.82rem', color: '#8a8a8a', lineHeight: 1.5, margin: 0, paddingLeft: '36px' }}>
                    {panel.subtext}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Centerpiece: Interactive ASCII / Pixel-Art Noise Field Canvas */}
        <div style={{ marginTop: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: '#8a8a8a' }}>
              [INTERACTIVE CANVAS: MOVE CURSOR TO EXPOSE CODE GRAPH DENSITY]
            </span>
            <span style={{ fontSize: '0.75rem', fontFamily: 'var(--font-mono)', color: '#ff6a1a' }}>
              HYDRADB STORE: ACTIVE
            </span>
          </div>
          <div style={{ height: '380px' }}>
            <AsciiNoiseField />
          </div>
        </div>
      </div>
    </section>
  );
};
