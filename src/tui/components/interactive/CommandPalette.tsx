/**
 * Command palette (§19).
 *
 * Opens on `/` at the start of an empty prompt and filters as the user keeps
 * typing, so discovering a command and running it are the same gesture rather
 * than two modes.
 */

import React from "react";
import { Box, Text } from "ink";
import { UI_COLORS } from "../../theme/tokens";
import { Selector, type SelectorOption } from "./Selector";
import { filterCommands } from "../../core/commands";

export { COMMANDS, filterCommands, type Command } from "../../core/commands";

interface CommandPaletteProps {
  query: string;
  selectedIndex: number;
  width: number;
  narrow: boolean;
}

export function CommandPalette({
  query,
  selectedIndex,
  width,
  narrow,
}: CommandPaletteProps) {
  const matches = filterCommands(query);

  const options: SelectorOption[] = matches.map((command) => ({
    value: command.name,
    label: command.name,
    description: command.description,
  }));

  const inner = Math.max(8, width - 4);

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle="round"
      borderColor={UI_COLORS.border}
      paddingX={1}
      width={width}
    >
      {options.length === 0 ? (
        <Text color={UI_COLORS.muted} dimColor wrap="truncate-end">
          {`No command matches "${query}"`}
        </Text>
      ) : (
        <Selector
          options={options}
          selectedIndex={selectedIndex}
          width={inner}
          maxRows={6}
          narrow={narrow}
        />
      )}
    </Box>
  );
}
