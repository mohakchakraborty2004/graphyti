import { verifyBlastRadiusAddressed, type GeneratedFile, type VerifyReport } from "./verifyChange";
import { verifyGraphConsistency, type GraphVerifyResult } from "../graph/hydraVerify";
import type { BlastRadiusResult } from "../graph/blastRadius";
import type { ExpectedDelta } from "../graph/expectedDelta";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  };
  /** True when the HydraDB graph check was skipped because local check already failed. */
  graphCheckSkipped: boolean;
  /** True when the write should proceed; false when it must be blocked. */
  overallPassed: boolean;
  /** One-line summary for CLI display. */
  summary: string;
  /** Human-readable resolution rule applied. */
  resolutionReason: string;
}

// ---------------------------------------------------------------------------
// Unified structural validation
// ---------------------------------------------------------------------------

/**
 * Run both the local deterministic check and the HydraDB graph round-trip
 * check, then apply the resolution rule to determine whether the write
 * should proceed.
 *
 * Resolution rule:
 * 1. Local check is the primary gate — if it fails, block and SKIP the
 *    graph check entirely (no reason to pay for a real staging/ingestion/
 *    query cycle on a result that's already going to be discarded).
 * 2. If local passes but graph check finds staleNodesFound, also block —
 *    that is a real hygiene bug invisible to local re-parsing.
 * 3. If local passes and graph check only disagrees on soft/inferred
 *    relations that were never part of the explicit expected delta, log a
 *    warning but do not block — HydraDB's auto-extraction can surface
 *    extra inferred relations that aren't errors.
 */
export async function runUnifiedValidation(opts: {
  blastRadius: BlastRadiusResult;
  breakingFieldNames: string[];
  generatedFiles: GeneratedFile[];
  expectedDeltas: ExpectedDelta[];
  blastRadiusAffectedNodeIds: string[];
  projectRoot: string;
  proposedSchemaSource?: string;
}): Promise<UnifiedValidationResult> {
  const {
    blastRadius,
    breakingFieldNames,
    generatedFiles,
    expectedDeltas,
    blastRadiusAffectedNodeIds,
    projectRoot,
    proposedSchemaSource,
  } = opts;

  // ── 1. Local deterministic check ──────────────────────────────────
  const localReport = verifyBlastRadiusAddressed(
    blastRadius,
    breakingFieldNames,
    generatedFiles,
    projectRoot
  );

  const localPassed = localReport.missed.length === 0;

  // ── 2. Short-circuit: if local check failed, skip graph check ─────
  // No reason to pay for a real HydraDB staging/ingestion/query cycle
  // on a result that's already going to be discarded.
  if (!localPassed) {
    const totalAffected = localReport.addressed.length + localReport.missed.length;
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
        report: { graphAddressed: [], graphMissed: [], staleNodesFound: [] },
      },
      graphCheckSkipped: true,
      overallPassed: false,
      summary: `Structural validation FAILED (${localReport.addressed.length}/${totalAffected} files verified locally, graph check skipped)`,
      resolutionReason:
        "BLOCKED: local structural check failed (primary gate). " +
        "Graph check skipped — local checking is fully deterministic.",
    };
  }

  // ── 3. HydraDB graph round-trip check (only runs if local passed) ─
  const graphAddressed: string[] = [];
  const graphMissed: Array<{ nodeId: string; reason: string }> = [];
  const staleNodesFound: Array<{ nodeId: string; staleRef: string; relations: string[] }> = [];

  for (const delta of expectedDeltas) {
    try {
      const graphResult = await verifyGraphConsistency(
        delta,
        generatedFiles.map((f) => ({ filePath: f.path, content: f.content })),
        blastRadiusAffectedNodeIds,
        projectRoot,
        proposedSchemaSource
      );
      graphAddressed.push(...graphResult.graphAddressed);
      graphMissed.push(...graphResult.graphMissed);
      staleNodesFound.push(...graphResult.staleNodesFound);
    } catch (err) {
      graphMissed.push({
        nodeId: delta.changeType === "add" ? `model:${delta.targetModel}` : delta.targetNodeId,
        reason: `Graph verification error: ${err instanceof Error ? err.message : err}`,
      });
    }
  }

  const graphReport: GraphVerifyResult = {
    graphAddressed,
    graphMissed,
    staleNodesFound,
  };

  const graphHasStaleNodes = staleNodesFound.length > 0;
  const graphHasMissed = graphMissed.length > 0;

  // ── 4. Apply resolution rule (local already passed) ───────────────
  let overallPassed: boolean;
  let resolutionReason: string;

  if (graphHasStaleNodes) {
    // Rule 2: Local passes but graph found stale nodes — block
    overallPassed = false;
    resolutionReason =
      `BLOCKED: ${staleNodesFound.length} stale node(s) found in HydraDB. ` +
      "This is a real hygiene bug invisible to local re-parsing.";
  } else if (graphHasMissed) {
    // Rule 3: Local passes, graph has misses but no stale nodes.
    // These are likely soft/inferred relations from HydraDB auto-extraction
    // that were never part of the explicit expected delta — warn but allow.
    overallPassed = true;
    resolutionReason =
      `WARNING: ${graphMissed.length} graph relation(s) differ but no stale nodes. ` +
      "Likely HydraDB-inferred relations outside the explicit expected delta.";
  } else {
    overallPassed = true;
    resolutionReason = "PASSED: both local and graph checks agree.";
  }

  // ── 5. Build summary ──────────────────────────────────────────────
  const totalAffected =
    localReport.addressed.length + localReport.missed.length;

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
    },
    graphCheckSkipped: false,
    overallPassed,
    summary,
    resolutionReason,
  };
}
