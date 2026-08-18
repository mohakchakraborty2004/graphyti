'use client';

import { useState, useCallback, useRef } from 'react';
import { CLITerminal } from './CLITerminal';
import { TUIEditor } from './TUIEditor';
import { SchemaEditor } from './SchemaEditor';
import { applySchemaChange } from './MockPipeline';

type TabMode = 'cli' | 'tui';

const ORIGINAL_SCHEMA = `datasource db {
  provider = "postgresql"
}

generator client {
  provider = "prisma-client-js"
  output   = "../generated/prisma"
}

model User {
  id       Int     @id @default(autoincrement())
  email    String  @unique
  name     String?
  posts    Post[]
  password String
  username  String
  phone  String
  bio      String?
  likes     LikeDislike[]
}

model Post {
  id        Int       @id @default(autoincrement())
  title     String?
  headline  String?
  heading   String?
  content   String?
  published Boolean   @default(false)
  status    String?   @default("DRAFT")
  priority  Int       @default(0)
  authorId  Int?
  author    User?     @relation(fields: [authorId], references: [id])
  comments  Comment[]
  likes     LikeDislike[]
}

model Comment {
  id      Int     @id @default(autoincrement())
  caption String?
  body    String?
  content String?
  postId  Int
  post    Post    @relation(fields: [postId], references: [id])
}

model LikeDislike {
  id     Int      @id @default(autoincrement())
  isLike Boolean
  postId Int
  post   Post     @relation(fields: [postId], references: [id])
  userId Int
  user   User     @relation(fields: [userId], references: [id])
}`;

export function HowItWorksSection() {
  const [mode, setMode] = useState<TabMode>('cli');
  const [queryTicket, setQueryTicket] = useState<{ query: string; ts: number } | null>(null);
  const [schema, setSchema] = useState(ORIGINAL_SCHEMA);
  const schemaTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleRunPipeline = useCallback((query: string) => {
    // Clear any pending schema change
    if (schemaTimerRef.current) {
      clearTimeout(schemaTimerRef.current);
    }

    setQueryTicket({ query, ts: Date.now() });

    // Apply schema change after pipeline finishes (total ~5.7s)
    schemaTimerRef.current = setTimeout(() => {
      setSchema(prev => applySchemaChange(prev, query));
      schemaTimerRef.current = null;
    }, 6000);
  }, []);

  const handleQueryExecuted = useCallback(() => {
    setQueryTicket(null);
  }, []);

  const handlePipelineComplete = useCallback((query: string) => {
    // Clear any pending timer and apply immediately
    if (schemaTimerRef.current) {
      clearTimeout(schemaTimerRef.current);
      schemaTimerRef.current = null;
    }
    setSchema(prev => applySchemaChange(prev, query));
  }, []);

  const handleSchemaChange = useCallback((newSchema: string) => {
    setSchema(newSchema);
    // Clear pending pipeline schema change since user manually edited
    if (schemaTimerRef.current) {
      clearTimeout(schemaTimerRef.current);
      schemaTimerRef.current = null;
    }
  }, []);

  return (
    <section className="how-it-works" id="how-it-works">
      <div className="how-it-works-inner">
        {/* Section header */}
        <div className="how-header">
          <span className="how-label">INTERACTIVE DEMO</span>
          <h2 className="how-title">
            See how <span className="cursive-orange">graphyti</span> works
          </h2>
          <p className="how-subtitle">
            Type a query, watch the pipeline run. Edit the schema, see blast radius change.
            Every step is real — this is exactly what runs on your machine.
          </p>
          <div className="mock-badge">
            <span className="mock-icon">◆</span>
            Mock version — gives you a taste of the pipeline, not actual code generation
          </div>
        </div>

        {/* Tab switcher */}
        <div className="how-tabs">
          <button
            className={`how-tab ${mode === 'cli' ? 'active' : ''}`}
            onClick={() => setMode('cli')}
          >
            <span className="tab-icon">&gt;_</span>
            CLI
          </button>
          <button
            className={`how-tab ${mode === 'tui' ? 'active' : ''}`}
            onClick={() => setMode('tui')}
          >
            <span className="tab-icon">●</span>
            TUI
          </button>
        </div>

        {/* Demo area */}
        <div className="how-demo">
          <div className="how-terminal-wrap">
            {mode === 'cli' ? (
              <CLITerminal
                key="cli"
                externalQuery={queryTicket?.query}
                onQueryExecuted={handleQueryExecuted}
                onPipelineComplete={handlePipelineComplete}
              />
            ) : (
              <TUIEditor
                key="tui"
                externalQuery={queryTicket?.query}
                onQueryExecuted={handleQueryExecuted}
                onPipelineComplete={handlePipelineComplete}
              />
            )}
          </div>
          <div className="how-schema-wrap">
            <SchemaEditor
              schema={schema}
              onSchemaChange={handleSchemaChange}
              onRunPipeline={handleRunPipeline}
            />
          </div>
        </div>

        {/* Feature callouts */}
        <div className="how-features">
          <div className="how-feature">
            <span className="feature-icon">✓</span>
            <div>
              <h3>Two-layer verification</h3>
              <p>Local AST re-parse + HydraDB graph cross-check before any write</p>
            </div>
          </div>
          <div className="how-feature">
            <span className="feature-icon">→</span>
            <div>
              <h3>Blast radius</h3>
              <p>Shows every file that depends on what you're changing</p>
            </div>
          </div>
          <div className="how-feature">
            <span className="feature-icon">◆</span>
            <div>
              <h3>Scoped edits</h3>
              <p>Targeted mutations — no full-file regeneration</p>
            </div>
          </div>
          <div className="how-feature">
            <span className="feature-icon">■</span>
            <div>
              <h3>Command allowlist</h3>
              <p>Only approved shell commands can execute</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
