/**
 * Permission prompt (§18).
 *
 * The one place a border is unambiguously earned: this is a modal decision with
 * consequences, and the border is what separates it from the transcript behind it.
 *
 * The structure answers, in order: what is being asked, what exactly will run,
 * what it may do, and how to answer. The user should never have to guess what
 * pressing Enter will do — so the command appears verbatim, wrapped rather than
 * truncated, and the default selection is the safe one.
 *
 * Layout comes from `core/permission` so the height budget reserves exactly what
 * gets drawn.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import { UI_COLORS, UI_SYMBOLS } from "../../theme/tokens";
import { layoutPermission } from "../../core/permission";
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
  const layout = React.useMemo(
    () => layoutPermission(request, width, narrow),
    [request, width, narrow]
  );

  const options: SelectorOption[] = React.useMemo(
    () =>
      layout.options.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
        danger: option.value === "deny" ? request.danger : undefined,
      })),
    [layout.options, request.danger]
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
      // y/n stay available for muscle memory but are not advertised as the primary
      // path — the selector is, because it shows what each choice does.
      if (input === "y" || input === "Y") return onDecide(true);
      if (input === "n" || input === "N") return onDecide(false);
    },
    { isActive: active }
  );

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
      <Text color={accent} bold wrap="truncate-end">
        {`${UI_SYMBOLS.warning} ${layout.title}`}
      </Text>

      {layout.subject.length > 0 && (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          {layout.subject.map((row, i) => (
            <Text key={i} wrap="truncate-end">
              <Text color={UI_COLORS.muted}>{i === 0 ? "$ " : "  "}</Text>
              <Text bold>{row}</Text>
            </Text>
          ))}
        </Box>
      )}

      {layout.consequence.length > 0 && (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          {layout.consequence.map((row, i) => (
            <Text key={i} color={UI_COLORS.muted} wrap="truncate-end">
              {row}
            </Text>
          ))}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        {layout.question.map((row, i) => (
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
