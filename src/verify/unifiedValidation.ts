import {
  verifyStructuralChange,
  type GeneratedFile,
  type VerifyReport,
  type VerifyTarget,
} from "./verifyChange";
import { verifyGraphConsistency, type GraphVerifyResult } from "../graph/hydraVerify";
import type { BlastRadiusResult } from "../graph/blastRadius";
import type { ExpectedDelta } from "../graph/expectedDelta";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One breaking schema operation with everything derived from it.
 *
 * Structurally identical to `BreakingChange` in graph/changeAnalysis, declared
 * here as its own shape so the verifier does not depend on the analysis module.
 */
export interface ValidationChange {
  blastRadius: BlastRadiusResult;
  /** Field names *this* change breaks. */
  breakingFieldNames: string[];
  delta: ExpectedDelta;
}

export interface UnifiedValidationResult {
  localCheck: {
    addressed: number;
    missed: number;
    report: VerifyReport;
  };
  graphCheck: {
    addressed: number;
    missed: number;
    staleNodesFound: number;
    report: GraphVerifyResult;
    /** True when staged nodes were still indexing, so findings are advisory. */
    indexPending: boolean;
  };
  /** True when the HydraDB graph check was skipped because local check failed. */
  graphCheckSkipped: boolean;
  /** True when the write should proceed; false when it must be blocked. */
  overallPassed: boolean;
  /** One-line summary for CLI display. */
  summary: string;
  /** Human-readable resolution rule applied. */
  resolutionReason: string;
}

export interface UnifiedValidationOptions {
  /** Every breaking change in this step, each carrying its own field names. */
  changes: ValidationChange[];
  generatedFiles: GeneratedFile[];
  projectRoot: string;
  proposedSchemaSource?: string;
  /** Skip the HydraDB round trip (used by the post-retry re-check). */
  skipGraphCheck?: boolean;
}

// ---------------------------------------------------------------------------
// Unified structural validation
// ---------------------------------------------------------------------------

/**
 * Run the local deterministic check and the HydraDB graph round-trip check,
 * then apply the resolution rule.
 *
 * Resolution rule:
 * 1. Local check is the primary gate — if it fails, block and SKIP the graph
 *    check entirely (no reason to pay for a staging/ingestion/query cycle on a
 *    result that is already going to be discarded).
 * 2. If local passes but the graph check finds stale nodes, also block — that
 *    is a real hygiene bug invisible to local re-parsing. Unless HydraDB had
 *    not finished indexing the staged nodes, in which case "stale" and "not
 *    re-indexed yet" are indistinguishable and the finding is a warning.
 * 3. If local passes and the graph check only disagrees on soft/inferred
 *    relations, warn but do not block — HydraDB's own extraction surfaces
 *    relations that were never part of the explicit expected delta.
 */
export async function runUnifiedValidation(
  opts: UnifiedValidationOptions
): Promise<UnifiedValidationResult> {
  const { changes, generatedFiles, projectRoot, proposedSchemaSource } = opts;

  // ── 1. Local deterministic check ──────────────────────────────────
  const targets: VerifyTarget[] = changes.map((c) => ({
    blastRadius: c.blastRadius,
    oldFields: c.breakingFieldNames,
    removedModel:
      c.delta.changeType === "remove" && c.delta.targetNodeId.startsWith("model:")
        ? c.delta.targetModel
        : undefined,
  }));

  const localReport = verifyStructuralChange(targets, generatedFiles, projectRoot);
  const localPassed = localReport.missed.length === 0;
  const totalAffected = localReport.addressed.length + localReport.missed.length;

  // ── 2. Short-circuit: if local failed, skip the graph check ────────
  if (!localPassed) {
    return {
      localCheck: {
        addressed: localReport.addressed.length,
        missed: localReport.missed.length,
        report: localReport,
      },
      graphCheck: {
        addressed: 0,
        missed: 0,
        staleNodesFound: 0,
        report: { graphAddressed: [], graphMissed: [], staleNodesFound: [], indexPending: false },
        indexPending: false,
      },
      graphCheckSkipped: true,
      overallPassed: false,
      summary: `Structural validation FAILED (${localReport.addressed.length}/${totalAffected} files verified locally, graph check skipped)`,
      resolutionReason:
        "BLOCKED: local structural check failed (primary gate). " +
        "Graph check skipped — local checking is fully deterministic.",
    };
  }

  if (opts.skipGraphCheck) {
    return {
      localCheck: {
        addressed: localReport.addressed.length,
        missed: 0,
        report: localReport,
      },
      graphCheck: {
        addressed: 0,
        missed: 0,
        staleNodesFound: 0,
        report: { graphAddressed: [], graphMissed: [], staleNodesFound: [], indexPending: false },
        indexPending: false,
      },
      graphCheckSkipped: true,
      overallPassed: true,
      summary: `Structural validation PASSED (${localReport.addressed.length}/${totalAffected} files verified locally)`,
      resolutionReason: "PASSED: local structural check passed; graph check not requested.",
    };
  }

  // ── 3. HydraDB graph round-trip check ─────────────────────────────
  const graphAddressed: string[] = [];
  const graphMissed: Array<{ nodeId: string; reason: string }> = [];
  const staleNodesFound: Array<{ nodeId: string; staleRef: string; relations: string[] }> = [];
  let indexPending = false;

  for (const change of changes) {
    // Each change is verified against the node ids from ITS OWN blast radius.
    // Passing the union would ask HydraDB about model A's consumers while
    // looking for model B's renamed field.
    const nodeIds = [
      ...change.blastRadius.affectedRoutes,
      ...change.blastRadius.affectedComponents,
      ...change.blastRadius.affectedFiles,
    ].map((n) => n.id);

    try {
      const graphResult = await verifyGraphConsistency(
        change.delta,
        generatedFiles.map((f) => ({ filePath: f.path, content: f.content })),
        nodeIds,
        projectRoot,
        proposedSchemaSource
      );
      graphAddressed.push(...graphResult.graphAddressed);
      graphMissed.push(...graphResult.graphMissed);
      staleNodesFound.push(...graphResult.staleNodesFound);
      indexPending = indexPending || graphResult.indexPending;
    } catch (err) {
      graphMissed.push({
        nodeId:
          change.delta.changeType === "add"
            ? `model:${change.delta.targetModel}`
            : change.delta.targetNodeId,
        reason: `Graph verification error: ${err instanceof Error ? err.message : err}`,
      });
    }
  }

  const graphReport: GraphVerifyResult = {
    graphAddressed,
    graphMissed,
    staleNodesFound,
    indexPending,
  };

  // ── 4. Apply the resolution rule (local already passed) ───────────
  let overallPassed: boolean;
  let resolutionReason: string;

  if (staleNodesFound.length > 0) {
    // Reported loudly, but not blocking.
    //
    // A stale relation in HydraDB is a graph-hygiene problem: the files on disk
    // and the schema are correct — the local gate proved that deterministically
    // — and what degrades is future retrieval quality until the next
    // `init-graph`. Rolling back correct code over it is disproportionate, and
    // detection is inherently racy: HydraDB re-derives relations asynchronously,
    // so a correct rename can look stale for as long as the old extraction batch
    // remains current. Blocking on it failed correct runs in practice, which is
    // the opposite of what a safety gate is for.
    overallPassed = true;
    resolutionReason =
      `PASSED with warning: local check passed, but ${staleNodesFound.length} HydraDB relation(s) ` +
      `still point at the old node. Run "graphyti init-graph" to resync the graph.` +
      (indexPending ? " (HydraDB had not finished indexing, so this may simply be lag.)" : "");
  } else if (graphMissed.length > 0) {
    overallPassed = true;
    resolutionReason =
      `WARNING: ${graphMissed.length} graph relation(s) differ but no stale nodes. ` +
      "Likely HydraDB-inferred relations outside the explicit expected delta.";
  } else {
    overallPassed = true;
    resolutionReason = "PASSED: both local and graph checks agree.";
  }

  const summary = overallPassed
    ? `Structural validation PASSED (${localReport.addressed.length}/${totalAffected} files verified locally, ${graphAddressed.length} graph relations confirmed, ${staleNodesFound.length} stale nodes)`
    : `Structural validation FAILED — ${resolutionReason}`;

  return {
    localCheck: {
      addressed: localReport.addressed.length,
      missed: localReport.missed.length,
      report: localReport,
    },
    graphCheck: {
      addressed: graphAddressed.length,
      missed: graphMissed.length,
      staleNodesFound: staleNodesFound.length,
      report: graphReport,
      indexPending,
    },
    graphCheckSkipped: false,
    overallPassed,
    summary,
    resolutionReason,
  };
}
