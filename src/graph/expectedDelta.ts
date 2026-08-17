import * as fs from "fs";
import * as path from "path";
import { loadGraphMap, type GraphMap } from "./ingest";
import type { BlastRadiusResult, AffectedNode } from "./blastRadius";
import type { SchemaEdit } from "../generate/scopedEdit";

// ---------------------------------------------------------------------------
// Expected structural delta — computed BEFORE generation, independent of LLM output
// ---------------------------------------------------------------------------

export interface ExpectedDeltaBase {
  changeType: "rename" | "add" | "remove";
  targetModel: string;
}

export interface ExpectedRenameDelta extends ExpectedDeltaBase {
  changeType: "rename";
  targetNodeId: string;
  oldName: string;
  newName: string;
  expectedRemovedRefs: string[];
  expectedAddedRefs: string[];
}

export interface ExpectedAddDelta extends ExpectedDeltaBase {
  changeType: "add";
  newNodeExpected: {
    modelName: string;
    fieldName: string;
    fieldType: string;
  };
  expectedRemovedRefs: [];
}

export interface ExpectedRemoveDelta extends ExpectedDeltaBase {
  changeType: "remove";
  targetNodeId: string;
  expectedRemovedRefs: string[];
}

export type ExpectedDelta =
  | ExpectedRenameDelta
  | ExpectedAddDelta
  | ExpectedRemoveDelta;

// ---------------------------------------------------------------------------
// Helpers — check whether a blast-radius node references a given field
// ---------------------------------------------------------------------------

function nodeReferencesField(
  node: AffectedNode,
  _modelName: string,
  fieldName: string,
  projectRoot: string
): boolean {
  const absPath = path.resolve(projectRoot, node.filePath);
  if (!fs.existsSync(absPath)) return false;

  const content = fs.readFileSync(absPath, "utf-8");

  // Word-boundary match for the field name.  The graph structure already
  // guarantees this node is connected to the changed model (via blast radius),
  // so we don't need to re-check the model name here — Prisma often refers
  // to models with a lowercase alias (e.g. `prisma.post` vs `Post`), which
  // would cause false negatives with a literal match.
  const fieldRe = new RegExp(`\\b${escapeRegex(fieldName)}\\b`);
  return fieldRe.test(content);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Core — compute expected delta from a schema edit + blast radius
// ---------------------------------------------------------------------------

export function computeExpectedDelta(
  edit: SchemaEdit,
  blastRadius: BlastRadiusResult,
  projectRoot: string = process.cwd()
): ExpectedDelta {
  switch (edit.op) {
    case "rename_field":
      return computeRenameDelta(edit, blastRadius, projectRoot);
    case "add_field":
      return computeAddDelta(edit);
    case "remove_field":
      return computeRemoveDelta(edit, blastRadius, projectRoot);
    case "change_type":
      // change_type is structurally similar to remove+add at the reference level:
      // old type refs become invalid, new type refs are expected.  For now we model
      // it as a remove (old type no longer referenced) since the field name itself
      // doesn't change.  A future refinement could add a separate change_type delta.
      return computeRemoveDelta(
        { ...edit, op: "remove_field" } as SchemaEdit,
        blastRadius,
        projectRoot
      );
    default:
      throw new Error(`Unknown op: ${(edit as SchemaEdit).op}`);
  }
}

function computeRenameDelta(
  edit: SchemaEdit,
  blastRadius: BlastRadiusResult,
  projectRoot: string
): ExpectedRenameDelta {
  const modelName = edit.model;
  const oldName = edit.fieldName!;
  const newName = edit.newFieldName!;
  const targetNodeId = `field:${modelName}.${oldName}`;

  const allAffected: AffectedNode[] = [
    ...blastRadius.affectedRoutes,
    ...blastRadius.affectedComponents,
    ...blastRadius.affectedFiles,
  ];

  const expectedRemovedRefs: string[] = [];
  const expectedAddedRefs: string[] = [];

  for (const node of allAffected) {
    if (nodeReferencesField(node, modelName, oldName, projectRoot)) {
      // This node currently references oldName — after generation it must not,
      // and must reference newName instead.
      expectedRemovedRefs.push(node.id);
      expectedAddedRefs.push(node.id);
    }
  }

  return {
    changeType: "rename",
    targetModel: modelName,
    targetNodeId,
    oldName,
    newName,
    expectedRemovedRefs,
    expectedAddedRefs,
  };
}

function computeAddDelta(edit: SchemaEdit): ExpectedAddDelta {
  return {
    changeType: "add",
    targetModel: edit.model,
    newNodeExpected: {
      modelName: edit.model,
      fieldName: edit.fieldName!,
      fieldType: edit.fieldType!,
    },
    expectedRemovedRefs: [],
  };
}

function computeRemoveDelta(
  edit: SchemaEdit,
  blastRadius: BlastRadiusResult,
  projectRoot: string
): ExpectedRemoveDelta {
  const modelName = edit.model;
  const fieldName = edit.fieldName!;
  const targetNodeId = `field:${modelName}.${fieldName}`;

  const allAffected: AffectedNode[] = [
    ...blastRadius.affectedRoutes,
    ...blastRadius.affectedComponents,
    ...blastRadius.affectedFiles,
  ];

  const expectedRemovedRefs: string[] = [];

  for (const node of allAffected) {
    if (nodeReferencesField(node, modelName, fieldName, projectRoot)) {
      expectedRemovedRefs.push(node.id);
    }
  }

  return {
    changeType: "remove",
    targetModel: modelName,
    targetNodeId,
    expectedRemovedRefs,
  };
}

// ---------------------------------------------------------------------------
// Batch — compute deltas for multiple schema edits in a plan
// ---------------------------------------------------------------------------

export function computeExpectedDeltas(
  edits: SchemaEdit[],
  blastResults: BlastRadiusResult[],
  projectRoot: string = process.cwd()
): ExpectedDelta[] {
  const deltas: ExpectedDelta[] = [];

  for (const edit of edits) {
    // Find the matching blast result by model name
    const blast = blastResults.find(
      (br) => br.changedNode.id === `model:${edit.model}`
    );
    if (!blast) {
      // No blast radius found — still compute the delta (it may be additive
      // or the model isn't in the graph yet).
      deltas.push(computeExpectedDelta(edit, {
        changedNode: { id: `model:${edit.model}`, name: edit.model, kind: "PrismaModel", filePath: "" },
        affectedRoutes: [],
        affectedComponents: [],
        affectedFiles: [],
      }, projectRoot));
      continue;
    }

    deltas.push(computeExpectedDelta(edit, blast, projectRoot));
  }

  return deltas;
}
