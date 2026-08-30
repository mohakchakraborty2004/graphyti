import {
  blastRadiusPromptSection,
  computeBlastRadius,
  emptyBlastRadius,
  type BlastRadiusResult,
} from "./blastRadius";
import { computeExpectedDelta, type ExpectedDelta } from "./expectedDelta";
import type { EditPlan, SchemaEdit } from "../generate/scopedEdit";

/**
 * One breaking schema operation, with everything derived from it kept together.
 *
 * The CLI and the TUI both used to carry `blastResults[]`, `breakingFieldNames[]`
 * and `expectedDeltas[]` as three parallel arrays and then re-pair them by
 * index or by model name. Both got it wrong in the same way — verification
 * received `blastResults[0]` and the flattened field names of *every* model, so
 * a second breaking model went unverified while its field names were checked
 * against the first model's files. Keeping the triple in one object removes the
 * chance of mispairing.
 */
export interface BreakingChange {
  edit: SchemaEdit;
  blastRadius: BlastRadiusResult;
  delta: ExpectedDelta;
  /** The field names this specific change breaks — never another model's. */
  breakingFieldNames: string[];
}

const BREAKING_OPS = new Set(["remove_field", "rename_field", "change_type", "remove_model"]);

export function isBreakingSchemaEdit(op: EditPlan[number]): op is SchemaEdit {
  return op.type === "schema" && BREAKING_OPS.has(op.op);
}

export function schemaEditsOf(plan: EditPlan): SchemaEdit[] {
  return plan.filter((op): op is SchemaEdit => op.type === "schema");
}

/**
 * Compute the blast radius and expected structural delta for every breaking
 * operation in a plan.
 *
 * The radius is seeded from the changed **field** where there is one. Seeding
 * from the model instead pulls in every dependent of every other field on that
 * model — and, through relation fields, dependents of neighbouring models too.
 */
export async function analyzeBreakingChanges(
  plan: EditPlan,
  projectRoot: string
): Promise<BreakingChange[]> {
  const breaking = plan.filter(isBreakingSchemaEdit);
  if (breaking.length === 0) return [];

  return Promise.all(
    breaking.map(async (edit) => {
      const target = { model: edit.model, field: edit.fieldName };
      let blastRadius: BlastRadiusResult;
      try {
        blastRadius = await computeBlastRadius(target, projectRoot);
      } catch {
        blastRadius = emptyBlastRadius(target);
      }
      return {
        edit,
        blastRadius,
        delta: computeExpectedDelta(edit, blastRadius, projectRoot),
        breakingFieldNames: edit.fieldName ? [edit.fieldName] : [],
      };
    })
  );
}

/** Distinct project-relative paths that must change, across all breaking ops. */
export function affectedFilePaths(changes: BreakingChange[]): string[] {
  const paths = new Set<string>();
  for (const change of changes) {
    for (const p of change.blastRadius.affectedFilePaths) paths.add(p);
  }
  return [...paths].sort();
}

/** Every affected graph node id, across all breaking ops. */
export function affectedNodeIds(changes: BreakingChange[]): string[] {
  const ids = new Set<string>();
  for (const { blastRadius } of changes) {
    for (const n of [
      ...blastRadius.affectedRoutes,
      ...blastRadius.affectedComponents,
      ...blastRadius.affectedFiles,
    ]) {
      ids.add(n.id);
    }
  }
  return [...ids];
}

/** The blast-radius text handed to the model at generation time. */
export function promptInjectionFor(changes: BreakingChange[]): string {
  return changes
    .map((c) => blastRadiusPromptSection(c.blastRadius))
    .filter(Boolean)
    .join("\n");
}

/** One-line-per-change description of what is breaking, for retry prompts. */
export function describeBreakingChanges(changes: BreakingChange[]): string {
  return changes
    .map(({ edit }) => {
      switch (edit.op) {
        case "rename_field":
          return `${edit.model}.${edit.fieldName} was renamed to ${edit.newFieldName}`;
        case "remove_field":
          return `${edit.model}.${edit.fieldName} was removed`;
        case "change_type":
          return `${edit.model}.${edit.fieldName} changed type from ${edit.fieldType} to ${edit.newFieldType}`;
        case "remove_model":
          return `model ${edit.model} was removed`;
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("; ");
}
