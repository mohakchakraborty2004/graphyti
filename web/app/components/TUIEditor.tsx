'use client';

import { useState, useRef, useEffect } from 'react';
import { generatePipelineSteps, SUGGESTED_QUERIES, type PipelineStage } from './MockPipeline';

const BRAILLE_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL = 80;

type Message = {
  id: number;
  role: 'user' | 'agent' | 'system';
  content: string;
  status?: 'running' | 'success' | 'error' | 'pending';
  stage?: PipelineStage;
};

let messageId = 0;
const nextId = () => ++messageId;

interface TUIEditorProps {
  externalQuery?: string;
  onQueryExecuted?: () => void;
  onPipelineComplete?: (query: string) => void;
}

export function TUIEditor({ externalQuery, onQueryExecuted, onPipelineComplete }: TUIEditorProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [currentStage, setCurrentStage] = useState<PipelineStage>('idle');
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const conversationRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastQueryRef = useRef<string>('');

  // Auto-scroll to bottom
  useEffect(() => {
    if (conversationRef.current) {
      conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
    }
  }, [messages]);

  // Spinner animation
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      setSpinnerFrame(f => (f + 1) % BRAILLE_SPINNER.length);
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

    // Add user message
    setMessages(prev => [...prev, { id: nextId(), role: 'user', content: query }]);
    setCommandHistory(prev => [...prev, query]);
    setHistoryIndex(-1);

    const steps = generatePipelineSteps(query, '');

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      setCurrentStage(step.stage);

      // Add a new agent message for each stage
      setMessages(prev => [...prev, {
        id: nextId(),
        role: 'agent',
        content: step.output.join('\n'),
        status: step.stage === 'done' ? 'success' : step.stage === 'error' ? 'error' : 'success',
        stage: step.stage,
      }]);

      await new Promise(resolve => setTimeout(resolve, step.duration));
    }

    // Add completion message
    setMessages(prev => [...prev, {
      id: nextId(),
      role: 'system',
      content: 'Pipeline completed successfully.',
    }]);

    setIsRunning(false);
    setCurrentStage('idle');
    setInputValue('');

    // Notify parent that pipeline completed
    onPipelineComplete?.(query);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (inputValue.trim() && !isRunning) {
        lastQueryRef.current = inputValue.trim();
        runPipeline(inputValue.trim());
      }
    }

    // History navigation
    if (e.key === 'ArrowUp' && !inputValue) {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIndex = historyIndex < commandHistory.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(newIndex);
        setInputValue(commandHistory[commandHistory.length - 1 - newIndex] || '');
      }
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInputValue(commandHistory[commandHistory.length - 1 - newIndex] || '');
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setInputValue('');
      }
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
  };

  const handleSuggestionClick = (query: string) => {
    if (!isRunning) {
      lastQueryRef.current = query;
      runPipeline(query);
    }
  };

  const getSpinner = () => BRAILLE_SPINNER[spinnerFrame];

  return (
    <div className="tui-editor">
      {/* Header */}
      <div className="tui-header">
        <span className="tui-brand">graphyti</span>
        <span className="tui-separator">·</span>
        <span className="tui-model">gpt-4o</span>
        <span className="tui-separator">·</span>
        <span className="tui-cwd">~/sample-project</span>
        <span className="tui-separator">·</span>
        <span className="tui-git">main</span>
      </div>

      {/* Conversation */}
      <div className="tui-conversation" ref={conversationRef}>
        {messages.length === 0 && (
          <div className="tui-welcome">
            <div className="tui-welcome-title">
              Welcome to <span className="tui-accent">graphyti</span> interactive mode.
            </div>
            <div className="tui-welcome-hint">
              Type a query to see how the pipeline works, or click a suggestion:
            </div>
            <div className="tui-suggestions">
              {SUGGESTED_QUERIES.map((q, i) => (
                <button
                  key={i}
                  className="tui-suggestion"
                  onClick={() => handleSuggestionClick(q)}
                  disabled={isRunning}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`tui-message ${msg.role}`}>
            {msg.role === 'user' && (
              <>
                <div className="tui-speaker">
                  <span className="tui-speaker-marker user">❯</span>
                  <span className="tui-speaker-name">You</span>
                </div>
                <div className="tui-content">{msg.content}</div>
              </>
            )}
            {msg.role === 'agent' && (
              <>
                <div className="tui-speaker">
                  <span className={`tui-speaker-marker agent ${msg.status}`}>
                    {msg.status === 'success' ? '✓' : '●'}
                  </span>
                  <span className="tui-speaker-name">Agent</span>
                  <span className="tui-stage-label">{getStageLabel(msg.stage || 'idle')}</span>
                </div>
                <div className="tui-content">
                  {msg.content.split('\n').map((line, j) => (
                    <div key={j} className="tui-output-line">
                      {renderTUILine(line)}
                    </div>
                  ))}
                </div>
              </>
            )}
            {msg.role === 'system' && (
              <div className="tui-system">
                <span className="tui-system-dot">·</span>
                {msg.content}
              </div>
            )}
          </div>
        ))}

        {/* Active stage indicator */}
        {isRunning && (
          <div className="tui-stage-indicator">
            <span className="tui-spinner">{getSpinner()}</span>
            <span className="tui-stage-text">{getStageLabel(currentStage)}</span>
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="tui-statusbar">
        {isRunning ? (
          <>
            <span className="tui-status-spinner">{getSpinner()}</span>
            <span className="tui-status-text">{getStageLabel(currentStage)}...</span>
          </>
        ) : (
          <span className="tui-status-idle">ready</span>
        )}
      </div>

      {/* Input area */}
      <div className="tui-input-area">
        <div className="tui-input-row">
          <span className="tui-input-prompt">❯</span>
          <textarea
            ref={inputRef}
            className="tui-input"
            value={inputValue}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? 'Processing...' : 'Type a query...'}
            disabled={isRunning}
            rows={1}
            autoFocus
          />
        </div>
        <div className="tui-help-bar">
          <span>enter send</span>
          <span className="tui-help-sep">·</span>
          <span>shift+enter newline</span>
          <span className="tui-help-sep">·</span>
          <span>↑↓ history</span>
        </div>
      </div>
    </div>
  );
}

function getStageLabel(stage: PipelineStage): string {
  const labels: Record<PipelineStage, string> = {
    idle: 'ready',
    context: 'Context retrieval',
    classification: 'Classification',
    intent: 'Intent extraction',
    generation: 'Code generation',
    blastRadius: 'Blast radius',
    verification: 'Structural verification',
    execution: 'Execution',
    done: 'Done',
    error: 'Error',
  };
  return labels[stage] || stage;
}

function renderTUILine(line: string) {
  if (line.startsWith('──')) {
    return <span className="tui-section">{line}</span>;
  }
  if (line.includes('✓')) {
    return <span className="tui-success">{line}</span>;
  }
  if (line.includes('✗')) {
    return <span className="tui-error">{line}</span>;
  }
  if (line.includes('!') && !line.startsWith('  │')) {
    return <span className="tui-warn">{line}</span>;
  }
  if (line.trim().startsWith('›')) {
    return <span className="tui-bullet">{line}</span>;
  }
  if (line.startsWith('  │')) {
    return <span className="tui-dim">{line}</span>;
  }
  return <span>{line}</span>;
}
