/**
 * Ambient session facts for the header: project directory, git branch, model.
 *
 * Git is read with a short-timeout `spawnSync` on mount and then on demand, not
 * polled: the header is decoration, and a background poll that redraws the frame
 * every second would fight the "do not let the UI jump" requirement (§28) for no
 * user benefit.
 */

import { useEffect, useState } from "react";
import { spawnSync } from "child_process";
import path from "path";
import os from "os";

export interface GitInfo {
  branch: string;
  /** Working tree has uncommitted changes — rendered as a trailing `*` (§21). */
  dirty: boolean;
  ahead: number;
  behind: number;
}

export interface SessionInfo {
  /** Project directory, `~`-abbreviated. */
  cwd: string;
  git: GitInfo | null;
  version: string;
  model: string;
}

function git(args: string[], cwd: string): string | null {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: 1500,
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

export function readGitInfo(cwd: string): GitInfo | null {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!branch) return null;

  const status = git(["status", "--porcelain"], cwd);
  const dirty = status !== null && status.length > 0;

  let ahead = 0;
  let behind = 0;
  const counts = git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], cwd);
  if (counts) {
    const [b, a] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10));
    behind = Number.isFinite(b) ? b! : 0;
    ahead = Number.isFinite(a) ? a! : 0;
  }

  return { branch, dirty, ahead, behind };
}

/** Abbreviate a home-relative path to `~/...`, with forward slashes. */
export function abbreviatePath(target: string): string {
  const home = os.homedir();
  const normalized = target.split(path.sep).join("/");
  const normalizedHome = home.split(path.sep).join("/");

  if (normalized === normalizedHome) return "~";
  if (normalized.startsWith(normalizedHome + "/")) {
    return "~" + normalized.slice(normalizedHome.length);
  }
  return normalized;
}

export function useSessionInfo(version: string, model: string): SessionInfo {
  const cwd = process.cwd();
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);

  useEffect(() => {
    // Deferred so a slow git call cannot delay the first paint.
    const timer = setTimeout(() => setGitInfo(readGitInfo(cwd)), 0);
    return () => clearTimeout(timer);
  }, [cwd]);

  return {
    cwd: abbreviatePath(cwd),
    git: gitInfo,
    version,
    model,
  };
}
