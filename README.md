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
**mechanical verification after generation, before commit**, which re-parses the
generated code and fails the run if any file in the blast radius still
references a removed or renamed field. The verifier is deterministic AST and
text matching, not another model call — it cannot be talked out of a failure.

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
| `client.context.ingest` (batched upsert, `upsert: "true"`) | [`src/graph/ingest.ts:195`](src/graph/ingest.ts#L195) |
| Forceful relations — `relations: { ids: [...] }` on every node | [`src/graph/ingest.ts:167`](src/graph/ingest.ts#L167) |
| `nodeToAppKnowledgeItem()` — node → HydraDB item, incl. `tenant_metadata` (`node_kind`, `file_path`) | [`src/graph/ingest.ts:149`](src/graph/ingest.ts#L149) |
| `ingestGraph()` — full-graph entry point, 200-item batches | [`src/graph/ingest.ts:249`](src/graph/ingest.ts#L249) |
| Per-item failure handling (`errorCode` / `request_id` surfaced, run aborts) | [`src/graph/ingest.ts:230`](src/graph/ingest.ts#L230) |
| `client.context.delete` — drop nodes that no longer exist | [`src/graph/ingest.ts:269`](src/graph/ingest.ts#L269) |
| `client.context.status` polling until `graph_creation` / `completed` | [`src/graph/hydraClient.ts:55`](src/graph/hydraClient.ts#L55) |

Invoked by `graphyti init-graph` → [`src/cli/init-graph.ts:8`](src/cli/init-graph.ts#L8).

### 2. Incremental updates — `src/graph/incremental.ts`

After every write, only the changed file is re-extracted and diffed against the
local graph map, so the graph stays current without a full re-ingest.

| What | Where |
| --- | --- |
| `reingestFile()` — re-extract one file, diff, upsert + delete | [`src/graph/incremental.ts:35`](src/graph/incremental.ts#L35) |
| Upsert/delete sets computed from the previous graph map | [`src/graph/incremental.ts:52`](src/graph/incremental.ts#L52) |
| `deleteKnowledgeIds` for nodes the file no longer owns | [`src/graph/incremental.ts:64`](src/graph/incremental.ts#L64) |
| `client.context.ingest` — changed nodes only | [`src/graph/incremental.ts:78`](src/graph/incremental.ts#L78) |
| `waitForIndexed` before the run reports success | [`src/graph/incremental.ts:115`](src/graph/incremental.ts#L115) |

Called per written file from [`src/index.ts:204`](src/index.ts#L204).

### 3. Graph-grounded retrieval — `src/generate/retrieveContext.ts`

The prompt context is a HydraDB query with graph context on — not a flat file
dump. This is the "grounding at generation time" step.

| What | Where |
| --- | --- |
| `client.query({ ... })` | [`src/generate/retrieveContext.ts:20`](src/generate/retrieveContext.ts#L20) |
| `queryBy: "hybrid"`, `mode: "thinking"` | [`src/generate/retrieveContext.ts:25`](src/generate/retrieveContext.ts#L25) |
| **`graphContext: true`** — pulls related nodes, not just text matches | [`src/generate/retrieveContext.ts:27`](src/generate/retrieveContext.ts#L27) |
| **`buildString(result)`** — SDK helper formats the envelope for the LLM; no hand-rolled JSON in the prompt | [`src/generate/retrieveContext.ts:33`](src/generate/retrieveContext.ts#L33) |
| `HydraDBError` handling — logs `error_code` + `request_id`, returns null | [`src/generate/retrieveContext.ts:35`](src/generate/retrieveContext.ts#L35) |

Consumed at [`src/index.ts:73`](src/index.ts#L73).

### 4. Blast-radius cross-check — `src/graph/blastRadius.ts`

Blast radius walks the local graph map for speed, then cross-checks its
hop-1 neighbours against HydraDB's own view of the same node's relations and
warns on any disagreement (non-blocking — a stale index degrades to a warning
rather than a wrong answer).

| What | Where |
| --- | --- |
| **`client.context.relations`** — HydraDB's neighbours for the changed node | [`src/graph/blastRadius.ts:166`](src/graph/blastRadius.ts#L166) |
| `checkHydraConsistency()` — the cross-check itself | [`src/graph/blastRadius.ts:160`](src/graph/blastRadius.ts#L160) |
| Neighbour ids read out of the returned relation triplets | [`src/graph/blastRadius.ts:177`](src/graph/blastRadius.ts#L177) |
| local-only / HydraDB-only diff → agree ✅ or warn ⚠️ | [`src/graph/blastRadius.ts:190`](src/graph/blastRadius.ts#L190) |
| `computeBlastRadius()` — 3-hop BFS + the cross-check | [`src/graph/blastRadius.ts:248`](src/graph/blastRadius.ts#L248) |

Driven by the schema diff in [`src/generate/preWriteCheck.ts:295`](src/generate/preWriteCheck.ts#L295), and
consumed by the verifier at [`src/verify/verifyChange.ts:218`](src/verify/verifyChange.ts#L218).

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

## Legacy flat context (fallback only)

`graphyti init` and `--legacy-context` use a pre-graph, relation-free snapshot at
`.dbagent/context.json`. It exists **only** as a safety net for a HydraDB outage:
with no relations there is no blast radius and nothing for the verifier to check.
The graph path is the real one. See the header of
[`src/utils/context.ts`](src/utils/context.ts)