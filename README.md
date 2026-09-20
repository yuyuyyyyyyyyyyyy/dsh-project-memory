# dsh-project-memory

Cross-session engineering memory for coding agents running on
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A coding agent that works on one project across many sessions has no memory of
its own work. It re-derives causes it already found, and — worse — it retries
approaches the project already proved wrong. This plugin gives a project a
durable store of **engineering conclusions**, retrieves the few relevant to the
current task, and injects them into the prompt before the agent plans.

It stores conclusions, not transcripts. A record separates observed evidence
from inference from a verified conclusion, because collapsing those three is how
a guess becomes "history".

## What it contributes

One host-plane Cordis plugin. It changes nothing in the shipped harness: no core
package is patched, no shipped preset is copied or edited.

| Contribution | Hook | Why |
| --- | --- | --- |
| `projectMemory` service | host plane | Records back every session of a project; a per-session (preset realm) instance would defeat the feature |
| `project-memory:recall` | `ctx.systemPrompt.context()` | Recall runs during prompt assembly, so history is present **before** the agent reasons about the task |
| `project-memory:usage` | `ctx.systemPrompt.section()` | The standing contract: search first; record when the turn produced reusable knowledge; correct instead of duplicating |
| `memory_search` | `ctx.tools.register()` | Explicit lookup by file, symbol, error text, symptom, feature |
| `memory_record` | `ctx.tools.register()` | Write one structured conclusion |
| `memory_correct` | `ctx.tools.register()` | Mark an earlier conclusion `superseded` / `corrected` / `invalidated` / `confirmed`, optionally linking a replacement |
| `memory_audit` | `ctx.tools.register()` | Read back what was recalled, why, and what lost |

## Record schema

Fields, grouped by what kind of statement they carry:

| Group | Fields |
| --- | --- |
| Identity | `id`, `version`, `project`, `project_path`, `created_at`, `session_id`, `cwd` |
| Problem | `problem`, `symptoms[]` |
| **Observed** | `facts[]` — `{ statement, source }` |
| **Inferred** | `hypotheses[]` — `{ statement, status: open \| rejected \| confirmed }` |
| Attempts | `attempts[]` — `{ action, outcome: failed \| partial \| succeeded, why }`, `failed_attempts[]` |
| **Concluded** | `root_cause`, `conclusion: fact \| inferred \| verified \| decision`, `verification` |
| Outcome | `changes[]`, `constraints[]` |
| Recall signals | `related_files[]`, `related_symbols[]`, `tags[]` |
| Revision | `status: active \| confirmed \| superseded \| corrected \| invalidated`, `superseded_by`, `supersedes[]`, `revision`, `revised_at` |

`memory_record` refuses `conclusion: "verified"` unless `verification` is
non-empty. The store will not accept an unproven claim as verified.

## Recall

At every prompt assembly the plugin builds one query from the session log:

- the last **human** message (`source.kind === 'user'` — never injected context,
  never a tool result);
- file paths and symbols harvested from recent `tool/call` arguments;
- the session's `cwd`.

Candidates are filtered to **that project only** and scored:

| Signal | Weight |
| --- | --- |
| `related_files` path hit | 5 |
| `related_symbols` hit | 4 |
| `tags` hit | 3 |
| `problem` / `symptoms` term hit | 2 |
| prior `failed_attempts` / `constraints` term hit | 1.5 |
| character n-gram similarity — only when nothing above matched | ×6, floor 0.12 |

Single CJK characters score a fraction of a word, because CJK text is tokenized
into both unigrams and bigrams and unigrams alone let unrelated prose match.
At most `maxRecallRecords` (default 3) survive, each bounded; records that were
superseded or invalidated are filtered out with the records they replace. When
nothing clears `minScore`, **nothing is injected** — no empty block, no
per-request cost for an unrelated task.

## Project identity

`projectIdOf(cwd)` = a slug of the fully normalized `cwd` plus a hash of it.
Every read is filtered by that key, so two projects with an identical symptom
cannot see each other's memory. Windows paths are case-folded; separators are
normalized.

## Transparency

Every recall, write, and revision is appended to a bounded audit trail,
readable through `memory_audit` and filterable by action and project. Each entry
carries the query, the candidate count, the injected record ids, the per-record
relevance reasons, and the injected size — so "why was this recalled, and what
lost?" is answerable. With `DSH_PROJECT_MEMORY_DEBUG=1` (or `debug: true` on the
row) the entries are also logged at info level.

## Install

1. Put `index.js` and `package.json` in
   `$DSH_HOME/profiles/dsh-project-memory/`. Its `@deepseek-ai/*` imports resolve
   through `$DSH_HOME/profiles/node_modules`, so there is no install step.
2. Add ONE row to your profile's user patch layer,
   `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (see `cordis.patch.yml` here
   for the commented template):

```yaml
- insert:
    - id: project-memory
      name: '/absolute/path/to/profiles/dsh-project-memory/index.js'
```

3. Restart `dsh`.

The name must be an **absolute path**: a bare package name does not resolve (the
harness's package graph does not contain this package), and a `./relative` name
resolves against the patch file's own directory.

## Deployment constraints

Learned by hitting them; they are also in the memory this plugin manages.

1. **A patch row's `name` must be a literal string — never a `!!js` expression.**
   The patch layer is anchored by `anchorInsertedPluginNames`, which only
   rewrites a `name` it can prove is a string (`typeof entry.name === 'string'`).
   A `!!js` scalar arrives as a `{__jsExpr}` object, skips that rewrite, reaches
   the Loader's `import()`, and the boot dies with
   `name.startsWith is not a function`. `!!js` is for a row's `config` values; a
   row's `name` is consumed to resolve the module *before* any interpolation.
2. **Editing plugin source does not update a preset already mounted in a running
   process.** Modules are cached by URL: touching the composition, the mount
   stamp changing, and even pointing the preset at a freshly named file all keep
   serving the module the process first imported. Restart `dsh`.
3. **Never run two `dsh` processes against the same `$DSH_HOME`.** Session logs
   are single-writer; the second instance cannot resume anything the first still
   holds and fails with `SessionAlreadyOwnedError (gateway/internal)`.

## Configuration

Every key is optional:

```yaml
- insert:
    - id: project-memory
      name: '/absolute/path/to/profiles/dsh-project-memory/index.js'
      config:
        maxRecallRecords: 3
        maxRecallChars: 2600
        perRecordChars: 900
        minScore: 3
        auditLimit: 50
        debug: false
```

## Storage

Records live on the harness's own storage stack — a `dsh_project_memory` domain
over the JSON backend, not a parallel store:

```
$DSH_HOME/storages/dsh_project_memory/records/<record-id>.json
$DSH_HOME/storages/dsh_project_memory/index/<project-id>.json
```

The domain uses the `per-record` layout with `invalidRecords: 'backup-and-skip'`,
so one damaged document can never cost the whole store. Each document is a
versioned envelope `{ version, record }`.

## Tests

`test.mjs` mounts the plugin through a real Cordis Loader over a real composition
file, with the real storage hub, domain facility, tool registry, and
system-prompt registry. Only the storage medium is faked
(`memory-backend.mjs`), so nothing touches `$DSH_HOME`.

```sh
# the dependency mirror inside the installed harness
export DSH_PLUGIN_DEPS="$DSH_HOME/profiles/node_modules"
node --import ./register-deps.mjs test.mjs     # 74 checks
node --import ./register-deps.mjs loader.test.mjs   # 6 checks
```

`test.mjs` covers: first encounter with no history, write (including rejection of
an unproven `verified`), cross-session recall, failed-plan prohibition, correction
and supersession, project isolation, bounded recall over 40+ records, audit
filtering, and reload over the same medium.

## Status

Offline suites pass against the real DSH modules (74 + 6 checks). On a live
project the full chain has been observed: a conclusion is produced, recorded
**autonomously** (no instruction to remember anything appears in the prompt), the
record lands in the JSON backend, a later session's first prompt already carries
it, and a fresh session reuses it. `memory_correct` has unit coverage but has not
yet been exercised end-to-end on a live record that later proved wrong.

## Known limitations

- **Recall is lexical.** Exact token hits plus a character n-gram fallback —
  there are no embeddings. A rephrased problem may not match; `memory_search` is
  the escape hatch.
- **The n-gram fallback is loose for short records.** Jaccard over few n-grams
  reaches the 0.12 floor easily: two short, barely related texts sharing one
  bigram can score ≈ 0.2, clear the floor, and (if `minScore` is met) be
  recalled. Lower `maxRecallRecords` or raise `minScore` when this matters.
- **No persisted inverted index** — the candidate set is scored per recall from
  the in-memory domain table. Fine at hundreds of records; not measured at tens
  of thousands.
- **Precision is preferred over recall.** `minScore` (default 3) drops weak
  candidates silently; a marginal record can miss injection at score ≈ 4.
- **The audit trail is in-memory** — bounded, lost on restart.
- **Recording depends on the model following the contract.** The contract text
  is deliberately prescriptive: a purely permissive wording produced zero writes
  in testing.

## License

MIT — see `LICENSE`.
