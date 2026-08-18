// Mock pipeline state machine that simulates the graphyti pipeline
// based on user queries and schema state.

export type PipelineStage =
  | 'idle'
  | 'context'
  | 'classification'
  | 'intent'
  | 'generation'
  | 'blastRadius'
  | 'verification'
  | 'execution'
  | 'done'
  | 'error';

export type PipelineResult = {
  stage: PipelineStage;
  output: string[];
  duration: number;
};

type ParsedQuery = {
  action: 'remove' | 'add' | 'rename' | 'delete' | 'unknown';
  model: string;
  field?: string;
  newField?: string;
};

// Parse user query into structured intent
export function parseQuery(query: string): ParsedQuery {
  const q = query.toLowerCase().trim();

  // Detect action
  let action: ParsedQuery['action'] = 'unknown';
  if (/\b(remove|delete|drop)\b/.test(q)) action = 'remove';
  else if (/\b(add|create|insert)\b/.test(q)) action = 'add';
  else if (/\b(rename|change|move)\b/.test(q)) action = 'rename';

  // Detect model
  let model = 'User';
  if (/\bpost\b/.test(q)) model = 'Post';
  else if (/\bcomment\b/.test(q)) model = 'Comment';
  else if (/\buser\b/.test(q)) model = 'User';

  // Detect field
  const fieldPatterns = [
    'bio', 'title', 'headline', 'heading', 'content', 'status',
    'priority', 'email', 'name', 'password', 'username', 'phone',
    'caption', 'body', 'authorid', 'published', 'islike',
  ];
  let field: string | undefined;
  for (const f of fieldPatterns) {
    if (q.includes(f)) {
      field = f.charAt(0).toUpperCase() + f.slice(1);
      break;
    }
  }

  // Detect rename target
  let newField: string | undefined;
  if (action === 'rename') {
    const toMatch = q.match(/to\s+(\w+)/);
    if (toMatch) {
      newField = toMatch[1].charAt(0).toUpperCase() + toMatch[1].slice(1);
    }
  }

  return { action, model, field, newField };
}

// Blast radius data for each model/field combination
const BLAST_RADIUS: Record<string, Record<string, string[]>> = {
  User: {
    bio: [
      'app/api/users/route.ts',
      'components/UserList.tsx',
    ],
    email: [
      'app/api/users/route.ts',
      'components/UserList.tsx',
      'app/posts/page.tsx',
    ],
    name: [
      'app/api/users/route.ts',
      'components/UserList.tsx',
      'app/posts/page.tsx',
      'components/PostCard.tsx',
    ],
    password: [
      'app/api/users/route.ts',
    ],
    username: [
      'app/api/users/route.ts',
      'components/UserList.tsx',
    ],
    phone: [
      'app/api/users/route.ts',
      'components/UserList.tsx',
    ],
    default: [
      'app/api/users/route.ts',
      'components/UserList.tsx',
    ],
  },
  Post: {
    title: [
      'app/api/posts/route.ts',
      'components/PostCard.tsx',
      'app/posts/page.tsx',
      'src/lib/helper.ts',
    ],
    headline: [
      'app/api/posts/route.ts',
      'components/PostCard.tsx',
    ],
    content: [
      'app/api/posts/route.ts',
      'components/PostCard.tsx',
      'app/posts/page.tsx',
    ],
    status: [
      'app/api/posts/route.ts',
      'components/PostCard.tsx',
      'app/posts/page.tsx',
    ],
    priority: [
      'app/api/posts/route.ts',
      'components/PostCard.tsx',
      'app/posts/page.tsx',
    ],
    authorid: [
      'app/api/posts/route.ts',
      'components/PostCard.tsx',
    ],
    default: [
      'app/api/posts/route.ts',
      'components/PostCard.tsx',
      'app/posts/page.tsx',
    ],
  },
  Comment: {
    caption: [
      'app/api/posts/route.ts',
    ],
    body: [
      'app/api/posts/route.ts',
    ],
    content: [
      'app/api/posts/route.ts',
    ],
    default: [
      'app/api/posts/route.ts',
    ],
  },
  LikeDislike: {
    default: [
      'app/api/posts/route.ts',
      'app/api/users/route.ts',
    ],
  },
};

// Generate mock pipeline output based on parsed query
export function generatePipelineSteps(
  query: string,
  currentSchema: string
): PipelineResult[] {
  const parsed = parseQuery(query);
  const steps: PipelineResult[] = [];

  // Step 1: Context retrieval
  steps.push({
    stage: 'context',
    output: [
      `Retrieving codebase context...`,
      `✓ Context retrieved 1.2s`,
      ``,
      `Context preview (12 lines):`,
      `  │ === CONTEXT ===`,
      `  │`,
      `  │ Chunk 1`,
      `  │ Source: ${parsed.model}.${parsed.field || 'id'} (score: 0.81)`,
      `  │`,
      `  │ Prisma field ${parsed.model}.${parsed.field || 'id'} type String`,
      `  │`,
      `  │ Graph Relations:`,
      `  │   [${parsed.model.toLowerCase()}] → has field → [field:${parsed.model.toLowerCase()}.${parsed.field?.toLowerCase() || 'id'}]`,
    ],
    duration: 1200,
  });

  // Step 2: Classification
  steps.push({
    stage: 'classification',
    output: [
      `Classifying query...`,
      `✓ Classified 0.8s`,
      `  Single-step operation detected`,
    ],
    duration: 800,
  });

  // Step 3: Intent extraction
  const actionLabel = parsed.action === 'remove' ? 'remove_field' :
    parsed.action === 'add' ? 'add_field' :
    parsed.action === 'rename' ? 'rename_field' : 'modify_field';

  steps.push({
    stage: 'intent',
    output: [
      `Extracting edit intent...`,
      `✓ Intent extracted 0.5s`,
      `  1 operation(s) extracted`,
      `  Operations:`,
      `    › schema  ${actionLabel} on ${parsed.model}.${parsed.field || 'unknown'}`,
    ],
    duration: 500,
  });

  // Step 4: Generation
  steps.push({
    stage: 'generation',
    output: [
      `Generating changes...`,
      `✓ Code generated 1.1s`,
      `  1 action(s) returned from model`,
      `  Actions:`,
      `    › schema  ${actionLabel} on ${parsed.model}.${parsed.field || 'unknown'}`,
      `    › cmd     npx prisma migrate dev --name ${parsed.field?.toLowerCase() || 'change'}`,
      `    › cmd     npx prisma generate`,
    ],
    duration: 1100,
  });

  // Step 5: Blast radius
  const fieldKey = parsed.field?.toLowerCase() || '';
  const modelRadius = BLAST_RADIUS[parsed.model] || {};
  const affectedFiles = modelRadius[fieldKey] || modelRadius['default'] || [];

  const blastOutput = [
    `Analyzing schema changes...`,
  ];

  if (parsed.action === 'remove') {
    blastOutput.push(`  ! Breaking changes:`);
    blastOutput.push(`    − ${parsed.model}.${parsed.field} removed`);
  }

  blastOutput.push(``);
  blastOutput.push(`  Model: ${parsed.model} (PrismaModel)`);
  blastOutput.push(`  prisma/schema.prisma`);
  blastOutput.push(`  Routes`);
  blastOutput.push(`    › /api/${parsed.model.toLowerCase()}s               app/api/${parsed.model.toLowerCase()}s/route.ts`);
  blastOutput.push(`  Components`);
  affectedFiles.filter(f => f.endsWith('.tsx')).forEach(f => {
    blastOutput.push(`    › ${f.padEnd(24)} ${f}`);
  });

  steps.push({
    stage: 'blastRadius',
    output: blastOutput,
    duration: 300,
  });

  // Step 6: Verification
  const fileCount = affectedFiles.length;
  steps.push({
    stage: 'verification',
    output: [
      `Running unified structural validation...`,
      `✓ Structural verification passed 0.8s`,
      `  Local structural check: PASSED (${fileCount}/${fileCount} files verified)`,
      `  Graph structural check: PASSED (${fileCount} relations confirmed, 0 stale nodes)`,
      `  Resolution: PASSED: both local and graph checks agree.`,
    ],
    duration: 800,
  });

  // Step 7: Execution
  steps.push({
    stage: 'execution',
    output: [
      `Writing files...`,
      `  ✓ Schema updated: prisma/schema.prisma (${actionLabel} on ${parsed.model})`,
      `    › npx prisma migrate dev --name ${parsed.field?.toLowerCase() || 'change'}`,
      `      cwd: ~/sample-project`,
      `    ✗ Exited with code 1: npx prisma migrate dev (no DATABASE_URL)`,
      `    › npx prisma generate`,
      `    ✗ Exited with code 1: npx prisma generate (no DATABASE_URL)`,
      `  ✓ Write complete 0.4s`,
    ],
    duration: 400,
  });

  // Step 8: Graph index
  steps.push({
    stage: 'done',
    output: [
      `Updating graph index...`,
      `  › prisma/schema.prisma: 2 upsert, ${affectedFiles.length} current nodes`,
      `  ✓ prisma/schema.prisma done`,
      `✓ Graph index updated 0.6s`,
      ``,
      `✓ Done in 5.7s`,
    ],
    duration: 600,
  });

  return steps;
}

// Apply a schema change based on a parsed query
export function applySchemaChange(schema: string, query: string): string {
  const parsed = parseQuery(query);
  const lines = schema.split('\n');

  if (parsed.action === 'remove' && parsed.field) {
    // Find and remove the field line
    const fieldLower = parsed.field.toLowerCase();
    let inTargetModel = false;
    const filtered: string[] = [];

    for (const line of lines) {
      // Track which model we're in
      const modelMatch = line.match(/^\s*model\s+(\w+)/);
      if (modelMatch) {
        inTargetModel = modelMatch[1] === parsed.model;
      }

      // Check if this line is the target field
      const fieldMatch = line.trim().match(/^(\w+)/);
      const isTargetField = fieldMatch && fieldMatch[1].toLowerCase() === fieldLower && inTargetModel;

      if (!isTargetField) {
        filtered.push(line);
      }
    }

    // Clean up double blank lines
    return filtered.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  if (parsed.action === 'add' && parsed.field) {
    // Find the model and add the field before the closing brace
    let inTargetModel = false;
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const modelMatch = line.match(/^\s*model\s+(\w+)/);
      if (modelMatch) {
        inTargetModel = modelMatch[1] === parsed.model;
      }

      result.push(line);

      // If we're at the closing brace of the target model, insert the new field before it
      if (inTargetModel && line.trim() === '}' && i > 0) {
        // Find the indentation of the previous field
        const prevLine = result[result.length - 2] || '';
        const indent = prevLine.match(/^(\s+)/)?.[1] || '  ';
        result.splice(result.length - 1, 0, `${indent}${parsed.field.toLowerCase()}  String?`);
      }
    }

    return result.join('\n');
  }

  if (parsed.action === 'rename' && parsed.field && parsed.newField) {
    // Find and rename the field
    const fieldLower = parsed.field.toLowerCase();
    const newFieldLower = parsed.newField.toLowerCase();
    let inTargetModel = false;

    return lines.map(line => {
      const modelMatch = line.match(/^\s*model\s+(\w+)/);
      if (modelMatch) {
        inTargetModel = modelMatch[1] === parsed.model;
      }

      if (inTargetModel) {
        const fieldMatch = line.trim().match(/^(\w+)/);
        if (fieldMatch && fieldMatch[1].toLowerCase() === fieldLower) {
          return line.replace(new RegExp(`\\b${fieldLower}\\b`, 'i'), newFieldLower);
        }
      }

      return line;
    }).join('\n');
  }

  return schema;
}

// Suggested queries for the demo
export const SUGGESTED_QUERIES = [
  'remove the bio field from User',
  'add a priority field to Post',
  'rename Post.title to headline',
  'delete the Comment model',
];
