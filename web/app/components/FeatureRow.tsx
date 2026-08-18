'use client';

import { useRef, useState, useEffect, useCallback, ReactNode } from 'react';

const GLITCH_CHARS = '@#%&*!$#@!%^&*';

function scrambleTitle(
  title: string,
  progress: number,
  seed: number
): string {
  return title
    .split('')
    .map((char, i) => {
      if (char === ' ') return ' ';
      const charProgress = Math.min(1, Math.max(0, (progress * title.length - i * 0.5) / (title.length * 0.5)));
      if (charProgress >= 1) return char;
      const randIdx = Math.floor(
        ((Math.sin(seed * 100 + i * 31 + progress * 200) + 1) / 2) *
        GLITCH_CHARS.length
      );
      return GLITCH_CHARS[randIdx];
    })
    .join('');
}

type FeatureRowProps = {
  title: string;
  description: string[];
  visualization: ReactNode;
  side?: 'left' | 'right';
};

export function FeatureRow({
  title,
  description,
  visualization,
  side = 'left',
}: FeatureRowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [revealProgress, setRevealProgress] = useState(0);
  const [titleDone, setTitleDone] = useState(false);
  const [visibleLines, setVisibleLines] = useState(0);
  const animRef = useRef<number>(0);
  const startTimeRef = useRef(0);

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.unobserve(el);
        }
      },
      { threshold: 0.35 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    startTimeRef.current = performance.now();
    const duration = 700;
    const tick = () => {
      const elapsed = performance.now() - startTimeRef.current;
      const p = Math.min(1, elapsed / duration);
      setRevealProgress(p);
      if (p < 1) {
        animRef.current = requestAnimationFrame(tick);
      } else {
        setTitleDone(true);
      }
    };
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [isVisible]);

  useEffect(() => {
    if (!titleDone) return;
    let lineIdx = 0;
    const interval = setInterval(() => {
      lineIdx++;
      setVisibleLines(lineIdx);
      if (lineIdx >= description.length) clearInterval(interval);
    }, 300);
    return () => clearInterval(interval);
  }, [titleDone, description.length]);

  const scrambled = scrambleTitle(title, revealProgress, title.length);

  const textContent = (
    <div className="feature-row-text">
      <div className="feature-row-title-wrap">
        {!titleDone && (
          <h3 className="feature-row-title-scrambled">{scrambled}</h3>
        )}
        <h3
          className="feature-row-title-final"
          style={{ opacity: titleDone ? 1 : 0 }}
        >
          {title}
        </h3>
      </div>
      <div className="feature-row-desc">
        {description.map((line, i) => (
          <p
            key={i}
            className="feature-row-desc-line"
            style={{
              opacity: i < visibleLines ? 1 : 0,
              transform: i < visibleLines ? 'translateY(0)' : 'translateY(8px)',
            }}
          >
            {line}
          </p>
        ))}
      </div>
    </div>
  );

  const vizContent = (
    <div className="feature-row-viz">
      {isVisible ? visualization : <div className="feature-row-viz-placeholder" />}
    </div>
  );

  return (
    <div
      ref={rowRef}
      className={`feature-row ${isVisible ? 'visible' : ''}`}
    >
      {side === 'left' ? (
        <>
          {textContent}
          {vizContent}
        </>
      ) : (
        <>
          {vizContent}
          {textContent}
        </>
      )}
    </div>
  );
}
