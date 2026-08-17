/**
 * Session store.
 *
 * A reducer rather than a dozen `useState` calls, for one specific reason: the
 * pipeline runner reports progress from async callbacks, and independent state
 * setters read stale values in that situation — the exact failure that made the
 * old confirmation flow deadlock. A reducer always acts on current state.
 *
 * The other job here is the history/live split. Blocks belonging to a finished
 * turn move to `blocks`, which the viewport hands to Ink's `<Static>` and never
 * redraws; the in-flight turn stays in `live`. That is what keeps the frame small
 * and the input pinned.
 */

import { useCallback, useMemo, useReducer } from "react";
import type {
  Block,
  PermissionRequest,
  SessionSnapshot,
  SessionState,
  ToolCall,
  ToolKind,
} from "./types";
import type { StatusKind } from "../theme/tokens";

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export type Action =
  | { type: "state"; state: SessionState }
  | { type: "activity"; activity: string | null }
  | { type: "appendLive"; block: Block }
  | { type: "appendHistory"; block: Block }
  | { type: "patchBlock"; id: string; patch: Partial<Block> }
  | { type: "patchTool"; id: string; patch: Partial<ToolCall> }
  | { type: "toggleExpanded"; id: string }
  | { type: "expandLast" }
  | { type: "commitLive" }
  | { type: "clearLive" }
  | { type: "permission"; request: PermissionRequest | null }
  | { type: "pushHistory"; value: string }
  | { type: "clear" }
  | { type: "toggleDebug" };

export const initialSession: SessionSnapshot = {
  state: "idle",
  blocks: [],
  live: [],
  activity: null,
  permission: null,
  history: [],
  debug: false,
};

function patchIn(blocks: Block[], id: string, patch: Partial<Block>): Block[] {
  let changed = false;
  const next = blocks.map((block) => {
    if (block.id !== id) return block;
    changed = true;
    return { ...block, ...patch } as Block;
  });
  return changed ? next : blocks;
}

export function reducer(state: SessionSnapshot, action: Action): SessionSnapshot {
  switch (action.type) {
    case "state":
      return { ...state, state: action.state };

    case "activity":
      return { ...state, activity: action.activity };

    case "appendLive":
      return { ...state, live: [...state.live, action.block] };

    case "appendHistory":
      return { ...state, blocks: [...state.blocks, action.block] };

    case "patchBlock": {
      const live = patchIn(state.live, action.id, action.patch);
      if (live !== state.live) return { ...state, live };
      return { ...state, blocks: patchIn(state.blocks, action.id, action.patch) };
    }

    /**
     * Tool patches merge into the nested `call`, not the block.
     *
     * A shallow block-level merge would replace the whole `call` object and lose
     * the `kind` and `target` the block was created with, so a completing tool
     * would render as a blank row.
     */
    case "patchTool": {
      const apply = (block: Block): Block =>
        block.kind === "tool" && block.id === action.id
          ? { ...block, call: { ...block.call, ...action.patch } }
          : block;

      const live = state.live.map(apply);
      if (live.some((b, i) => b !== state.live[i])) return { ...state, live };
      return { ...state, blocks: state.blocks.map(apply) };
    }

    case "toggleExpanded": {
      const toggle = (block: Block): Block =>
        block.id === action.id && "expanded" in block
          ? ({ ...block, expanded: !block.expanded } as Block)
          : block;
      return {
        ...state,
        live: state.live.map(toggle),
        blocks: state.blocks.map(toggle),
      };
    }

    case "expandLast": {
      // Expand the most recent collapsible block, wherever it lives. Ctrl+O with
      // no explicit selection should act on what the user is looking at.
      const isExpandable = (block: Block) => "expanded" in block || block.kind === "log";
      const inLive = [...state.live].reverse().find(isExpandable);
      if (inLive) {
        return {
          ...state,
          live: state.live.map((b) =>
            b.id === inLive.id ? ({ ...b, expanded: !(b as { expanded?: boolean }).expanded } as Block) : b
          ),
        };
      }
      const inHistory = [...state.blocks].reverse().find(isExpandable);
      if (!inHistory) return state;
      return {
        ...state,
        blocks: state.blocks.map((b) =>
          b.id === inHistory.id
            ? ({ ...b, expanded: !(b as { expanded?: boolean }).expanded } as Block)
            : b
        ),
      };
    }

    case "commitLive":
      if (state.live.length === 0) return state;
      return { ...state, blocks: [...state.blocks, ...state.live], live: [] };

    case "clearLive":
      return { ...state, live: [] };

    case "permission":
      return { ...state, permission: action.request };

    case "pushHistory": {
      // Skip consecutive duplicates so holding Up does not walk through repeats.
      if (state.history[state.history.length - 1] === action.value) return state;
      return { ...state, history: [...state.history, action.value] };
    }

    case "clear":
      return { ...initialSession, history: state.history, debug: state.debug };

    case "toggleDebug":
      return { ...state, debug: !state.debug };
  }
}

export interface SessionApi {
  session: SessionSnapshot;
  dispatch: React.Dispatch<Action>;
  /** Append a block to the live turn and return its id. */
  addLive: (block: Omit<Block, "id"> & { id?: string }) => string;
  addTool: (kind: ToolKind, target: string) => string;
  patchTool: (
    id: string,
    patch: {
      status?: StatusKind;
      result?: string;
      error?: string;
      output?: string;
      elapsedMs?: number;
    }
  ) => void;
}

export function useSession(): SessionApi {
  const [session, dispatch] = useReducer(reducer, initialSession);

  const addLive = useCallback((block: Omit<Block, "id"> & { id?: string }) => {
    const id = block.id ?? nextId(block.kind);
    dispatch({ type: "appendLive", block: { ...block, id } as Block });
    return id;
  }, []);

  const addTool = useCallback((kind: ToolKind, target: string) => {
    const id = nextId("tool");
    dispatch({
      type: "appendLive",
      block: {
        kind: "tool",
        id,
        call: { id, kind, target, status: "running" },
      },
    });
    return id;
  }, []);

  const patchTool = useCallback(
    (
      id: string,
      patch: {
        status?: StatusKind;
        result?: string;
        error?: string;
        output?: string;
        elapsedMs?: number;
      }
    ) => {
      dispatch({ type: "patchTool", id, patch });
    },
    []
  );

  return useMemo(
    () => ({ session, dispatch, addLive, addTool, patchTool }),
    [session, addLive, addTool, patchTool]
  );
}

export { nextId };
