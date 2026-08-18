'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

type CommandEntry = {
  cmd: string;
  allowed: boolean;
};

const COMMANDS: CommandEntry[] = [
  { cmd: 'npx prisma generate', allowed: true },
  { cmd: 'npx prisma migrate dev', allowed: true },
  { cmd: 'rm -rf node_modules', allowed: false },
  { cmd: 'npx prisma db seed', allowed: true },
];

const TYPING_SPEED = 45;
const PAUSE_AFTER_TYPE = 400;
const PAUSE_AFTER_RESULT = 1200;

type Phase = 'idle' | 'typing' | 'result' | 'pause';

export function CommandTypewriter() {
  const [visibleLines, setVisibleLines] = useState<number[]>([]);
  const [currentText, setCurrentText] = useState('');
  const [currentPhase, setCurrentPhase] = useState<Phase>('idle');
  const [currentCmdIdx, setCurrentCmdIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    clearTimer();
    const cmd = COMMANDS[currentCmdIdx % COMMANDS.length];

    if (currentPhase === 'idle') {
      setVisibleLines([]);
      setCurrentText('');
      setCurrentPhase('typing');
      setCharIdx(0);
    } else if (currentPhase === 'typing') {
      if (charIdx <= cmd.cmd.length) {
        setCurrentText(cmd.cmd.slice(0, charIdx));
        timerRef.current = setTimeout(() => setCharIdx(charIdx + 1), TYPING_SPEED);
      } else {
        setCurrentPhase('result');
      }
    } else if (currentPhase === 'result') {
      setVisibleLines((prev) => [...prev, currentCmdIdx % COMMANDS.length]);
      setCurrentText('');
      setCurrentPhase('pause');
    } else if (currentPhase === 'pause') {
      timerRef.current = setTimeout(() => {
        setCurrentCmdIdx((prev) => prev + 1);
        setCurrentPhase('idle');
      }, PAUSE_AFTER_RESULT);
    }

    return clearTimer;
  }, [currentCmdIdx, currentPhase, charIdx, clearTimer]);

  return (
    <div className="cmd-tw">
      <div className="cmd-tw-header">
        <span className="cmd-tw-dot red" />
        <span className="cmd-tw-dot yellow" />
        <span className="cmd-tw-dot green" />
        <span className="cmd-tw-title">terminal</span>
      </div>
      <div className="cmd-tw-body">
        {visibleLines.map((idx) => {
          const entry = COMMANDS[idx];
          return (
            <div key={idx} className="cmd-tw-line">
              <span className="cmd-tw-prompt">$</span>
              <span className="cmd-tw-text">{entry.cmd}</span>
              <span className={`cmd-tw-badge ${entry.allowed ? 'allowed' : 'blocked'}`}>
                {entry.allowed ? '✓ allowed' : '✗ not on the allowlist'}
              </span>
            </div>
          );
        })}
        {currentPhase === 'typing' && (
          <div className="cmd-tw-line active">
            <span className="cmd-tw-prompt">$</span>
            <span className="cmd-tw-text">{currentText}</span>
            <span className="cmd-tw-cursor">█</span>
          </div>
        )}
        {currentPhase === 'result' && (
          <div className="cmd-tw-line">
            <span className="cmd-tw-prompt">$</span>
            <span className="cmd-tw-text">{COMMANDS[currentCmdIdx % COMMANDS.length].cmd}</span>
            <span className={`cmd-tw-badge ${COMMANDS[currentCmdIdx % COMMANDS.length].allowed ? 'allowed' : 'blocked'}`}>
              {COMMANDS[currentCmdIdx % COMMANDS.length].allowed ? '✓ allowed' : '✗ not on the allowlist'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
