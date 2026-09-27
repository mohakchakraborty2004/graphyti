# Graphyti

A code-generation CLI for Next.js + Prisma projects that indexes your repo as a
**code graph** in HydraDB, grounds generation in that graph, computes the blast
radius of a schema change before writing anything, and mechanically verifies the
generated code against the graph before you commit.

```bash
graphyti init-graph                 # extract the code graph and ingest it into HydraDB
graphyti "add a heading field to Post"   # retrieve → generate → blast radius → verify → write
graphyti "…" --dry-run              # show blast radius + generated code, write nothing
graphyti "…" --yes                  # auto-confirm the blast-radius and command prompts
```

---

## Structural hallucination

An LLM asked to change a Prisma schema will produce code that is locally
plausible and globally wrong: it renames `Post.title` to `Post.heading` in
`schema.prisma`, and leaves every API route that selects `title` and every
component that renders `post.title` untouched. Nothing in the generated file
looks like a mistake — the hallucination is *structural*, living in the
relationships between files rather than inside any one of them, so reading the
diff file-by-file will not catch it. Graphyti closes that gap with a code graph
of models, fields, routes, components and imports, used at three distinct
moments: **grounding at generation time**, so the model sees the real schema and
the real call sites instead of guessing; **blast radius before writing**, so
every downstream dependent of a breaking change is enumerated from the graph and
shown to you for confirmation *before* a single file is touched; and
**mechanical verification after generation, before commit**, which uses a
two-layer structural validation approach.

### Two-layer structural validation

After code generation, Graphyti runs two independent verification passes:

1. **Local deterministic check** (`src/verify/verifyChange.ts`) — re-parses
   every file in the blast radius and confirms that none still references a
   removed or renamed field, using the same syntactic predicate the blast radius
   used to select those files (`src/verify/symbolRefs.ts`). Sharing the predicate
   is what keeps the two halves honest: a verifier that judged files by a
   different rule would either demand changes the radius never asked for, or
   clear files it flagged. This is fully deterministic: no network calls, no
   HydraDB timing dependencies, no LLM calls. If it fails, the write is blocked
   immediately.

2. **HydraDB graph round-trip check** (`src/graph/hydraVerify.ts`) — stages the
   proposed graph state into HydraDB, queries the relations for each consumer
   node, and verifies that stale references to the old field are gone. This
   catches a class of bug that local re-parsing structurally *cannot* see:
   HydraDB's own stored relations still pointing at a deleted or renamed node,
   which would leave the graph out of sync with disk even after the local files
   are correct.

**Resolution rule**: the local check is the only blocking gate. If it fails, the
write is blocked and the graph check is skipped entirely — there is no reason to
pay for a staging/ingestion/query cycle on a result already destined for the bin.

Everything the graph check finds is a warning. That includes stale nodes, which
an earlier design blocked on. Two reasons it should not:

- **It is a hygiene problem, not a correctness one.** When the local check has
  passed, the files and the schema on disk are provably consistent. What a stale
  relation degrades is future retrieval quality, until the next `init-graph` —
  which the warning tells you to run. Rolling back correct code over that is
  disproportionate.
- **Detection is inherently racy.** HydraDB re-derives relations asynchronously,
  and `indexingStatus: completed` does not mean that has happened. A correct
  rename shows the old *and* new relation side by side for as long as the
  previous extraction batch remains current. Blocking on it failed correct runs
  in practice, which is the opposite of what a gate is for.

Stale findings are still filtered before being reported: a relation is only
called stale if the batch carrying it was written *after* the change was staged,
which distinguishes a genuinely re-emitted dead reference from one that simply
has not been superseded yet.

The CLI output shows both checks distinctly:

```
  Local structural check: PASSED (3/3 files verified)
  Graph structural check: PASSED (3 relations confirmed, 0 stale nodes)
```

so it is visibly two independent layers, not one combined pass/fail.

---

## HydraDB

HydraDB is the graph store behind all four of those moments. It is not
decoration: the graph it holds is what blast radius walks and what the verifier
checks against. Every real call site, with line numbers:

### 1. Ingestion — `src/graph/ingest.ts`

The extracted graph is written to HydraDB as `app_knowledge` items, each one
carrying its **relations forcefully** — explicit neighbour ids on every item, so
HydraDB is given the edges rather than left to infer them from prose.

| What | Where |
| --- | --- |
| `client.context.ingest` (batched upsert, `upsert: "true"`) | [`src/graph/ingest.ts:196`](src/graph/ingest.ts#L196) |
| Forceful relations — `relations: { ids: [...] }` on every node | [`src/graph/ingest.ts:167`](src/graph/ingest.ts#L167) |
| `nodeToAppKnowledgeItem()` — node → HydraDB item, incl. `tenant_metadata` (`node_kind`, `file_path`) | [`src/graph/ingest.ts:150`](src/graph/ingest.ts#L150) |
| `ingestGraph()` — full-graph entry point, 200-item batches | [`src/graph/ingest.ts:250`](src/graph/ingest.ts#L250) |
| Per-item failure handling (`errorCode` / `request_id` surfaced, run aborts) | [`src/graph/ingest.ts:230`](src/graph/ingest.ts#L230) |
| `client.context.delete` — drop nodes that no longer exist | [`src/graph/ingest.ts:304`](src/graph/ingest.ts#L304) |
| `client.context.status` polling until `graph_creation` / `completed` | [`src/graph/hydraClient.ts:79`](src/graph/hydraClient.ts#L79) |

Invoked by `graphyti init-graph` → [`src/cli/init-graph.ts:7`](src/cli/init-graph.ts#L7).

### 2. Incremental updates — `src/graph/incremental.ts`

After every write, only the changed file is re-extracted and diffed against the
local graph map, so the graph stays current without a full re-ingest.

| What | Where |
| --- | --- |
| `reingestFile()` — re-extract one file, diff, upsert + delete | [`src/graph/incremental.ts:36`](src/graph/incremental.ts#L36) |
| Upsert/delete sets computed from the previous graph map | [`src/graph/incremental.ts:53`](src/graph/incremental.ts#L53) |
| `deleteKnowledgeIds` for nodes the file no longer owns | [`src/graph/incremental.ts:64`](src/graph/incremental.ts#L64) |
| `client.context.ingest` — changed nodes only | [`src/graph/incremental.ts:79`](src/graph/incremental.ts#L79) |
| `waitForIndexed` before the run reports success | [`src/graph/incremental.ts:115`](src/graph/incremental.ts#L115) |

Called per written file from [`src/index.ts:1103`](src/index.ts#L1103).

### 3. Graph-grounded retrieval — `src/generate/retrieveContext.ts`

The prompt context is a HydraDB query with graph context on — not a flat file
dump. This is the "grounding at generation time" step.

| What | Where |
| --- | --- |
| `client.query({ ... })` | [`src/generate/retrieveContext.ts:22`](src/generate/retrieveContext.ts#L22) |
| `queryBy: "hybrid"`, `mode: "thinking"` | [`src/generate/retrieveContext.ts:27`](src/generate/retrieveContext.ts#L27) |
| **`graphContext: true`** — pulls related nodes, not just text matches | [`src/generate/retrieveContext.ts:29`](src/generate/retrieveContext.ts#L29) |
| **`buildString(result)`** — SDK helper formats the envelope for the LLM; no hand-rolled JSON in the prompt | [`src/generate/retrieveContext.ts:35`](src/generate/retrieveContext.ts#L35) |
| `HydraDBError` handling — logs `error_code` + `request_id`, returns null | [`src/generate/retrieveContext.ts:39`](src/generate/retrieveContext.ts#L39) |

Consumed at [`src/index.ts:234`](src/index.ts#L234).

### 4. Blast-radius cross-check — `src/graph/blastRadius.ts`

The radius is seeded from the **changed field**, not from its model, and follows
edges in the direction that carries a dependency: routes that select the field,
components that render it, components that fetch an affected route, files that
import an affected file. Seeding from the model instead reaches every dependent
of every other field on that model, and through relation fields the dependents
of neighbouring models too — renaming `User.phone` would report the files behind
`/api/posts` as affected.

Every candidate then has to earn its place: the file must **syntactically
reference the field** (`post.title`, `{ title?: string }`, `select: { title }`),
not merely contain the word. That gate runs in both directions — it drops graph
neighbours that never touch the field, and it picks up files the extractor could
not link, which happens whenever a field name cannot be pinned to exactly one
queried model. Files that merely mention the name (a page's
`metadata = { title }`, a parameter called `title`) are listed as advisory and
never enforced.

The local map is walked for speed, then cross-checked against HydraDB's own view
of the node's relations, warning on any genuinely stale remote node
(non-blocking — a stale index degrades to a warning rather than a wrong answer).

| What | Where |
| --- | --- |
| **`client.context.relations`** — HydraDB's neighbours for the changed node | [`src/graph/blastRadius.ts:266`](src/graph/blastRadius.ts#L266) |
| `checkHydraConsistency()` — the cross-check itself | [`src/graph/blastRadius.ts:254`](src/graph/blastRadius.ts#L254) |
| Endpoint names read out of the returned relation triplets | [`src/graph/blastRadius.ts:281`](src/graph/blastRadius.ts#L281) |
| remote ids absent from the local graph → agree ✅ or warn ⚠️ | [`src/graph/blastRadius.ts:288`](src/graph/blastRadius.ts#L288) |
| `computeBlastRadius()` — directed walk + reference gate + the cross-check | [`src/graph/blastRadius.ts:385`](src/graph/blastRadius.ts#L385) |

Driven by the schema diff in [`src/generate/preWriteCheck.ts:295`](src/generate/preWriteCheck.ts#L295), and
consumed by the unified structural validator at [`src/verify/unifiedValidation.ts`](src/verify/unifiedValidation.ts)
which combines the local deterministic check with the HydraDB graph round-trip check.

### Client and configuration

The single shared client lives at
[`src/graph/hydraClient.ts:7`](src/graph/hydraClient.ts#L7); indexing waits are in
`waitForIndexed` at [`src/graph/hydraClient.ts:39`](src/graph/hydraClient.ts#L39). The database is
created with the `node_kind` / `file_path` metadata schema by
[`src/scripts/setup-hydra-db.ts`](src/scripts/setup-hydra-db.ts), and
[`src/scripts/check-ingest.ts`](src/scripts/check-ingest.ts) is a scratch script for
confirming ingestion and relations by hand.

Environment: `HYDRA_DB_API_KEY`, `HYDRA_DB_DATABASE`, `HYDRA_DB_COLLECTION`.

---

## Command safety

Generated `command` actions are never executed as free-form shell. Each one is
parsed against a structural allowlist
([`src/utils/commandAllowlist.ts`](src/utils/commandAllowlist.ts)) that accepts only:

```
npm install <pkg> [<pkg>...]        # optional -D / --save-dev / -E / --save-exact
npx prisma generate
npx prisma migrate dev --name <name>
```

Anything else — a different verb, an unrecognised flag, a shell operator, quoting
or substitution — is rejected with an explanation and skipped. Package names must
be plain npm names, optionally scoped and optionally pinned to an exact version
(`zod@3.23.8`); ranges, paths, URLs and git refs are refused. What matches is
printed verbatim with its working directory and requires an explicit `y/n`, the
same gate as the blast-radius confirmation; the canonical parsed argv is what
actually runs, via `spawnSync`, not the model's original string. `--yes`
auto-confirms; a non-interactive terminal without `--yes` refuses to run rather
than hanging. See [`src/agentPipeline.ts`](src/agentPipeline.ts).

---

## Run logs

Every run appends to `.dbagent/logs/graphyti.log` in the target project —
beside `graph-map.json`, in the same directory Graphyti already uses for its
own state. (Add `.dbagent` to the target project's `.gitignore` if it is not
there already; this repository already ignores it.) One line per event:

```
2026-09-27T10:12:03.412Z INFO  run.start {"query":"add a heading field to Post","dryRun":false,...}
2026-09-27T10:12:04.180Z INFO  blastRadius.computed {"breakingChanges":1,"mustChangeFiles":3}
2026-09-27T10:12:07.995Z ERROR verification.result {"passed":false,"localMissed":1,...}
2026-09-27T10:12:08.002Z ERROR run.end {"status":"blocked","exitCode":1,...}
```

Event names are stable — `run.start`, `intent.extracted`,
`blastRadius.computed`, `verification.result`, `command.refused`,
`file.updated`, `graph.reingested` — so a failed run can be reconstructed long
after the terminal has scrolled past it, including the two details that are
easiest to lose: *why* a write was blocked and *which* command the allowlist
refused.

- The log is written, never printed: it cannot disturb `--json` output and
  cannot tear the TUI's live frame.
- Logging can never fail a run. An unwritable destination disables the file for
  good and the pipeline carries on unchanged.
- Secrets are redacted before they reach disk — by key (`apiKey`, `token`,
  `Authorization`, …) and by value (`sk-…`, `Bearer …`), at any depth.
- The file rotates at 2 MB; the previous contents become `graphyti.log.1`.
- `GRAPHYTI_LOG=path/to/file.log` relocates it (a relative path resolves
  against the target project); `GRAPHYTI_LOG=off` turns file logging off.

Covered by `npm run test:logging`.

---

## Legacy flat context (fallback only)

`graphyti init` and `--legacy-context` use a pre-graph, relation-free snapshot at
`.dbagent/context.json`. It exists **only** as a safety net for a HydraDB outage:
with no relations there is no blast radius and nothing for the verifier to check.
The graph path is the real one. See the header of
[`src/utils/context.ts`](src/utils/context.ts)
