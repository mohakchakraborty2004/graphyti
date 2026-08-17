/**
 * Permission prompt (§18).
 *
 * The one place a border is unambiguously earned: this is a modal decision with
 * consequences, and a border is what separates it from the transcript scrolling
 * past behind it.
 *
 * The structure answers, in order: what is being asked, what exactly will run,
 * what it may do, and how to answer. The user should never have to guess what
 * pressing Enter will do — so the command appears verbatim, wrapped rather than
 * truncated, and the default selection is the safe one.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { UI_COLORS, UI_INDENT, UI_SYMBOLS } from "../../theme/tokens";
import { wrapPath, wrapText } from "../../core/text";
import { Selector, useSelection, type SelectorOption } from "./Selector";
import type { PermissionRequest } from "../../state/types";

interface PermissionPromptProps {
  request: PermissionRequest;
  onDecide: (allowed: boolean) => void;
  width: number;
  narrow: boolean;
  active: boolean;
}

export function PermissionPrompt({
  request,
  onDecide,
  width,
  narrow,
  active,
}: PermissionPromptProps) {
  const options: SelectorOption[] = React.useMemo(
    () => [
      { value: "allow", label: "Allow", description: "Run this once" },
      {
        value: "deny",
        label: "Deny",
        description: "Skip and stop here",
        danger: request.danger,
      },
    ],
    [request.danger]
  );

  // Deny is preselected for destructive actions: the default answer to a
  // dangerous question should be the safe one.
  const { index, move, setIndex } = useSelection(options.length, request.id);
  React.useEffect(() => {
    setIndex(request.danger ? 1 : 0);
  }, [request.id, request.danger, setIndex]);

  useInput(
    (input, key) => {
      if (key.upArrow) return move(-1);
      if (key.downArrow) return move(1);
      if (key.return) return onDecide(options[index]!.value === "allow");
      if (key.escape) return onDecide(false);
      // y/n remain available for muscle memory, but are not advertised as the
      // primary path — the selector is, because it shows what will happen.
      if (input === "y" || input === "Y") return onDecide(true);
      if (input === "n" || input === "N") return onDecide(false);
    },
    { isActive: active }
  );

  // The border consumes two columns of the content budget; account for it so
  // wrapped text inside cannot push the right edge out.
  const inner = Math.max(8, width - 4);
  const accent = request.danger ? UI_COLORS.error : UI_COLORS.warning;

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle="round"
      borderColor={accent}
      paddingX={1}
      width={width}
    >
      <Text color={accent} bold>
        {`${UI_SYMBOLS.warning} ${request.title}`}
      </Text>

      {request.subject && (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          {wrapCommand(request.subject, inner).map((row, i) => (
            <Text key={i} wrap="truncate-end">
              <Text color={UI_COLORS.muted}>{i === 0 ? "$ " : "  "}</Text>
              <Text bold>{row}</Text>
            </Text>
          ))}
        </Box>
      )}

      {request.consequence && !narrow && (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          {wrapText(request.consequence, inner).map((row, i) => (
            <Text key={i} color={UI_COLORS.muted} wrap="truncate-end">
              {row}
            </Text>
          ))}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        {wrapText(request.question, inner).map((row, i) => (
          <Text key={i} wrap="truncate-end">
            {row}
          </Text>
        ))}
      </Box>

      <Box marginTop={1} flexShrink={0}>
        <Selector
          options={options}
          selectedIndex={index}
          width={inner}
          narrow={narrow}
        />
      </Box>
    </Box>
  );
}

/**
 * Wrap a command for display, reserving the `$ ` gutter on the first row and
 * aligning continuations under it.
 */
function wrapCommand(command: string, width: number): string[] {
  const available = Math.max(1, width - 2);
  // Commands are path-dense; breaking at separators reads better than at spaces
  // alone, and never mid-flag.
  return command.includes(" ")
    ? wrapText(command, available, { normalizeWhitespace: false })
    : wrapPath(command, available);
}
