import type { BlastRadiusResult, AffectedNode } from "./blastRadius";
import { emptyBlastRadius, nodeIdFor } from "./blastRadius";
import type { SchemaEdit } from "../generate/scopedEdit";

// ---------------------------------------------------------------------------
// Expected structural delta — computed BEFORE generation, independent of LLM output
// ---------------------------------------------------------------------------

export interface ExpectedDeltaBase {
  changeType: "rename" | "add" | "remove" | "remove_model";
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

/** A whole Prisma model was removed, along with its relation fields. */
export interface ExpectedRemoveModelDelta extends ExpectedDeltaBase {
  changeType: "remove_model";
  targetNodeId: string;
  expectedRemovedRefs: string[];
}

export type ExpectedDelta =
  | ExpectedRenameDelta
  | ExpectedAddDelta
  | ExpectedRemoveDelta
  | ExpectedRemoveModelDelta;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Every node in the enforced blast radius.
 *
 * `computeBlastRadius` has already confirmed that each of these files names the
 * changing symbol on disk, so there is no second text check to do here. The
 * check that used to live in this module re-read every file to answer a
 * question the blast radius had already answered — and answered it with a
 * weaker rule, since it ignored whether the node was graph-linked at all.
 */
function enforcedNodes(blastRadius: BlastRadiusResult): AffectedNode[] {
  return [
    ...blastRadius.affectedRoutes,
    ...blastRadius.affectedComponents,
    ...blastRadius.affectedFiles,
  ];
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
    case "remove_model":
      return computeRemoveModelDelta(edit, blastRadius);
    default:
      throw new Error(`Unknown op: ${(edit as SchemaEdit).op}`);
  }
}

function computeRemoveModelDelta(
  edit: SchemaEdit,
  blastRadius: BlastRadiusResult
): ExpectedRemoveModelDelta {
  return {
    changeType: "remove_model",
    targetModel: edit.model,
    targetNodeId: `model:${edit.model}`,
    expectedRemovedRefs: enforcedNodes(blastRadius).map((n) => n.id),
  };
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

  const expectedRemovedRefs = enforcedNodes(blastRadius).map((n) => n.id);
  const expectedAddedRefs = [...expectedRemovedRefs];

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

  const expectedRemovedRefs = enforcedNodes(blastRadius).map((n) => n.id);

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
    const target = { model: edit.model, field: edit.fieldName };
    const blast =
      blastResults.find(
        (br) =>
          br.changedNode.id === nodeIdFor(target) ||
          br.changedNode.id === `model:${edit.model}`
      ) ?? emptyBlastRadius(target);

    deltas.push(computeExpectedDelta(edit, blast, projectRoot));
  }

  return deltas;
}
