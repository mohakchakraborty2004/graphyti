/**
 * Empty state (§24).
 *
 * Left-aligned rather than centred: centred blocks re-centre themselves on every
 * resize, which is motion for no reason, and they break the single content
 * column the rest of the UI is built on.
 *
 * Content is shed as the terminal shrinks — the example prompts go first, then
 * the capability list — so this stays usable at 40 columns and short heights
 * instead of scrolling the prompt away on first launch.
 */

import React from "react";
import { Box, Text } from "ink";
import { UI_COLORS, UI_SYMBOLS } from "../../theme/tokens";
import { wrapText } from "../../core/text";
import type { TerminalDimensions } from "../../layout/useTerminalLayout";

interface WelcomeProps {
  layout: TerminalDimensions;
  dryRun: boolean;
}

const CAPABILITIES = [
  "inspect your schema and code",
  "make scoped edits across files",
  "trace what a change breaks",
  "run tests and commands",
];

const EXAMPLES = [
  "Add a publishedAt field to Post",
  "Why is the session token rejected?",
];

export function WelcomeScreen({ layout, dryRun }: WelcomeProps) {
  const { contentWidth, maxTextWidth, height, isNarrow } = layout;

  // Height budget for this screen: shed sections rather than overflow.
  const roomy = height >= 22;
  const showCapabilities = height >= 14;
  const showExamples = roomy && !isNarrow;

  const tagline = "Graph-grounded code generation for Next.js and Prisma.";

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/*
        No wordmark here — the header already carries it, and repeating it is the
        kind of redundancy §33 asks us to strip. This screen opens with what the
        tool does, which is the thing a first-time user actually needs.
      */}
      <Box flexDirection="column" flexShrink={0}>
        {wrapText(tagline, maxTextWidth).map((row, i) => (
          <Text key={i} color={UI_COLORS.muted} wrap="truncate-end">
            {row}
          </Text>
        ))}
        {dryRun && (
          <Text color={UI_COLORS.warning} wrap="truncate-end">
            {`${UI_SYMBOLS.warning} dry run — nothing will be written`}
          </Text>
        )}
      </Box>

      {showCapabilities && (
        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          <Text color={UI_COLORS.muted} dimColor>
            Ask me to
          </Text>
          {CAPABILITIES.map((item) => (
            <Text key={item} wrap="truncate-end">
              <Text color={UI_COLORS.muted} dimColor>
                {`  ${UI_SYMBOLS.bullet} `}
              </Text>
              <Text color={UI_COLORS.muted}>{item}</Text>
            </Text>
          ))}
        </Box>
      )}

      {showExamples && (
        <Box marginTop={1} flexDirection="column" flexShrink={0}>
          <Text color={UI_COLORS.muted} dimColor>
            Try
          </Text>
          {EXAMPLES.map((example) => (
            <Box key={example} flexDirection="row" flexShrink={0}>
              <Text color={UI_COLORS.accent}>{`  ${UI_SYMBOLS.user} `}</Text>
              <Text color={UI_COLORS.muted} wrap="truncate-end">
                {example.length > contentWidth - 4
                  ? example.slice(0, Math.max(0, contentWidth - 5)) + UI_SYMBOLS.ellipsis
                  : example}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
