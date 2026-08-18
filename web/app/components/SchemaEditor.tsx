'use client';

import { useState, useCallback, useEffect } from 'react';

interface SchemaEditorProps {
  schema: string;
  onSchemaChange: (schema: string) => void;
  onRunPipeline: (query: string) => void;
}

export function SchemaEditor({ schema, onSchemaChange, onRunPipeline }: SchemaEditorProps) {
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [highlightedFields, setHighlightedFields] = useState<Set<string>>(new Set());
  const [flashLine, setFlashLine] = useState<number | null>(null);

  const lines = schema.split('\n');

  const isModelLine = (line: string) => /^\s*model\s+\w+/.test(line);
  const isFieldLine = (line: string) => /^\s+\w+\s+/.test(line) && !line.trim().startsWith('//');
  const isRelationLine = (line: string) => /\[\]|@relation/.test(line);

  // Flash the line that changed
  useEffect(() => {
    if (flashLine !== null) {
      const timer = setTimeout(() => setFlashLine(null), 1500);
      return () => clearTimeout(timer);
    }
  }, [flashLine, schema]);

  const handleLineClick = (index: number) => {
    const line = lines[index];
    if (isFieldLine(line) && !isModelLine(line)) {
      setSelectedLine(selectedLine === index ? null : index);
    }
  };

  const handleDeleteField = useCallback(() => {
    if (selectedLine === null) return;
    const line = lines[selectedLine];
    const fieldName = line.trim().match(/^(\w+)/)?.[1];
    const modelMatch = lines.slice(0, selectedLine).reverse().find(l => isModelLine(l));
    const modelName = modelMatch?.match(/model\s+(\w+)/)?.[1] || 'User';

    // Remove the line from schema
    const newLines = lines.filter((_, i) => i !== selectedLine);
    const newSchema = newLines.join('\n').replace(/\n{3,}/g, '\n\n');
    onSchemaChange(newSchema);
    setSelectedLine(null);

    // Trigger pipeline
    if (fieldName) {
      onRunPipeline(`remove the ${fieldName} field from ${modelName}`);
    }
  }, [selectedLine, lines, onSchemaChange, onRunPipeline]);

  const handleReset = () => {
    onSchemaChange(`datasource db {
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
}`);
    setSelectedLine(null);
    setHighlightedFields(new Set());
  };

  const handleRunOnField = (field: string, model: string) => {
    onRunPipeline(`remove the ${field} field from ${model}`);
  };

  const handleMouseEnter = (line: string) => {
    const fieldMatch = line.trim().match(/^(\w+)\s+/);
    if (fieldMatch && isFieldLine(line) && !isModelLine(line)) {
      const field = fieldMatch[1];
      setHighlightedFields(new Set([field]));
    }
  };

  const handleMouseLeave = () => {
    setHighlightedFields(new Set());
  };

  return (
    <div className="schema-editor">
      <div className="schema-header">
        <div className="schema-tabs">
          <span className="schema-tab active">schema.prisma</span>
        </div>
        <div className="schema-actions">
          <button
            className="schema-btn"
            onClick={handleDeleteField}
            disabled={selectedLine === null}
          >
            Delete Field
          </button>
          <button className="schema-btn" onClick={handleReset}>
            Reset
          </button>
        </div>
      </div>
      <div className="schema-content">
        {lines.map((line, index) => {
          const isSelected = selectedLine === index;
          const isModel = isModelLine(line);
          const isField = isFieldLine(line) && !isModel;
          const isRelation = isRelationLine(line);
          const fieldMatch = line.trim().match(/^(\w+)/);
          const isHighlighted = fieldMatch && highlightedFields.has(fieldMatch[1]);
          const isFlashed = flashLine === index;

          return (
            <div
              key={`${index}-${line}`}
              className={`schema-line ${isSelected ? 'selected' : ''} ${isField ? 'clickable' : ''} ${isHighlighted ? 'highlighted' : ''} ${isFlashed ? 'flash' : ''}`}
              onClick={() => handleLineClick(index)}
              onMouseEnter={() => handleMouseEnter(line)}
              onMouseLeave={handleMouseLeave}
            >
              <span className="line-number">{index + 1}</span>
              <span className={`line-content ${isModel ? 'model-name' : ''} ${isRelation ? 'relation' : ''}`}>
                {renderSyntaxHighlighted(line)}
              </span>
              {isField && !isRelation && (
                <button
                  className="field-run-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    const fieldName = line.trim().match(/^(\w+)/)?.[1];
                    const modelMatch = lines.slice(0, index).reverse().find(l => isModelLine(l));
                    const modelName = modelMatch?.match(/model\s+(\w+)/)?.[1] || 'User';
                    if (fieldName) handleRunOnField(fieldName, modelName);
                  }}
                  title="Run pipeline on this field"
                >
                  ▶
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="schema-footer">
        <span className="schema-info">
          Click a field to select · Press Delete to remove · Click ▶ to run pipeline
        </span>
      </div>
    </div>
  );
}

function renderSyntaxHighlighted(line: string) {
  // Model keyword
  if (/^\s*model\s+/.test(line)) {
    const match = line.match(/^(\s*model\s+)(\w+)/);
    if (match) {
      return (
        <>
          <span className="kw-model">{match[1]}</span>
          <span className="type-model">{match[2]}</span>
        </>
      );
    }
  }

  // Field line
  const fieldMatch = line.match(/^(\s+)(\w+)(\s+)(\S+)/);
  if (fieldMatch) {
    const [, indent, name, space, type] = fieldMatch;
    const isRelation = type.includes('[]') || type === 'User?' || type === 'Post?' || type === 'Post';
    return (
      <>
        <span>{indent}</span>
        <span className="field-name">{name}</span>
        <span>{space}</span>
        <span className={isRelation ? 'type-relation' : 'type-scalar'}>{type}</span>
        {line.includes('@id') && <span className="attr-id"> @id</span>}
        {line.includes('@default') && <span className="attr-default"> @default(...)</span>}
        {line.includes('@unique') && <span className="attr-unique"> @unique</span>}
        {line.includes('@relation') && <span className="attr-relation"> @relation(...)</span>}
      </>
    );
  }

  // Comment
  if (line.trim().startsWith('//')) {
    return <span className="comment">{line}</span>;
  }

  // Default
  return <span>{line}</span>;
}
