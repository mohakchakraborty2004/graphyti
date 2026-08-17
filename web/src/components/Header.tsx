import React, { useState, useEffect } from 'react';
import { Network, Terminal, ShieldCheck, Cpu, Github, ExternalLink, Sparkles, Check, Copy } from 'lucide-react';

interface HeaderProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

export const Header: React.FC<HeaderProps> = ({ activeTab, setActiveTab }) => {
  const [scrolled, setScrolled] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const copyInstallCommand = () => {
    navigator.clipboard.writeText('npm install -g graphyti');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const navItems = [
    { id: 'hero', label: 'Overview' },
    { id: 'terminal', label: 'CLI Sandbox' },
    { id: 'blast-radius', label: 'Blast Radius' },
    { id: 'graph', label: 'Code Graph' },
    { id: 'architecture', label: 'Architecture' },
    { id: 'comparison', label: 'Why Graphyti' },
    { id: 'docs', label: 'Docs & CLI' },
  ];

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        padding: '16px 24px',
        transition: 'all 0.3s ease',
        background: scrolled ? 'rgba(7, 9, 14, 0.85)' : 'rgba(7, 9, 14, 0.4)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: scrolled ? '1px solid rgba(0, 242, 254, 0.2)' : '1px solid rgba(255, 255, 255, 0.05)',
      }}
    >
      <div
        style={{
          maxWidth: '1280px',
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        {/* Brand Logo */}
        <div
          onClick={() => setActiveTab('hero')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            cursor: 'pointer',
          }}
        >
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, rgba(0,242,254,0.2) 0%, rgba(168,85,247,0.2) 100%)',
              border: '1px solid rgba(0, 242, 254, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 20px rgba(0, 242, 254, 0.3)',
            }}
          >
            <Network size={22} color="#00f2fe" />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="font-heading" style={{ fontSize: '1.4rem', fontWeight: 800, letterSpacing: '-0.02em', color: '#fff' }}>
                GRAPHYTI
              </span>
              <span className="glass-pill glass-pill-cyan" style={{ fontSize: '0.7rem', padding: '2px 8px' }}>
                v1.0 CLI
              </span>
            </div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginTop: '-2px' }}>
              Deterministic Graph Verification
            </span>
          </div>
        </div>

        {/* Navigation Links */}
        <nav
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'rgba(255, 255, 255, 0.03)',
            padding: '4px 6px',
            borderRadius: '9999px',
            border: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setActiveTab(item.id);
                  const el = document.getElementById(item.id);
                  if (el) el.scrollIntoView({ behavior: 'smooth' });
                }}
                style={{
                  background: isActive ? 'linear-gradient(135deg, rgba(0, 242, 254, 0.2) 0%, rgba(168, 85, 247, 0.2) 100%)' : 'transparent',
                  border: isActive ? '1px solid rgba(0, 242, 254, 0.4)' : '1px solid transparent',
                  color: isActive ? '#00f2fe' : 'var(--text-muted)',
                  padding: '8px 16px',
                  borderRadius: '9999px',
                  fontSize: '0.85rem',
                  fontWeight: isActive ? 700 : 500,
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  boxShadow: isActive ? '0 0 15px rgba(0, 242, 254, 0.2)' : 'none',
                }}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Action Buttons & HydraDB Pill */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* HydraDB Badge */}
          <div className="glass-pill glass-pill-purple" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Cpu size={14} color="#c084fc" />
            <span>HydraDB Graph Sync</span>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 8px #10b981' }}></span>
          </div>

          {/* Quick Install Pill */}
          <button
            onClick={copyInstallCommand}
            className="btn-glass-secondary"
            style={{
              padding: '8px 14px',
              fontSize: '0.82rem',
              fontFamily: 'var(--font-mono)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <Terminal size={14} color="#38bdf8" />
            <span>npm i -g graphyti</span>
            {copied ? <Check size={14} color="#10b981" /> : <Copy size={14} color="var(--text-muted)" />}
          </button>
        </div>
      </div>
    </header>
  );
};
