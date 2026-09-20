/**
 * Project Memory — cross-session engineering memory for coding agents.
 *
 * One host-plane Cordis plugin. It contributes four things and changes nothing
 * else in the harness:
 *
 *  1. `projectMemory` (a Cordis Service) over the shared storage-domain data
 *     form, so records live in `$DSH_HOME/storages/<domain>` beside every other
 *     durable DSH domain instead of in a parallel store.
 *  2. One dynamic runtime-context provider on `ctx.systemPrompt`. Recall runs
 *     during prompt assembly — before the model reasons about the task — so an
 *     agent cannot start from zero on a problem this project already solved.
 *  3. Model-facing tools: `memory_search`, `memory_record`, `memory_correct`,
 *     `memory_audit`.
 *  4. An audit trail of every recall and write, readable by `memory_audit`.
 *
 * Facts, hypotheses and verified conclusions are separate fields on a record,
 * because collapsing them is exactly how a guess becomes "history".
 *
 * @module dsh-project-memory
 */

import { createHash } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Plugin name used by the loader. */
const name = 'dsh-project-memory'

/** Hard dependencies: the tool registry, the domain form, and the prompt registry. */
const inject = ['tools', 'storageDomain', 'systemPrompt']

/** The domain name. Must match UNIT_NAME_RE (`/^[a-z][a-z0-9_]*$/`). */
const DOMAIN_NAME = 'dsh_project_memory'

/** Current record-format version. Bump only alongside a compatible read path. */
const RECORD_VERSION = 1

/** Prompt-context placement: just ahead of the built-in runtime contexts (sandbox = 110). */
const CONTEXT_ORDER = 105

/** Prompt section carrying the standing usage contract. */
const SECTION_ORDER = 700

/** Filesystem-path argument names the shipped fs/search tools use. */
const PATH_ARG_KEYS = ['file_path', 'path', 'notebook_path', 'pattern', 'glob']

/** Tool names whose arguments name files the agent is actually working on. */
const FILE_TOOL_NAMES = [
	'read', 'write', 'edit', 'glob', 'grep', 'present',
	'apply_patch', 'str_replace', 'create_file', 'multi_edit',
]

/** Tool names skipped when harvesting file signals (memory tools echo paths in prose only). */
const MEMORY_TOOL_PREFIX = 'memory_'

/** How long each record's problem text may be inside the recall block. */
const PROBLEM_CHARS = 160

/** How long each failed-attempt / constraint line may be. */
const LINE_CHARS = 120

/** Locale-independent code-unit compare, matching the harness convention. */
function compareNames(a, b) {
	return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Order record ids newest first, so recall's recency weighting is stable
 * wherever an id list is produced. A shared helper on purpose: two spellings of
 * this order would let a rebuilt index and a read path disagree.
 * @param ids - record ids to order.
 * @param table - the records table the ids belong to.
 * @returns a new, ordered array.
 */
function sortIdsNewestFirst(ids, table) {
	return [...ids].sort((left, right) => (table.get(right)?.created_at ?? 0) - (table.get(left)?.created_at ?? 0) || compareNames(left, right))
}

/** Collapse runs of whitespace so prose fields stay one line and bounded. */
function squeeze(text) {
	return String(text).replace(/\s+/g, ' ').trim()
}

/** Bound one prose field, marking the cut with an ellipsis. */
function clip(text, max) {
	const value = squeeze(text)
	return value.length <= max ? value : value.slice(0, Math.max(0, max - 1)) + '\u2026'
}

/** Extract one field from a value that may be text, null, undefined, or an object. */
function textOf(value) {
	if (value === null || value === undefined) return ''
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	if (typeof value === 'object') {
		if (typeof value.text === 'string') return value.text
		if (typeof value.statement === 'string') return value.statement
	}
	return ''
}

/** Extract the text of one content block. */
function blockText(block) {
	return block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''
}

/** Windows path comparison is case-insensitive; every other platform is not. */
function normalizePath(path) {
	let value = String(path).replace(/\\/g, '/')
	while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
	return process.platform === 'win32' ? value.toLowerCase() : value
}

/** A stable, readable project key: a slug of the canonical cwd plus a hash of it. */
function projectIdOf(cwd) {
	if (typeof cwd !== 'string' || cwd.length === 0) return undefined
	const normalized = normalizePath(cwd)
	const slug = normalized
		.replace(/^[a-z]:\//, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(-52)
	const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 8)
	return (slug.length > 0 ? slug + '-' : '') + hash
}

/**
 * The timestamp tag embedded in a record id, as `YYYYMMDDTHHMMSS` in UTC.
 * @param ms - epoch milliseconds.
 * @returns the sortable tag.
 */
function stampOf(ms) {
	return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

/**
 * Tokenize a string into comparable lowercase words. CJK text has no word
 * boundaries, so every CJK character is its own token (plus adjacent bigrams),
 * which is what makes Chinese symptom text match at all.
 * @param text - the text to tokenize.
 * @returns the token list.
 */
function tokenize(text) {
	const value = String(text).toLowerCase()
	const tokens = []
	for (const token of value.match(/[a-z0-9_]+/g) ?? []) {
		if (token.length >= 2) tokens.push(token)
	}
	const cjk = value.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []
	for (let index = 0; index < cjk.length; index++) {
		tokens.push(cjk[index])
		if (index + 1 < cjk.length) tokens.push(cjk[index] + cjk[index + 1])
	}
	return tokens
}

/** Tokenize a field that may hold many prose lines. */
function tokenizeAll(values) {
	return values.flatMap((value) => tokenize(textOf(value)))
}

/** Distinct tokens of one list of prose fields. */
function uniqueTokens(values) {
	return [...new Set(tokenizeAll(values))]
}

/**
 * The single searchable token set of one record. Built per recall call rather
 * than stored: records stay the one durable artifact, with no derived index to
 * drift out of date or to migrate across versions.
 * @param record - the stored record.
 * @returns the token set.
 */
function recordTokens(record) {
	return new Set(uniqueTokens([
		record.problem,
		record.root_cause,
		...record.symptoms,
		...record.facts.map((fact) => fact.statement),
		...record.hypotheses.map((hypothesis) => hypothesis.statement),
		...record.failed_attempts,
		...record.constraints,
		...record.related_files,
		...record.related_symbols,
		...record.tags,
		...record.attempts.map((attempt) => attempt.action),
	]))
}

/**
 * Character-n-gram Jaccard similarity: the dependency-free fallback for wording
 * that shares no exact token (a paraphrased symptom). Exact token hits run
 * first; this only contributes when they found nothing.
 * @param left - one token list.
 * @param right - the other token list.
 * @returns similarity in [0, 1].
 */
function similarity(left, right) {
	const grams = (tokens) => {
		const set = new Set()
		for (const token of tokens) {
			if (token.length < 2) continue
			const size = token.length > 4 ? 3 : 2
			for (let index = 0; index + size <= token.length; index++) set.add(token.slice(index, index + size))
		}
		return set
	}
	const a = grams(left)
	const b = grams(right)
	if (a.size === 0 || b.size === 0) return 0
	let shared = 0
	for (const gram of a) if (b.has(gram)) shared++
	return shared / (a.size + b.size - shared)
}

/**
 * Parse the query a recall runs with: the latest genuine user message, the
 * files recent tool calls touched, and the working directory.
 *
 * `assemble()` runs before the pending inbox batch is claimed, so the current
 * task text is read from the session log instead — the last user-role message
 * whose source is the human (`kind: 'user'`), never an injected plugin notice
 * and never a tool result.
 *
 * @param session - the live session.
 * @returns the query text plus the file and symbol signals it found.
 */
function queryFromSession(session) {
	let text = ''
	let files = []
	let symbols = []
	try {
		const messages = session.deriveMessages()
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]
			if (message.role !== 'user') continue
			if (message.source === null || message.source === undefined || message.source.kind !== 'user') continue
			text = message.content.map(blockText).filter((part) => part.length > 0).join('\n')
			if (text.trim().length > 0) break
		}
	} catch {
		text = ''
	}
	try {
		const events = session.snapshotEvents()
		for (let index = events.length - 1; index >= 0 && files.length + symbols.length < 40; index--) {
			const event = events[index]
			if (event.type !== 'tool/call') continue
			const data = event.data
			if (typeof data.name !== 'string' || data.name.startsWith(MEMORY_TOOL_PREFIX)) continue
			if (!FILE_TOOL_NAMES.includes(data.name)) continue
			let args
			try {
				args = JSON.parse(data.arguments)
			} catch {
				continue
			}
			if (args === null || typeof args !== 'object') continue
			for (const key of PATH_ARG_KEYS) {
				const value = args[key]
				if (typeof value !== 'string' || value.length === 0) continue
				if (files.includes(value)) continue
				files.push(value)
				const base = value.replace(/\\/g, '/').split('/').pop() ?? ''
				const stem = base.replace(/\.[a-z0-9]+$/i, '')
				if (stem.length >= 3 && !symbols.includes(stem)) symbols.push(stem)
			}
		}
	} catch {
		files = []
		symbols = []
	}
	const cwd = session.header !== undefined && typeof session.header.cwd === 'string' ? session.header.cwd : ''
	return {
		text,
		files: files.reverse(),
		symbols: symbols.reverse(),
		cwd,
	}
}

/** Whether one token is a single CJK character (non-discriminative on its own). */
function isSingleCjk(token) {
	return token.length === 1 && /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(token)
}

/**
 * The score one matching token contributes. A single CJK character scores a
 * fraction of a word: CJK prose is tokenized into unigrams AND bigrams, so
 * unigrams would otherwise let two unrelated Chinese sentences accumulate a
 * score out of ordinary characters alone.
 * @param token - the matched token.
 * @returns the token weight.
 */
function tokenWeight(token) {
	return isSingleCjk(token) ? 0.5 : 1
}

/**
 * Score one candidate record against the query, returning both the score and
 * human-readable reasons so the audit trail can explain every recall.
 * @param record - the candidate record.
 * @param query - the query signals.
 * @param queryTokens - the query's distinct tokens.
 * @param ageRank - 0 for the newest candidate, 1 for the oldest.
 * @returns the score plus its reasons.
 */
function scoreRecord(record, query, queryTokens, ageRank) {
	const reasons = []
	let score = 0
	const normalizedFiles = query.files.map(normalizePath)
	for (const file of record.related_files) {
		const normalized = normalizePath(file)
		const base = normalized.split('/').pop() ?? normalized
		const hit = normalizedFiles.some((candidate) => candidate === normalized
			|| candidate.endsWith('/' + normalized)
			|| (base.length > 2 && (candidate === base || candidate.endsWith('/' + base))))
		if (hit) {
			score += 5
			reasons.push('file ' + file)
		}
	}
	const loweredQuery = (query.text + ' ' + query.files.join(' ')).toLowerCase()
	for (const symbol of record.related_symbols) {
		if (String(symbol).length >= 3 && loweredQuery.includes(String(symbol).toLowerCase())) {
			score += 4
			reasons.push('symbol ' + symbol)
		}
	}
	const tagHits = record.tags.filter((tag) => queryTokens.has(String(tag).toLowerCase()))
	if (tagHits.length > 0) {
		score += 3 * tagHits.reduce((total, tag) => total + tokenWeight(String(tag).toLowerCase()), 0)
		reasons.push('tag ' + tagHits.join(','))
	}
	const problemTokens = new Set([...tokenize(record.problem), ...tokenizeAll(record.symptoms)])
	const problemHits = [...problemTokens].filter((token) => queryTokens.has(token))
	if (problemHits.length > 0) {
		score += 2 * problemHits.reduce((total, token) => total + tokenWeight(token), 0)
		reasons.push('problem terms ' + problemHits.slice(0, 6).join(','))
	}
	const riskTokens = new Set([...uniqueTokens(record.failed_attempts), ...uniqueTokens(record.constraints)])
	const riskHits = [...riskTokens].filter((token) => queryTokens.has(token))
	if (riskHits.length > 0) {
		score += 1.5 * riskHits.reduce((total, token) => total + tokenWeight(token), 0)
		reasons.push('prior failure/constraint terms ' + riskHits.slice(0, 6).join(','))
	}
	if (score === 0) {
		const ratio = similarity([...queryTokens], [...recordTokens(record)])
		if (ratio >= 0.12) {
			score = ratio * 6
			reasons.push('semantic n-gram similarity ' + ratio.toFixed(3))
		}
	}
	score *= 0.9 + 0.1 * (1 - ageRank)
	return { score, reasons }
}

/**
 * Render one recalled record for the model. The failed attempts are rendered
 * as an explicit prohibition, because "do not repeat this" is the whole point
 * of remembering a failure.
 * @param record - the record to render.
 * @param hit - its score and reasons.
 * @param index - its 1-based position in the recall block.
 * @param maxChars - the per-record character budget.
 * @returns the rendered text.
 */
function renderRecord(record, hit, index, maxChars) {
	const lines = []
	lines.push('[' + index + '] ' + record.id + '  score ' + hit.score.toFixed(1))
	lines.push('why recalled: ' + hit.reasons.join('; '))
	lines.push('status: ' + record.status + ' (' + record.conclusion + ') | recorded ' + new Date(record.created_at).toISOString().slice(0, 10))
	lines.push('problem: ' + clip(record.problem, PROBLEM_CHARS))
	if (record.root_cause.length > 0) {
		const kind = record.conclusion === 'verified' ? 'verified' : 'inferred'
		lines.push('root cause (' + kind + '): ' + clip(record.root_cause, PROBLEM_CHARS))
	}
	if (record.verification.length > 0) lines.push('verified by: ' + clip(record.verification, PROBLEM_CHARS))
	if (record.failed_attempts.length > 0) {
		lines.push('DO NOT REPEAT (already tried and failed): ' + record.failed_attempts.map((item) => clip(item, LINE_CHARS)).join('; '))
		const why = record.attempts.filter((attempt) => attempt.outcome === 'failed' && attempt.why.length > 0)
		if (why.length > 0) lines.push('  because: ' + why.map((attempt) => clip(attempt.action + ' -> ' + attempt.why, LINE_CHARS)).join('; '))
		lines.push('  -> repeating any of these requires stating what is different now and which new evidence supports the retry.')
	}
	if (record.constraints.length > 0) lines.push('constraints: ' + record.constraints.map((item) => clip(item, LINE_CHARS)).join('; '))
	if (record.related_files.length > 0) lines.push('files: ' + record.related_files.slice(0, 6).map((item) => clip(item, LINE_CHARS)).join(', '))
	let text = lines.join('\n')
	if (text.length > maxChars) text = text.slice(0, Math.max(0, maxChars - 20)) + '\n\u2026[truncated]'
	return text
}

/** The domain record schema. Every field is lossless JSON by construction. */
const memoryRecordSchema = zod.object({
	id: zod.string().min(1),
	version: zod.number().int().nonnegative(),
	project: zod.string().min(1),
	project_path: zod.string(),
	problem: zod.string(),
	symptoms: zod.array(zod.string()),
	facts: zod.array(zod.object({ statement: zod.string(), source: zod.string() })),
	hypotheses: zod.array(zod.object({ statement: zod.string(), status: zod.string() })),
	attempts: zod.array(zod.object({ action: zod.string(), outcome: zod.string(), why: zod.string() })),
	failed_attempts: zod.array(zod.string()),
	root_cause: zod.string(),
	conclusion: zod.enum(['fact', 'inferred', 'verified', 'decision']),
	changes: zod.array(zod.string()),
	verification: zod.string(),
	constraints: zod.array(zod.string()),
	related_files: zod.array(zod.string()),
	related_symbols: zod.array(zod.string()),
	tags: zod.array(zod.string()),
	status: zod.enum(['active', 'confirmed', 'superseded', 'corrected', 'invalidated']),
	superseded_by: zod.string().nullable(),
	supersedes: zod.array(zod.string()),
	revision: zod.number().int().nonnegative(),
	revised_at: zod.number().nullable(),
	created_at: zod.number(),
	session_id: zod.string(),
	cwd: zod.string(),
})

/**
 * The project-memory domain: one record per engineering conclusion
 * (`per-record` layout, so one bad document can never cost the whole store),
 * plus a rebuildable per-project id index. A record that fails its schema is
 * derived-ish data whose loss is survivable and whose corruption must not cost
 * the boot, hence `backup-and-skip`.
 */
const projectMemoryDomainSpec = defineDomain({
	name: DOMAIN_NAME,
	version: 1,
	layout: 'per-record',
	invalidRecords: 'backup-and-skip',
	tables: {
		records: domainTable(memoryRecordSchema),
		index: domainTable(zod.object({ ids: zod.array(zod.string()) })),
	},
})

/** Plugin configuration. */
const Config = z.object({
	debug: z.boolean().default(process.env.DSH_PROJECT_MEMORY_DEBUG === '1'),
	maxRecallRecords: z.natural().min(1).default(3),
	maxRecallChars: z.natural().min(200).default(2600),
	perRecordChars: z.natural().min(200).default(900),
	minScore: z.number().default(3),
	auditLimit: z.natural().min(1).default(50),
})

/** The standing usage contract, routed through every assembly. */
const USAGE_SECTION = [
	'## Project memory',
	'',
	'This project keeps durable engineering memory across sessions: problems already solved, attempts that already failed, verified root causes, and constraints that must not be broken again.',
	'',
	'- When a recalled record says a plan was already tried and failed, do NOT repeat it silently. Either avoid it, or state what is different this time and which new evidence supports the retry.',
	'- Before changing code for a bug, refactor, or feature, run `memory_search` with the affected file, symbol, error text, and symptom.',
	'- When this turn produced reusable engineering knowledge, calling `memory_record` is REQUIRED, not optional. It is required when ANY of these holds:',
	'  1. you found a root cause that can be reproduced;',
	'  2. you established WHY an attempt or approach fails;',
	'  3. you confirmed a constraint that later changes must not break;',
	'  4. you learned a project-level fact or working method that a later session can apply directly to the same kind of problem.',
	'  These are exactly the things the code does NOT already tell the next reader, so leaving them unrecorded loses the work.',
	'  Do NOT record: routine edits, formatting, temporary state, throwaway output, or anything plainly re-derivable from the code.',
	'- Do not defer recording to the end of the task. As soon as a reusable conclusion is stable and later work is unlikely to overturn it, record it immediately — a conclusion reached at step 20 must not depend on the session surviving to step 200.',
	'- If a later finding shows an existing record is wrong or outdated, use `memory_correct` (superseded / corrected / invalidated / confirmed) so the old record stops competing. Never overwrite a conclusion by writing a new conflicting record beside it.',
	'- Separate the three kinds of statement in every record: `facts` are observed evidence, `hypotheses` are inferences, `conclusion: verified` is a claim backed by a reproduction.',
	'',
	'（中文摘要）当本轮产生了可复用的工程认知时，调用 `memory_record` 是**必须**的：定位到可复现的根因、确认某个方案为什么失败、确认一条后续不能破坏的约束、或发现以后可直接复用的项目级事实/操作经验。纯例行操作、临时状态、一次性输出、能从代码直接重新得到的信息不要记录。不要等到任务结束才记：结论一旦稳定、且后续工作不太可能推翻它，就应立即记录。若后续发现原记录有误，用 `memory_correct` 标记旧记录（superseded/corrected/invalidated/confirmed），不要新写一条互相冲突的记录来覆盖。',
].join('\n')

/** The service behind `ctx.projectMemory`. */
class ProjectMemory extends Service {
	static inject = ['storageDomain', 'systemPrompt', 'tools']

	static Config = Config

	constructor(ctx, config) {
		super(ctx, 'projectMemory')
		this.config = config
	}

	table
	indexTable
	audit = []

	/** Open the domain, rebuild the id index, then install the context, section, and tools. */
	async [Service.init]() {
		const domain = await this.ctx.storageDomain.open(projectMemoryDomainSpec)
		this.ctx.effect(() => () => domain.close(), 'projectMemory.domainClose')
		this.table = domain.table('records')
		this.indexTable = domain.table('index')
		await this.rebuildIndex()
		this.ctx.systemPrompt.context({
			name: 'project-memory:recall',
			order: CONTEXT_ORDER,
			text: (context) => this.recallText(context.agent),
		})
		this.ctx.systemPrompt.section({
			name: 'project-memory:usage',
			order: SECTION_ORDER,
			text: USAGE_SECTION,
		})
		this.installTools()
	}

	/** The records table, or a fail-loud error before init assigned it. */
	requireTable() {
		if (this.table === undefined) throw new Error('project memory is not initialized')
		return this.table
	}

	/**
	 * Rebuild the per-project id index from the records table.
	 *
	 * The comparison is by IDENTITY, not by count: an index of the right length
	 * holding a wrong id is exactly as broken as a short one, and a length check
	 * would leave it in place. The index is a rebuildable convenience, so any
	 * disagreement with the records table is repaired on open.
	 * @returns the rebuilt grouping.
	 */
	async rebuildIndex() {
		const grouped = new Map()
		for (const [id, record] of this.requireTable().entries()) {
			const ids = grouped.get(record.project) ?? []
			ids.push(id)
			grouped.set(record.project, ids)
		}
		for (const [project, ids] of grouped) {
			const sorted = sortIdsNewestFirst(ids, this.requireTable())
			const stored = this.indexTable.get(project)?.ids
			const matches = stored !== undefined
				&& stored.length === sorted.length
				&& stored.every((id, position) => id === sorted[position])
			if (!matches) await this.indexTable.put(project, { ids: sorted })
		}
		return grouped
	}

	/**
	 * Every record id of one project, newest first, from the durable index table.
	 *
	 * The order is re-derived here rather than trusted from the stored array:
	 * recall's recency weighting depends on it, and the index is a rebuildable
	 * convenience, not an authority.
	 * @param project - the project key.
	 * @returns the record ids, newest first.
	 */
	idsForProject(project) {
		const entry = this.indexTable.get(project)
		if (entry === undefined) return []
		return sortIdsNewestFirst([...entry.ids], this.requireTable())
	}

	/**
	 * One stored record.
	 * @param recordId - the record id.
	 * @returns the record, or undefined.
	 */
	get(recordId) {
		return this.requireTable().get(recordId)
	}

	/**
	 * All records of one project, newest first — the explicit-search entry point.
	 * @param project - the project key.
	 * @returns the records.
	 */
	allForProject(project) {
		const table = this.requireTable()
		return this.idsForProject(project).map((id) => table.get(id)).filter((record) => record !== undefined)
	}

	/**
	 * Recall the records that matter for the project currently being worked on.
	 * @param session - the live session (its header supplies the project).
	 * @param options - `persist: true` widens the result set, for explicit search.
	 * @returns the query, the scored hits, and the candidate count — the audit facts.
	 */
	recall(session, options = {}) {
		const project = projectIdOf(session.header?.cwd)
		const query = queryFromSession(session)
		const result = {
			project,
			query: {
				text: clip(query.text, 400),
				files: query.files.slice(0, 12),
				tokens: 0,
			},
			reasons: [],
			records: [],
			considered: 0,
			error: undefined,
		}
		if (project === undefined) {
			result.error = 'the session header carries no cwd, so no project can be identified'
			return result
		}
		let candidates
		try {
			candidates = this.allForProject(project)
		} catch (error) {
			result.error = String(error?.message ?? error)
			return result
		}
		const queryTokens = new Set(tokenize(query.text + ' ' + query.files.join(' ') + ' ' + query.symbols.join(' ')))
		result.query.tokens = queryTokens.size
		// Several conclusions about one problem: only the newest live one carries weight.
		const replaced = new Set(candidates.flatMap((record) => record.supersedes))
		const live = candidates.filter((record) => record.status !== 'superseded' && record.status !== 'invalidated' && !replaced.has(record.id))
		result.considered = live.length
		const limit = options.persist === true ? Math.max(this.config.maxRecallRecords, 8) : this.config.maxRecallRecords
		// Score everything, but keep only the best few: a per-step recall must not
		// allocate a sorted array proportional to a project's whole history.
		const best = []
		for (let position = 0; position < live.length; position++) {
			const hit = scoreRecord(live[position], query, queryTokens, live.length <= 1 ? 0 : position / (live.length - 1))
			if (hit.score < this.config.minScore) continue
			best.push({ record: live[position], hit })
			best.sort((left, right) => right.hit.score - left.hit.score || compareNames(left.record.id, right.record.id))
			if (best.length > limit) best.pop()
		}
		result.records = best
		result.reasons = best.map((entry) => entry.record.id + ' <- ' + entry.hit.reasons.join('; '))
		if (best.length === 0 && live.length > 0) {
			result.reasons = ['no candidate reached the score threshold ' + this.config.minScore + ' (' + live.length + ' live record(s) considered)']
		}
		return result
	}

	/**
	 * The text of the dynamic runtime context for one assembly. Returns an empty
	 * string when nothing is relevant, so no empty recall block is injected
	 * (`context()` text must be a string; an empty one renders to nothing and
	 * drops out of the snapshot entirely).
	 * @param agent - the agent whose prompt is being assembled, when any.
	 * @returns the recall text, or `''` when there is nothing to recall.
	 */
	recallText(agent) {
		if (agent === undefined || agent === null || agent.session === undefined || agent.session === null) return ''
		let result
		try {
			result = this.recall(agent.session)
		} catch (error) {
			this.ctx.logger.warn('project memory: recall failed (context omitted): ' + String(error))
			return ''
		}
		if (result.error !== undefined) {
			this.recallHook('recall-skipped', { session_id: agent.session.id, problem: result.error })
			return ''
		}
		if (result.records.length === 0) {
			this.recallHook('recall-empty', {
				session_id: agent.session.id,
				project: result.project,
				query: result.query,
				considered: result.considered,
				reasons: result.reasons,
			})
			return ''
		}
		const blocks = result.records.map((entry, index) => renderRecord(entry.record, entry.hit, index + 1, this.config.perRecordChars))
		let text = 'Project Memory (project: ' + result.project + ') — ' + blocks.length + ' of ' + result.considered + ' relevant record(s) recalled for this task.'
		for (const block of blocks) text += '\n\n' + block
		if (text.length > this.config.maxRecallChars) text = text.slice(0, this.config.maxRecallChars) + '\n\u2026[recall truncated]'
		this.recallHook('recall-injected', {
			session_id: agent.session.id,
			project: result.project,
			query: result.query,
			considered: result.considered,
			records: result.records.map((item) => item.record.id),
			reasons: result.reasons,
			injected_chars: text.length,
		})
		return text
	}

	/**
	 * Record one audit entry, keeping the newest `auditLimit`. This is the
	 * transparency surface: what was queried, what matched, why, and what was
	 * injected.
	 * @param action - the audit action name.
	 * @param fields - the auditable facts.
	 */
	recallHook(action, fields) {
		const entry = { time: Date.now(), action, ...fields }
		this.audit.push(entry)
		if (this.audit.length > this.config.auditLimit) this.audit.splice(0, this.audit.length - this.config.auditLimit)
		if (this.config.debug) this.ctx.logger.info('project memory: ' + action + ' ' + JSON.stringify(entry))
	}

	/**
	 * Persist one new record and index it.
	 * @param input - the record fields.
	 * @param origin - the owning session and working directory.
	 * @returns the stored record.
	 */
	async put(input, origin) {
		const table = this.requireTable()
		const digest = createHash('sha256').update(JSON.stringify(input) + (origin.session_id ?? '') + String(Date.now())).digest('hex').slice(0, 6)
		const id = 'mem-' + stampOf(Date.now()) + '-' + digest
		const record = {
			id,
			version: RECORD_VERSION,
			project: input.project,
			project_path: input.project_path,
			problem: input.problem,
			symptoms: input.symptoms,
			facts: input.facts,
			hypotheses: input.hypotheses,
			attempts: input.attempts,
			failed_attempts: input.failed_attempts,
			root_cause: input.root_cause,
			conclusion: input.conclusion,
			changes: input.changes,
			verification: input.verification,
			constraints: input.constraints,
			related_files: input.related_files,
			related_symbols: input.related_symbols,
			tags: input.tags,
			status: 'active',
			superseded_by: null,
			supersedes: input.supersedes ?? [],
			revision: 1,
			revised_at: null,
			created_at: Date.now(),
			session_id: origin.session_id ?? '',
			cwd: origin.cwd ?? '',
		}
		await table.put(id, record)
		await this.reindex(record.project)
		return record
	}

	/**
	 * Mark one existing record as replaced by a newer conclusion.
	 * @param recordId - the record being revised.
	 * @param status - the revision status.
	 * @param supersededBy - the id of the record that replaces it, when any.
	 * @returns the updated record.
	 */
	async markRevised(recordId, status, supersededBy) {
		const table = this.requireTable()
		if (table.get(recordId) === undefined) throw new Error('no project memory record "' + recordId + '"')
		const updated = await table.update(recordId, (current) => ({
			...current,
			status,
			superseded_by: supersededBy ?? current.superseded_by,
			revision: current.revision + 1,
			revised_at: Date.now(),
		}))
		await this.reindex(updated.project)
		return updated
	}

	/**
	 * Rewrite one project's id index to match the table, newest first.
	 * @param project - the project key.
	 */
	async reindex(project) {
		const table = this.requireTable()
		const ids = []
		for (const [id, record] of table.entries()) if (record.project === project) ids.push(id)
		ids.sort((left, right) => (table.get(right)?.created_at ?? 0) - (table.get(left)?.created_at ?? 0) || compareNames(left, right))
		await this.indexTable.put(project, { ids })
	}

	/** Register the four model-facing tools. */
	installTools() {
		installSearchTool(this)
		installRecordTool(this)
		installCorrectTool(this)
		installAuditTool(this)
	}

	/** The owning session of one tool execution, or a fail-loud error. */
	sessionOf(exec) {
		const session = exec.agent?.session
		if (session === undefined || session === null) throw new Error('this tool requires an owning agent session')
		return session
	}

	/** Normalize a model-supplied string list into trimmed, non-empty, bounded strings. */
	stringList(value) {
		if (!Array.isArray(value)) return []
		const out = []
		for (const item of value) {
			const text = squeeze(textOf(item))
			if (text.length > 0) out.push(text.slice(0, 500))
		}
		return out
	}

	/** Normalize a model-supplied object list, keeping only the declared fields. */
	objectList(value, keys) {
		if (!Array.isArray(value)) return []
		const out = []
		for (const item of value) {
			if (item === null || typeof item !== 'object') continue
			const entry = {}
			let empty = true
			for (const key of keys) {
				const text = squeeze(textOf(item[key]))
				entry[key] = text.slice(0, 500)
				if (text.length > 0) empty = false
			}
			if (!empty) out.push(entry)
		}
		return out
	}

	/** The model-facing projection of one record. */
	projectRecord(record, hit) {
		return {
			summary: renderRecord(record, hit, 1, 2000).replace(/^\[1\] /, ''),
			id: record.id,
			problem: record.problem,
			status: record.status,
			conclusion: record.conclusion,
			root_cause: record.root_cause,
			symptoms: record.symptoms,
			facts: record.facts,
			hypotheses: record.hypotheses,
			failed_attempts: record.failed_attempts,
			constraints: record.constraints,
			verification: record.verification,
			related_files: record.related_files,
			related_symbols: record.related_symbols,
			tags: record.tags,
			created_at: record.created_at,
			revision: record.revision,
			superseded_by: record.superseded_by,
		}
	}
}

/** Register `memory_search`. */
function installSearchTool(service) {
	service.ctx.tools.register(defineTool({
		name: 'memory_search',
		description: [
			'Search this project\'s durable engineering memory: problems already solved, attempts already tried and failed, verified root causes, and constraints that must not be broken again.',
			'Call it before changing code for a bug, refactor, or feature — and whenever you are about to retry a plan, in case it already failed here.',
			'Results are project-scoped: another project\'s memory is never returned.',
		].join(' '),
		parameters: {
			query: {
				type: 'string',
				description: 'What to look up: file path, symbol, error text, symptom, or feature name. Empty lists every record of this project.',
			},
			limit: { type: 'integer', description: 'Maximum records to return (default 8).' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					project: { type: 'string', required: true },
					count: { type: 'integer', required: true },
					records: { type: 'array', required: true, items: { type: 'json' } },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.count === 0
					? 'No project memory matched in project ' + value.project + '.'
					: 'Project memory: ' + value.count + ' record(s) in project ' + value.project + '.\n\n' + value.records.map((record) => record.summary).join('\n\n'),
			}],
		},
		async execute(args, exec) {
			const session = service.sessionOf(exec)
			const project = projectIdOf(session.header?.cwd)
			if (project === undefined) throw new Error('memory_search requires a session whose header carries a cwd')
			const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 50) : 8
			const needle = squeeze(args.query ?? '')
			const queryTokens = new Set(tokenize(needle))
			const records = service.allForProject(project)
			const query = { text: needle, files: [], symbols: [], cwd: session.header?.cwd ?? '' }
			const scored = records
				.map((record, position) => ({
					record,
					hit: needle.length === 0
						? { score: 0, reasons: ['whole-project listing (no query given)'] }
						: scoreRecord(record, query, queryTokens, records.length <= 1 ? 0 : position / (records.length - 1)),
				}))
				.filter((entry) => needle.length === 0 || entry.hit.score > 0)
				.sort((left, right) => right.hit.score - left.hit.score || (right.record.created_at - left.record.created_at))
				.slice(0, limit)
			service.recallHook('explicit-search', {
				session_id: session.id,
				project,
				query: { text: clip(needle, 400), files: [], tokens: queryTokens.size },
				considered: records.length,
				records: scored.map((entry) => entry.record.id),
				reasons: scored.map((entry) => entry.record.id + ' <- ' + entry.hit.reasons.join('; ')),
			})
			return {
				project,
				count: scored.length,
				records: scored.map((entry) => service.projectRecord(entry.record, entry.hit)),
			}
		},
		presentCall: (args) => ({ card: 'generic', title: 'Search project memory', kind: 'other', rawInput: args }),
	}))
}

/** Register `memory_record`. */
function installRecordTool(service) {
	service.ctx.tools.register(defineTool({
		name: 'memory_record',
		description: [
			'Record one reusable engineering conclusion into this project\'s durable memory, so a later session does not start from zero.',
			'Call this when the turn produced reusable engineering knowledge — that is a REQUIREMENT, not a nicety. It applies when any of these holds: you found a reproducible root cause; you established why an attempt fails; you confirmed a constraint later changes must not break; or you learned a project-level fact or working method a later session could apply directly.',
			'Do not defer it to the end of the task: record as soon as the conclusion is stable and later work is unlikely to overturn it.',
			'SKIP only genuinely non-reusable things: routine edits, formatting, temporary state, throwaway output, or anything plainly re-derivable from the code. Recording those destroys this memory\'s value.',
			'If a new finding contradicts an existing record, use `memory_correct` instead of writing a second conflicting record.',
			'Keep the three kinds of statement apart: `facts` are observed evidence, `hypotheses` are inferences you held, `conclusion: verified` requires a reproduction in `verification`.',
		].join(' '),
		parameters: {
			problem: { type: 'string', required: true, description: 'The problem, in one sentence.' },
			conclusion: {
				type: 'string',
				required: true,
				enum: ['verified', 'fact', 'inferred', 'decision'],
				description: 'What kind of conclusion this is. `verified` requires `verification`.',
			},
			symptoms: { type: 'array', items: { type: 'string' }, description: 'What was observed: error text, failing command, wrong output.' },
			facts: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						statement: { type: 'string', required: true },
						source: { type: 'string', description: 'How this was observed (command, file, measurement).' },
					},
				},
				description: 'Observed evidence only — never an inference.',
			},
			hypotheses: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						statement: { type: 'string', required: true },
						status: { type: 'string', enum: ['open', 'rejected', 'confirmed'] },
					},
				},
				description: 'Inferences you held, and whether they survived.',
			},
			attempts: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						action: { type: 'string', required: true },
						outcome: { type: 'string', enum: ['failed', 'partial', 'succeeded'] },
						why: { type: 'string' },
					},
				},
				description: 'Every approach tried, successful or not.',
			},
			failed_attempts: { type: 'array', items: { type: 'string' }, description: 'The approaches that FAILED, so a later session will not repeat them blindly.' },
			root_cause: { type: 'string', description: 'The actual cause, as narrowly as the evidence allows. Empty when unknown.' },
			changes: { type: 'array', items: { type: 'string' }, description: 'What was changed in the end.' },
			verification: { type: 'string', description: 'The reproduction that proved the fix.' },
			constraints: { type: 'array', items: { type: 'string' }, description: 'Rules a later session must respect.' },
			related_files: { type: 'array', items: { type: 'string' }, description: 'Files this touches — the strongest future recall signal.' },
			related_symbols: { type: 'array', items: { type: 'string' }, description: 'Functions, classes, or modules involved.' },
			tags: { type: 'array', items: { type: 'string' }, description: 'Short feature/subsystem tags.' },
			supersedes: { type: 'array', items: { type: 'string' }, description: 'Record ids this conclusion replaces. Prefer memory_correct, which also marks the old record.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					record_id: { type: 'string', required: true },
					project: { type: 'string', required: true },
					status: { type: 'string', required: true },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: 'Project memory updated: ' + value.record_id + ' (' + value.status + ') in project ' + value.project + '.',
			}],
		},
		async execute(args, exec) {
			const session = service.sessionOf(exec)
			const cwd = session.header?.cwd
			const project = projectIdOf(cwd)
			if (project === undefined) throw new Error('memory_record requires a session whose header carries a cwd')
			if (args.conclusion === 'verified' && squeeze(args.verification ?? '').length === 0) {
				throw new Error('memory_record: conclusion "verified" requires a non-empty `verification` reproduction; use "inferred" when the fix is not yet reproduced')
			}
			const record = await service.put({
				project,
				project_path: cwd,
				problem: squeeze(args.problem).slice(0, 400),
				symptoms: service.stringList(args.symptoms).slice(0, 20),
				facts: service.objectList(args.facts, ['statement', 'source']).slice(0, 30),
				hypotheses: service.objectList(args.hypotheses, ['statement', 'status']).slice(0, 20),
				attempts: service.objectList(args.attempts, ['action', 'outcome', 'why']).slice(0, 30),
				failed_attempts: service.stringList(args.failed_attempts).slice(0, 20),
				root_cause: squeeze(args.root_cause ?? '').slice(0, 600),
				conclusion: args.conclusion,
				changes: service.stringList(args.changes).slice(0, 20),
				verification: squeeze(args.verification ?? '').slice(0, 600),
				constraints: service.stringList(args.constraints).slice(0, 20),
				related_files: service.stringList(args.related_files).slice(0, 40),
				related_symbols: service.stringList(args.related_symbols).slice(0, 40),
				tags: service.stringList(args.tags).slice(0, 20),
				supersedes: service.stringList(args.supersedes),
			}, { session_id: session.id, cwd })
			service.recallHook('record-created', {
				record_id: record.id,
				project,
				problem: record.problem,
				conclusion: record.conclusion,
				failed_attempts: record.failed_attempts.length,
				related_files: record.related_files,
			})
			return { record_id: record.id, project, status: record.status }
		},
		presentCall: (args) => ({ card: 'generic', title: 'Record project memory', kind: 'other', rawInput: args }),
	}))
}

/** Register `memory_correct`. */
function installCorrectTool(service) {
	service.ctx.tools.register(defineTool({
		name: 'memory_correct',
		description: [
			'Revise an existing project-memory record when new evidence changes what is true.',
			'Use it instead of silently recording a contradicting conclusion: the old record is marked `superseded`, `corrected`, `invalidated`, or `confirmed`, so two incompatible conclusions never carry equal weight in a later session.',
			'Supply `new_problem` to write the replacement record, linked in both directions — it is REQUIRED for "superseded" and "corrected", because those statuses mean the conclusion is being replaced. Omit it only for "invalidated" (rejected outright) or "confirmed" (still holds).',
		].join(' '),
		parameters: {
			record_id: { type: 'string', required: true, description: 'The record being revised.' },
			status: {
				type: 'string',
				required: true,
				enum: ['superseded', 'corrected', 'invalidated', 'confirmed'],
				description: 'How the old conclusion now stands.',
			},
			reason: { type: 'string', required: true, description: 'The evidence that changed the conclusion.' },
			new_problem: { type: 'string', description: 'Problem text of the replacement record. Required for "superseded" and "corrected"; omit only for "invalidated" or "confirmed".' },
			new_root_cause: { type: 'string', description: 'The replacement conclusion.' },
			new_verification: { type: 'string', description: 'The reproduction that backs the replacement.' },
			new_facts: { type: 'array', items: { type: 'string' }, description: 'Newly observed evidence statements.' },
			new_failed_attempts: { type: 'array', items: { type: 'string' }, description: 'Newly known failed approaches.' },
			new_constraints: { type: 'array', items: { type: 'string' }, description: 'Newly known constraints.' },
			related_files: { type: 'array', items: { type: 'string' }, description: 'Files involved, for the replacement record.' },
			related_symbols: { type: 'array', items: { type: 'string' }, description: 'Symbols involved, for the replacement record.' },
			tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the replacement record.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					revised_id: { type: 'string', required: true },
					revised_status: { type: 'string', required: true },
					replacement_id: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.replacement_id === undefined
					? 'Project memory ' + value.revised_id + ' marked ' + value.revised_status + '.'
					: 'Project memory ' + value.revised_id + ' marked ' + value.revised_status + ', replaced by ' + value.replacement_id + '.',
			}],
		},
		async execute(args, exec) {
			const session = service.sessionOf(exec)
			const cwd = session.header?.cwd
			const project = projectIdOf(cwd)
			const existing = service.get(args.record_id)
			if (existing === undefined) throw new Error('memory_correct: no record "' + args.record_id + '"')
			const replacementProblem = squeeze(args.new_problem ?? '')
			// A conclusion is only "corrected" or "superseded" IN FAVOUR of a
			// replacement record. Without one, the old text would stay the only
			// account while recall's filter let a "corrected" record through, so
			// the correction would never reach a later session.
			if ((args.status === 'superseded' || args.status === 'corrected') && replacementProblem.length === 0) {
				throw new Error('memory_correct: status "' + args.status + '" requires a replacement — supply new_problem (with new_root_cause, and new_verification to record it as verified). Use "invalidated" to reject a conclusion outright, or "confirmed" to affirm it.')
			}
			if (project !== undefined && existing.project !== project) {
				throw new Error('memory_correct: record "' + args.record_id + '" belongs to another project (' + existing.project + ')')
			}
			let replacement
			if (replacementProblem.length > 0) {
				const relatedFiles = service.stringList(args.related_files)
				const relatedSymbols = service.stringList(args.related_symbols)
				const tags = service.stringList(args.tags)
				replacement = await service.put({
					project: existing.project,
					project_path: existing.project_path,
					problem: replacementProblem.slice(0, 400),
					symptoms: existing.symptoms,
					facts: service.stringList(args.new_facts).map((statement) => ({ statement, source: clip(args.reason, 200) })),
					hypotheses: [],
					attempts: [],
					failed_attempts: service.stringList(args.new_failed_attempts),
					root_cause: squeeze(args.new_root_cause ?? '').slice(0, 600),
					conclusion: squeeze(args.new_verification ?? '').length > 0 ? 'verified' : 'inferred',
					changes: [],
					verification: squeeze(args.new_verification ?? '').slice(0, 600),
					constraints: service.stringList(args.new_constraints),
					related_files: relatedFiles.length > 0 ? relatedFiles : existing.related_files,
					related_symbols: relatedSymbols.length > 0 ? relatedSymbols : existing.related_symbols,
					tags: tags.length > 0 ? tags : existing.tags,
					supersedes: [existing.id],
				}, { session_id: session.id, cwd })
			}
			const revised = await service.markRevised(existing.id, args.status, replacement?.id)
			service.recallHook('record-revised', {
				record_id: revised.id,
				status: revised.status,
				replacement_id: replacement?.id,
				reason: clip(args.reason, 300),
			})
			return {
				revised_id: revised.id,
				revised_status: revised.status,
				...(replacement === undefined ? {} : { replacement_id: replacement.id }),
			}
		},
		presentCall: (args) => ({ card: 'generic', title: 'Revise project memory', kind: 'other', rawInput: args }),
	}))
}

/** Register `memory_audit`. */
function installAuditTool(service) {
	service.ctx.tools.register(defineTool({
		name: 'memory_audit',
		description: [
			'Read this process\'s project-memory audit trail: every recall (which records were injected, why each was considered relevant, and how many candidates lost), every write, and every revision.',
			'Use it to check what history an earlier step actually saw, or to explain why something was or was not recalled.',
		].join(' '),
		parameters: {
			limit: { type: 'integer', description: 'Maximum entries, newest last (default 20).' },
			action: { type: 'string', description: 'Only entries with this action (recall-injected, recall-empty, recall-skipped, explicit-search, record-created, record-revised).' },
			project: { type: 'string', description: 'Only entries for one project id.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					count: { type: 'integer', required: true },
					entries: { type: 'array', required: true, items: { type: 'json' } },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.count === 0 ? 'No project-memory audit entries.' : JSON.stringify(value.entries, null, 2),
			}],
		},
		async execute(args) {
			const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 20
			const filtered = service.audit.filter((entry) => {
				if (typeof args.action === 'string' && args.action.length > 0 && entry.action !== args.action) return false
				if (typeof args.project === 'string' && args.project.length > 0 && entry.project !== args.project) return false
				return true
			})
			return { count: Math.min(filtered.length, limit), entries: filtered.slice(-limit) }
		},
	}))
}

/**
 * Mount project memory for the whole process.
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 */
function apply(ctx, config) {
	ctx.plugin(ProjectMemory, config)
}

export { Config, DOMAIN_NAME, ProjectMemory, USAGE_SECTION, apply, inject, name, projectIdOf, projectMemoryDomainSpec }
