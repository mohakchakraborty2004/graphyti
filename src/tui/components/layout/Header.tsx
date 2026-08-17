/**
 * Header — compact, one to two rows, never a dashboard (§20).
 *
 * Content is dropped in the priority order from §37 as the terminal narrows:
 * git detail first, then model, then the directory. The app name and the fact
 * that something is running always survive.
 */

import React from "react";
import { Box, Text } from "ink";
import { UI_COLORS, UI_SYMBOLS } from "../../theme/tokens";
import { truncateEnd, visualWidth } from "../../core/text";
import { Divider } from "../primitives";
import type { TerminalDimensions } from "../../layout/useTerminalLayout";
import type { SessionInfo } from "../../layout/useSessionInfo";

interface HeaderProps {
  info: SessionInfo;
  layout: TerminalDimensions;
  /** Whether to draw the separating rule — dropped when height is scarce. */
  compact: boolean;
  dryRun: boolean;
}

function gitLabel(info: SessionInfo): string | null {
  if (!info.git) return null;
  const { branch, dirty, ahead, behind } = info.git;
  let label = branch + (dirty ? "*" : "");
  if (ahead > 0) label += ` ${UI_SYMBOLS.scrollUp}${ahead}`;
  if (behind > 0) label += ` ${UI_SYMBOLS.scrollDown}${behind}`;
  return label;
}

export function Header({ info, layout, compact, dryRun }: HeaderProps) {
  const { contentWidth, isNarrow, isWide } = layout;
  const separator = `  ${UI_SYMBOLS.bullet}  `;

  // Built as a priority list, then trimmed to fit. Deciding what to drop by
  // measuring beats guessing at breakpoints, because the directory name's length
  // is not knowable in advance.
  const segments: Array<{ text: string; color?: string; dim?: boolean; priority: number }> = [
    { text: "graphyti", color: UI_COLORS.accent, priority: 0 },
  ];

  if (dryRun) {
    segments.push({ text: "dry run", color: UI_COLORS.warning, priority: 1 });
  }
  if (!isNarrow) {
    segments.push({ text: info.model, color: UI_COLORS.muted, dim: true, priority: 3 });
  }
  segments.push({ text: info.cwd, color: UI_COLORS.muted, dim: true, priority: 2 });

  const git = gitLabel(info);
  if (git && isWide) {
    segments.push({ text: git, color: UI_COLORS.secondary, dim: true, priority: 4 });
  }

  const kept = fitSegments(segments, contentWidth, separator.length);

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text wrap="truncate-end">
        {kept.map((segment, i) => (
          <React.Fragment key={segment.text}>
            {i > 0 && (
              <Text color={UI_COLORS.muted} dimColor>
                {separator}
              </Text>
            )}
            <Text
              color={segment.color}
              dimColor={segment.dim}
              bold={segment.priority === 0}
            >
              {segment.text}
            </Text>
          </React.Fragment>
        ))}
      </Text>
      {!compact && <Divider width={contentWidth} />}
    </Box>
  );
}

/**
 * Keep as many segments as fit, dropping the lowest-priority ones first while
 * preserving display order. Truncates the last survivor rather than overflowing.
 */
function fitSegments<T extends { text: string; priority: number }>(
  segments: T[],
  width: number,
  separatorWidth: number
): T[] {
  const cost = (items: T[]) =>
    items.reduce(
      (sum, s, i) => sum + visualWidth(s.text) + (i > 0 ? separatorWidth : 0),
      0
    );

  const kept = [...segments];
  while (kept.length > 1 && cost(kept) > width) {
    let worstIndex = 0;
    let worstPriority = -1;
    kept.forEach((s, i) => {
      if (s.priority > worstPriority) {
        worstPriority = s.priority;
        worstIndex = i;
      }
    });
    kept.splice(worstIndex, 1);
  }

  if (kept.length === 1 && visualWidth(kept[0]!.text) > width) {
    return [{ ...kept[0]!, text: truncateEnd(kept[0]!.text, width) }];
  }

  return kept;
}
