/**
 * Contextual key hints (§17) — pure, so the mapping from state to offered keys
 * can be verified exhaustively.
 *
 * Derived from `SessionState` rather than listed statically: a new state cannot
 * be added without deciding what the user is allowed to press in it. Only live
 * keys appear — a list of every shortcut teaches nothing, and one that offers a
 * key that does not work is worse than none.
 */

import { UI_SYMBOLS } from "../theme/tokens";
import { isBusy, type SessionState } from "../state/types";

export interface KeyHint {
  keys: string;
  label: string;
}

export interface HintContext {
  state: SessionState;
  /** A modal surface is open and owns the keyboard. */
  overlay: "none" | "palette" | "permission";
  /** There is collapsible content on screen. */
  hasExpandable: boolean;
  /** The viewport is scrolled away from the bottom. */
  scrolledUp: boolean;
  /** There is history to recall. */
  hasHistory: boolean;
}

const ARROWS = `${UI_SYMBOLS.scrollUp}${UI_SYMBOLS.scrollDown}`;

/**
 * Hints for the current context, most important first.
 *
 * Ordering is load-bearing: the help row drops hints from the end when it is too
 * narrow, so the leftmost hint is the one guaranteed to survive at 40 columns.
 */
export function hintsFor(ctx: HintContext): KeyHint[] {
  // A modal owns the keyboard: offering anything else would be a lie.
  if (ctx.overlay === "permission") {
    return [
      { keys: "enter", label: "confirm" },
      { keys: ARROWS, label: "navigate" },
      { keys: "esc", label: "deny" },
    ];
  }

  if (ctx.overlay === "palette") {
    return [
      { keys: "enter", label: "select" },
      { keys: ARROWS, label: "navigate" },
      { keys: "esc", label: "close" },
    ];
  }

  const hints: KeyHint[] = [];

  if (isBusy(ctx.state)) {
    hints.push({ keys: "ctrl+c", label: "stop" });
    if (ctx.hasExpandable) hints.push({ keys: "ctrl+o", label: "expand" });
    hints.push(
      ctx.scrolledUp
        ? { keys: "end", label: "follow" }
        : { keys: "pgup", label: "scroll" }
    );
    return hints;
  }

  hints.push({ keys: "enter", label: "send" });
  hints.push({ keys: "shift+enter", label: "newline" });
  if (ctx.hasHistory) hints.push({ keys: ARROWS, label: "history" });
  if (ctx.hasExpandable) hints.push({ keys: "ctrl+o", label: "expand" });
  hints.push({ keys: "/", label: "commands" });

  return hints;
}
