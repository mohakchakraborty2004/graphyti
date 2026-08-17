# Graphyti

**A CLI coding agent that treats your codebase's structure as ground truth — not something the LLM has to remember correctly.**

Graphyti generates code changes the way most AI coding tools do (natural language in, working code out), but it's built around a different core claim: **the model never has to be trusted to remember your codebase correctly, because a deterministic code graph checks its work before anything is written to disk.**

---

## The problem: structural hallucination

Regular hallucination is the model inventing facts about the world. **Structural hallucination** is narrower and more dangerous for a coding agent: the model gets the shape of *your own codebase* wrong — it invents a field that doesn't exist on a model, forgets a relation it created two prompts ago, renames something without knowing three other files depend on it, or "helpfully" restructures code nobody asked it to touch.

Every AI coding tool eventually hits this. Cursor, Copilot, Aider — all of them fight some version of "keep the model's picture of the codebase accurate as it changes." Most solve it with better context retrieval (embeddings, repo maps, RAG). Graphyti solves a narrower, harder-to-fake piece of it: **it doesn't just retrieve better context — it verifies the output against a graph of the codebase's actual structure, independently of what the model claims it did.**

---

## How it works

1. **Deterministic extraction.** A static parser (Prisma schema parser + TypeScript AST analysis via ts-morph — never an LLM guess) builds a graph of your codebase: models, fields, API routes, components, and the real edges between them (which route queries which model, which component renders which field, which file imports which).

2. **Scoped, structured edits — not full-file regeneration.** The LLM never rewrites whole files. It first proposes a narrow, structured operation (e.g. `rename_field User.name → username`), which gets applied as a deterministic edit — a targeted schema mutation, or a search/replace snippet the model must anchor to the exact current file content. This alone eliminates an entire class of bugs: the model physically cannot silently delete or restructure code it wasn't asked to touch, because the edit mechanism doesn't give it the surface area to do so.

3. **Blast radius, computed before anything is written.** Before applying a breaking change, Graphyti walks the graph to answer: *what actually depends on this?* Which routes query this model, which components render this field, which files would silently break. It shows you this before writing a single file — not after.

4. **Two independent verification layers, not one.**
   - **Local structural check** — after generation, the same deterministic parser re-parses the *generated* content and confirms every file in the blast radius was genuinely addressed, not just touched.
   - **HydraDB graph check** — the generated change is also re-ingested into HydraDB and cross-checked against the graph's own stored relations, specifically to catch a failure class local parsing can't see by construction: stale or orphaned graph nodes left behind by an incomplete update (e.g. an old field reference that's still linked somewhere after a rename).

   Both must agree before anything is written. If either fails, Graphyti retries once with the specific gap called out, and if that still fails, it writes **nothing** and tells you exactly what's unresolved — rather than silently completing a partial change and reporting success.

5. **A real safety boundary on execution.** Any shell command the agent wants to run (`npm install`, `prisma generate`, `prisma migrate dev`) is matched against a strict allowlist and shown to you before it runs. Nothing outside that allowlist executes, ever, regardless of what the model proposes.

---

## Why this is different from "RAG over your codebase"

A lot of code-graph tools stop at retrieval: index the repo into a graph, use it to fetch smarter context, done. That's real, but it only makes the model's *input* better — it does nothing to verify the model's *output*. Graphyti's differentiator is that the graph is used twice: once to ground generation, and again, independently, to verify the result before it's trusted.

| | Embedding/RAG-only tools | Graphyti |
|---|---|---|
| Context retrieval | Similarity search | Graph traversal + hybrid search (HydraDB) |
| Edit mechanism | Full-file regeneration | Scoped structural edits only |
| Pre-write safety check | None, or model self-report | Blast radius computed from the graph, shown before write |
| Post-generation verification | None (trust the output) | Two independent checks: local re-parse + graph cross-check |
| Failure behavior | Writes whatever was generated | Blocks the write entirely if verification fails; nothing partial ever lands on disk |
| Shell command execution | Often unrestricted | Strict allowlist + explicit confirmation |

---

## HydraDB's role

HydraDB isn't a bolt-on for this project — it's used at four distinct points:

- **Ingestion** (`src/graph/ingest.ts`) — every extracted node (models, fields, routes, components) is ingested as a knowledge record with explicit forceful relations encoding the real edges between them.
- **Incremental sync** (`src/graph/incremental.ts`) — after every successful write, only the changed nodes are re-ingested, keeping the graph current without a full rescan.
- **Grounded retrieval** (`src/generate/retrieveContext.ts`) — generation is grounded using HydraDB's hybrid search + graph-context retrieval instead of a flat, ever-growing context file.
- **Independent structural verification** (`src/graph/hydraVerify.ts`) — the core differentiator: proposed changes are staged into HydraDB and cross-checked against its own stored relations before a write is allowed to proceed, specifically to catch stale/orphaned graph state that purely local parsing cannot detect.

---

## Safety by design

- **Blast radius confirmation** — breaking changes are shown, with reasons, before you're asked to confirm.
- **Two-layer verification** — nothing writes unless both the local parser and the independent graph check agree.
- **One bounded retry** — a verification miss gets one automatic retry with the specific gap fed back to the model; a second miss is a hard, clean failure, not a partial write.
- **Command allowlist** — `npm install`, `prisma generate`, and `prisma migrate dev` are the only shell commands the agent can ever execute, each shown and confirmed before running.
- **`--dry-run` and `--yes`** — preview any change with zero side effects, or script it non-interactively.
- **Clean exit codes** — `0` success, `1` expected/handled failure (verification blocked the write), `2` unexpected error — safe to use in scripts or CI, not just interactively.

---

## Tech stack

- **CLI:** TypeScript, Commander, Ora/Chalk for terminal UX
- **Static analysis:** ts-morph (TypeScript AST), a dedicated Prisma schema parser
- **Graph store:** [HydraDB](https://hydradb.com) — knowledge ingestion, forceful relations, hybrid graph-aware retrieval
- **LLM:** OpenRouter (model-agnostic — configurable via `OPENROUTER_MODEL`, no hardcoded provider dependency)
- **Target stack analyzed:** Next.js (App Router + Pages Router) + Prisma, with the extraction layer designed to extend to other frameworks

---

## Usage

```bash
# Point Graphyti at a project and build its code graph
graphyti graph init

# Make a scoped, verified change
graphyti "rename Post.title to headline"

# Preview without writing anything
graphyti "add a priority field to Post" --dry-run

# Non-interactive / scriptable
graphyti "add a priority field to Post" --yes --json
```

---

## What's next

Graphyti's core (extraction → scoped edits → blast radius → dual verification) is what's submitted for this hackathon. Actively in progress on a separate branch, not part of this submission:

- **Plan & Create mode** — decomposing broad requests ("add a login feature") into an ordered sequence of independently-verified structural steps, including net-new file creation.
- **Persistent terminal chat mode** — a long-lived conversational session (à la Claude Code/OpenCode) layered on top of the same verified pipeline, with a strict routing rule that any code-changing turn — however casually phrased — still goes through full blast-radius/verification, never bypassed for conversational convenience.
- **Hosted mode** — account-based setup (Next.js + Supabase) where users bring their own OpenRouter key and get a scoped HydraDB-backed graph, with the org's HydraDB credentials held server-side only, never exposed to the client.

---

## License

MIT