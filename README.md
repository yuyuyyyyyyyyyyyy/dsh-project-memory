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
| `memory_forget` | `ctx.tools.register()` | Delete one record, or a bounded batch of inactive records, with project checks |
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

```sh
dsh plugin --profile web add github:yuyuyyyyyyyyyyyy/dsh-project-memory
```

Then restart `dsh`. That is the whole install. This package declares
`dsh.bundle.patch`, so `dsh plugin` appends it to the profile's
`dsh.profile.bundles`, and the bundle's own `cordis.patch.yml` mounts the plugin
host-side. Swap `web` for your profile name; swap `github:` for a registry name,
a tarball, or a local path if you prefer.

`dsh plugin` is a thin `pnpm` forwarder, so `pnpm` has to be on `PATH`
(`corepack enable pnpm`, or `npm i -g pnpm`). This package ships no install
scripts, so there is nothing pnpm has to be allowed to build.

<details>
<summary>Manual install, no pnpm</summary>

1. Put this directory at `$DSH_HOME/profiles/node_modules/dsh-project-memory/`,
   or anywhere else under `$DSH_HOME/profiles/` that Node's `node_modules` walk
   reaches from the profile directory.
2. Add `"dsh-project-memory"` to the `dsh.profile.bundles` array in
   `$DSH_HOME/profiles/<profile>/package.json`.
3. Restart `dsh`.

A bare package name resolves from the profile directory's `node_modules`; a
`./relative` name resolves against the patch file's own directory; a `!!js`
name crashes the boot (see *Deployment constraints*).
</details>

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
3. **Two `dsh` processes on one `$DSH_HOME` cannot share a session.** Session
   artifacts are single-writer per session: the second instance fails with
   `SessionAlreadyOwnedError (gateway/internal)` when it opens a session the first
   one holds. Separate sessions do run side by side — see *Concurrent writers* for
   what that costs the memory store.

## Configuration

Every key is optional:

```yaml
- insert:
    - id: project-memory
      name: dsh-project-memory
      config:
        maxRecallRecords: 3
        maxRecallChars: 2600
        perRecordChars: 900
        minScore: 3
        auditLimit: 50
        leaseWaitMs: 15000
        leaseStaleMs: 30000
        storeDir: ''
        debug: false
```

`storeDir` defaults to `$DSH_HOME/storages/dsh_project_memory` — the shell's own
layout, which the write lease and the record reads depend on. Set it only if the
storage backend's root is somewhere else.

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

`$DSH_HOME/storages/dsh_project_memory/.leases/<project-id>.lock` sits beside
them: the exclusive-create lock that serializes writers across processes (see
*Concurrent writers*). It is not a document, so the per-record loader ignores it.

## Tests

`test.mjs` mounts the plugin through a real Cordis Loader over a real composition
file, with the real storage hub, domain facility, tool registry, and
system-prompt registry. Only the storage medium is faked
(`memory-backend.mjs`), so nothing touches `$DSH_HOME`.

```sh
# the dependency mirror inside the installed harness
export DSH_PLUGIN_DEPS="$DSH_HOME/profiles/node_modules"
node --import ./register-deps.mjs test.mjs                        # 78 checks
node --import ./register-deps.mjs regression-consistency.test.mjs # 27 checks
node --import ./register-deps.mjs lease.test.mjs                  # 9 checks, 3 processes
node --import ./register-deps.mjs loader.test.mjs                 # 6 checks
node --import ./register-deps.mjs regression.test.mjs             # 10 checks
node --import ./register-deps.mjs regression-forget.test.mjs      # 17 checks

# Or run all six suites through the package entry point:
npm test
```

`test.mjs` covers: first encounter with no history, write (including rejection of
an unproven `verified`), cross-session recall, failed-plan prohibition, correction
and supersession, project isolation, bounded recall over 40+ records, audit
filtering, and reload over the same medium.

`regression.test.mjs` pins two defects that shipped once and are easy to
reintroduce:

- an index of the right LENGTH but wrong CONTENT (an id that matches no record)
  is repaired on open — a length comparison alone left it in place;
- `memory_correct(status: "corrected")` with no replacement is refused, because
  recall filters superseded/invalidated records while a correction is only
  meaningful in favour of a replacement — without one the stale text would keep
  reaching later sessions.

## Concurrent writers

Several `dsh` processes can share one `$DSH_HOME` — they cannot share one
*session*, but they can each own a different one — and every one of them writes
the same project store. Writes are serialized rather than hoped not to collide.

Before each mutation the plugin takes
`<store>/.leases/<project-id>.lock` with an exclusive create (`wx`), so the
filesystem admits exactly one holder. Inside that hold it re-reads the record
**document** instead of trusting its own in-memory copy, bumps that revision, and
writes. The lock file names its holder, so a rival process can see who is writing
which record, and `memory_audit` logs `write-conflict` / `write-bypass`.

Measured with three OS processes (`lease.test.mjs`: two writers, 40 updates each
on one record, plus an independent verifier):

| | revision after 80 updates | writes failed |
|---|---|---|
| no lease | 41 — one writer's whole lineage, half the updates gone | 3 |
| with lease | 81 — every update survived | 0 |

The lease is **best-effort coordination, not a mutex**, and the difference is the
whole story:

- A rival that finishes in time is waited out. That is normal contention and is
  audited as `write-conflict` (with `waited_ms` and the operation).
- A lock is only **stolen** when it is older than `leaseStaleMs` *and* its holder's
  pid is gone. Staleness alone is never proof, so a live-but-slow holder is not
  robbed for age.
- The wait is nevertheless bounded by `leaseWaitMs` (15 s default). When the
  budget expires the writer **takes the file over** — alive holder or not — and
  proceeds, audited as `write-bypass`. That is deliberate: refusing to store an
  engineering conclusion because another process is wedged would be worse.

So mutual exclusion holds only *up to* `leaseWaitMs`; after it, two writers can be
inside at once. Lowering the budget makes that reachable at once — a probe with
`leaseWaitMs: 120` against a 400 ms hold measures `maxActive: 2` and one
`write-bypass` — while at the default it takes a holder stuck for 15 s. Treat the
guarantee as: *no update is computed from a snapshot a completed rival write has
already superseded*, not as *writers are mutually excluded*.

Two invariants keep the coordination from becoming the failure:

- **A lease that cannot be taken never fails the write.** If the lock cannot be
  created — read-only store, a sandbox that denies it — the write proceeds
  uncoordinated and the degradation is audited once as `write-lease-unavailable`.
- **The medium is the authority whenever it can be read whole.** A record missing
  from a readable store is *deleted*, not stale, and a project's index is rebuilt
  from the medium instead of merged with this process's memory — that merge is
  exactly what put a deleted record back into the index.

The lock is a file, not a kernel lock: a process killed mid-write leaves it
behind, which is why age *plus* a dead pid is what justifies a steal. A transient
`EPERM`/`EBUSY` from the medium — on Windows, another process simply holding a
record file open during a rename — is retried instead of surfacing.

`lease.test.mjs` is the cross-process suite: it spawns two rival writer
processes and one verifier over a real JSON store, and asserts that all 80
updates survive, that no write failed, that every lease was released, and that a
fresh process sees the final state. It fails (revision 41) against a build
without the lease, which is how the fix was proven.

## Status

**Available beta, for low-concurrency personal use.** Offline suites pass against
the real DSH modules (78 + 27 + 9 + 6 + 10 + 17 = 147 checks). On a live project
the full chain has been observed: a conclusion is produced, recorded
**autonomously** (no instruction to remember anything appears in the prompt), the
record lands in the JSON backend, a later session's first prompt already carries
it, and a fresh session reuses it. `memory_correct` has now been exercised on a
live record as well — and that run is what found the eighth defect: a correction
*without* a replacement wrote `replacement_id: undefined` into its audit entry,
and because a tool result must be lossless JSON, the harness then rejected **every
`memory_audit` call** for the rest of that process. Fixed at the source
(`?? null`) and again at the tool boundary; `regression-consistency.test.mjs`
R7–R10 pin both.

An independent audit then reproduced seven consistency defects against `ba4778a`:
a deleted record coming back and ghost ids in the index, a lease holder deleting
its successor's lock, the wait budget breaking mutual exclusion, `memory_correct`
skipping its ownership check without a cwd, `memory_audit` reading another
project, an audit action overwritten by its own payload, and a recall budget
overshoot. All seven are fixed, each pinned by `regression-consistency.test.mjs`,
and the auditor's own probe and seven assertions pass **unmodified** against the
fix.

What this is **not**: a strict cross-process consistency guarantee. Coordination
is best-effort by design (see *Concurrent writers*), and `releaseLease` carries a
known, unreproduced TOCTOU risk (see *Known limitations*).

Migrating the lease to the harness's internal `flock` addon — which would give
handle-owned locks and kernel cleanup of dead holders — is **deliberately not
done**. It is an internal subpath plus a native module, and it would still leave
the product decision (wait forever on a live-but-wedged holder, or take over)
unmade. Revisit it when any of these becomes true: concurrent writes are actually
observed to lose updates; this package starts promising strict consistency; the
harness publishes `flock` as a supported interface; or it starts serving several
long-lived processes at once.

## Known limitations

- **Recall is lexical.** Exact token hits plus a character n-gram fallback —
  there are no embeddings. A rephrased problem may not match; `memory_search` is
  the escape hatch.
- **The n-gram fallback is loose for short records.** Jaccard over few n-grams
  reaches the 0.12 floor easily: two short, barely related texts sharing one
  bigram can score ≈ 0.2, clear the floor, and (if `minScore` is met) be
  recalled. Lower `maxRecallRecords` or raise `minScore` when this matters.
- **No persisted inverted index** — the candidate set is scored per recall from
  the in-memory domain table; the per-project id index is a rebuildable
  convenience repaired from the records table on open. Fine at hundreds of
  records; not measured at tens of thousands.
- **Precision is preferred over recall.** `minScore` (default 3) drops weak
  candidates silently; a marginal record can miss injection at score ≈ 4.
- **The audit trail is in-memory** — bounded, lost on restart.
- **A second process's in-memory view stays stale until it reopens.** The lease
  makes concurrent *writes* safe; reads still come from the table the domain
  seeded at open, so a record another process added mid-session is listed in the
  index but resolves to nothing here until this process restarts.
- **Lease release is not atomic, and that is a real risk rather than a proven
  defect.** `releaseLease` reads the lock, compares its owner token, and only then
  removes it. A takeover landing between the read and the removal would make it
  delete a *successor's* lock and admit a third writer. No probe has reproduced
  that interleaving and no test covers it, so it is recorded here as a known risk;
  closing it needs a primitive that owns an open handle (or `flock`) rather than a
  path. The same is true of the mutual exclusion itself: it holds only up to
  `leaseWaitMs` — see *Concurrent writers*.
- **Project identity is the working directory**, so one repository opened from
  two different directories (its root in one session, a subdirectory in another)
  is treated as two projects. Records do not cross that line. Anchor sessions at
  the repository root, or the memory will look empty from the other directory.
- **One working directory is one pool.** Several subsystems developed under the
  same root — say `job_agent_mvp/`, `_site/v3/`, and a plugin in a sibling
  directory you also open here — share one record set and one recall ranking;
  recall does not separate them by path or subsystem. A record's `related_files`
  carries the path, but nothing requires an overlap before a record is injected.
  This is a known boundary, not a bug: splitting the pool would change how recall
  ranks, and that needs real-sample comparison before it is designed.
- **Recording depends on the model following the contract.** The contract text
  is deliberately prescriptive: a purely permissive wording produced zero writes
  in testing.

## Compatibility

Verified against DeepSeek Harness `0.1.5-rc.2` (Node 24) on 2026-09-20. The
harness is a developer preview and says outright that it will make
compatibility-breaking changes; a green run here is evidence about this build,
not a promise about the next one. The plugin depends only on the `tools`,
`storageDomain` and `systemPrompt` services and on `dsh.bundle.patch`, which is
the narrowest surface it could use.

## License

MIT — see `LICENSE`.
