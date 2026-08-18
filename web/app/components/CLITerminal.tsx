'use client';

import { useState, useRef, useEffect } from 'react';
import { generatePipelineSteps, SUGGESTED_QUERIES, type PipelineStage } from './MockPipeline';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL = 80;

interface CLITerminalProps {
  externalQuery?: string;
  onQueryExecuted?: () => void;
  onPipelineComplete?: (query: string) => void;
}

export function CLITerminal({ externalQuery, onQueryExecuted, onPipelineComplete }: CLITerminalProps) {
  const [history, setHistory] = useState<Array<{ type: 'input' | 'output'; content: string[] }>>([]);
  const [inputValue, setInputValue] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [currentStage, setCurrentStage] = useState<PipelineStage>('idle');
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastQueryRef = useRef<string>('');

  // Auto-scroll to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [history]);

  // Spinner animation
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      setSpinnerFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL);
    return () => clearInterval(interval);
  }, [isRunning]);

  // Handle external query
  useEffect(() => {
    if (externalQuery && externalQuery !== lastQueryRef.current && !isRunning) {
      lastQueryRef.current = externalQuery;
      runPipeline(externalQuery);
      onQueryExecuted?.();
    }
  }, [externalQuery, isRunning, onQueryExecuted]);

  const runPipeline = async (query: string) => {
    setIsRunning(true);
    setCurrentStage('context');
    setHistory(prev => [...prev, { type: 'input', content: [`$ graphyti "${query}"`] }]);

    const steps = generatePipelineSteps(query, '');

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      setCurrentStage(step.stage);
      await new Promise(resolve => setTimeout(resolve, step.duration));
      setHistory(prev => [...prev, { type: 'output', content: step.output }]);
    }

    setIsRunning(false);
    setCurrentStage('idle');
    setInputValue('');

    // Notify parent that pipeline completed
    onPipelineComplete?.(query);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim() && !isRunning) {
      lastQueryRef.current = inputValue.trim();
      runPipeline(inputValue.trim());
    }
  };

  const handleSuggestionClick = (query: string) => {
    if (!isRunning) {
      lastQueryRef.current = query;
      runPipeline(query);
    }
  };

  return (
    <div className="cli-terminal" onClick={() => inputRef.current?.focus()}>
      {/* Terminal chrome */}
      <div className="terminal-chrome">
        <div className="terminal-dots">
          <span className="dot red" />
          <span className="dot yellow" />
          <span className="dot green" />
        </div>
        <span className="terminal-title">graphyti — zsh</span>
      </div>

      {/* Output area */}
      <div className="terminal-output" ref={outputRef}>
        {history.length === 0 && (
          <div className="terminal-welcome">
            <div className="welcome-header">
              <span className="cli-accent">──────────────────────────────────────────</span>
              <br />
              <span className="cli-accent">  graphyti</span> <span className="cli-dim">v1.0.0</span>
              <br />
              <span className="cli-accent">──────────────────────────────────────────</span>
            </div>
            <div className="welcome-hint">
              Type a query or click a suggestion below:
            </div>
            <div className="suggestions">
              {SUGGESTED_QUERIES.map((q, i) => (
                <button
                  key={i}
                  className="suggestion-pill"
                  onClick={() => handleSuggestionClick(q)}
                  disabled={isRunning}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {history.map((entry, i) => (
          <div key={i} className={`terminal-entry ${entry.type}`}>
            {entry.content.map((line, j) => (
              <div key={j} className="terminal-line">
                {renderCLILine(line)}
              </div>
            ))}
          </div>
        ))}

        {/* Active spinner */}
        {isRunning && (
          <div className="terminal-entry output">
            <div className="terminal-line">
              <span className="cli-spinner">{SPINNER_FRAMES[spinnerFrame]}</span>
              <span className="cli-accent"> {getStageLabel(currentStage)}...</span>
            </div>
          </div>
        )}
      </div>

      {/* Input area */}
      <form className="terminal-input" onSubmit={handleSubmit}>
        <span className="input-prompt">$</span>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder={isRunning ? 'Processing...' : 'graphyti "remove the bio field from User"'}
          disabled={isRunning}
          className="input-field"
          autoFocus
        />
      </form>
    </div>
  );
}

function getStageLabel(stage: PipelineStage): string {
  const labels: Record<PipelineStage, string> = {
    idle: '',
    context: 'Retrieving codebase context',
    classification: 'Classifying query',
    intent: 'Extracting edit intent',
    generation: 'Generating changes',
    blastRadius: 'Analyzing schema changes',
    verification: 'Running structural validation',
    execution: 'Writing files',
    done: 'Done',
    error: 'Error',
  };
  return labels[stage] || stage;
}

function renderCLILine(line: string) {
  if (line.startsWith('──')) {
    return <span className="cli-section">{line}</span>;
  }
  if (line.includes('✓')) {
    return <span className="cli-success">{line}</span>;
  }
  if (line.includes('✗')) {
    return <span className="cli-error">{line}</span>;
  }
  if (line.includes('!')) {
    return <span className="cli-warn">{line}</span>;
  }
  if (line.trim().startsWith('›')) {
    return <span className="cli-bullet">{line}</span>;
  }
  if (line.includes('────────────────────────────────────────')) {
    return <span className="cli-dim">{line}</span>;
  }
  if (line.startsWith('  │')) {
    return <span className="cli-dim">{line}</span>;
  }
  return <span>{line}</span>;
}
