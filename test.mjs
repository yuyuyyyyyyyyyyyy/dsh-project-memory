/**
 * Behaviour tests for dsh-project-memory.
 *
 * The plugin is mounted through a REAL Cordis Loader over a real composition
 * file, with the real storage hub, the real domain facility, the real tool
 * registry, and the real system-prompt registry. Only the storage MEDIUM is
 * faked (`memory-backend.mjs`), so nothing here touches `$DSH_HOME`.
 *
 * Fixtures are neutral placeholders: these tests assert behaviour, not a story.
 *
 * Run from this directory:
 *   DSH_PLUGIN_DEPS=<path to $DSH_HOME/profiles/node_modules> \
 *     node --import ./register-deps.mjs test.mjs
 */

import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryGroup } from '@deepseek-ai/cordis-plugin-loader'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import { medium } from './memory-backend.mjs'

const PLUGIN = new URL('./index.js', import.meta.url).href
/** Bare `@deepseek-ai/*` names in this composition resolve from the installed harness. */
const DEFAULT_HOME = (process.env.USERPROFILE ?? process.env.HOME ?? '.') + '/.dsh'
const HARNESS_BASE = pathToFileURL((process.env.DSH_HOME ?? DEFAULT_HOME) + '/profiles/node_modules/').href

let failures = 0
let checks = 0

/** Assert one condition, reporting and counting. */
function check(name, condition, detail = '') {
	checks++
	if (condition) {
		console.log('  PASS  ' + name)
		return true
	}
	failures++
	console.log('  FAIL  ' + name + (detail ? '  -- ' + detail : ''))
	return false
}

/** A synthetic session: exactly the surface the plugin reads. */
function fakeSession(id, cwd, messages, toolCalls = []) {
	return {
		id,
		header: { cwd, createdAt: Date.now(), version: 3 },
		deriveMessages() {
			return messages.map((text) => ({
				role: 'user',
				source: { kind: 'user' },
				content: [{ type: 'text', text }],
			}))
		},
		snapshotEvents() {
			return toolCalls.map((call) => ({ type: 'tool/call', data: { name: call.name, arguments: JSON.stringify(call.args) } }))
		},
	}
}

/** A synthetic agent: prompt assembly reads `context.agent.session` only. */
function fakeAgent(session) {
	return { id: session.id, session }
}

/** Render one composition value as YAML, quoting strings so a path stays a path. */
function yamlValue(value) {
	return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

/** Write one composition file naming these rows, in order. */
function composition(rows) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-comp-'))
	const file = join(dir, 'cordis.yml')
	const lines = []
	for (const row of rows) {
		lines.push('- id: ' + row.id)
		lines.push('  name: ' + JSON.stringify(row.name))
		if (row.config !== undefined) {
			lines.push('  config:')
			for (const [key, value] of Object.entries(row.config)) lines.push('    ' + key + ': ' + yamlValue(value))
		}
	}
	writeFileSync(file, lines.concat('').join('\n'))
	return file
}

/**
 * Mount the real registries plus the plugin under test.
 *
 * The storage hub resolves bare names from the installed harness; the backend
 * is mounted on the root context exactly as the base bundle does, so the domain
 * facility always finds its backend lifecycle key.
 */
async function boot(pluginConfig = {}) {
	const root = new Context()
	const loader = new Loader(root)
	await root.plugin((ctx) => {
		ctx.provide('logger', {
			info() {},
			warn(...args) {
				console.warn('[warn]', ...args)
			},
			error(...args) {
				console.error('[error]', ...args)
			},
			debug() {},
		})
	})
	await root.plugin((await import('@deepseek-ai/dsh-storage')).default)
	await root.plugin(await import('./memory-backend.mjs'))
	loader.builtins.group = EntryGroup
	loader.builtins.include = class HostResolvedRootInclude extends Include {
		import(name, getOuterStack) {
			if (name.startsWith('.') || name.startsWith('cordis:')) return super.import(name, getOuterStack)
			const internal = this.ctx.loader.internal
			if (internal === undefined) return super.import(name, getOuterStack)
			return internal.import(name, HARNESS_BASE, {})
		}
	}
	const file = composition([
		{ id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'memory' } },
		{ id: 'tools', name: '@deepseek-ai/dsh-tools' },
		{ id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
		{ id: 'project-memory', name: PLUGIN, config: Object.keys(pluginConfig).length > 0 ? pluginConfig : undefined },
	])
	await loader.create({ id: 'root', name: 'cordis:include', config: { path: pathToFileURL(file).href } })
	await loader.await()
	return { root, loader }
}

/**
 * A class plugin's `[Service.init]` is a detached promise: the Loader's
 * `await()` settles when the tree's import and activation tasks settle, which
 * can precede an async init hook by a few milliseconds. A real session start is
 * far slower than that gap, so only a test observes it.
 * @param read - reads the service (or undefined).
 * @param timeoutMs - how long to wait.
 * @returns the service, or undefined on timeout.
 */
async function waitFor(read, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const value = read()
		if (value !== undefined) return value
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
	return read()
}

/** Resolve one registered tool definition. */
function tool(root, name) {
	const definition = root.get('tools').get(name)
	assert.ok(definition, 'tool ' + name + ' is not registered')
	return definition
}

/** Every fiber's state, for a mount failure that would otherwise be silent. */
function diagnostics(root) {
	const lines = []
	for (const [callback, runtime] of root.registry.entries()) {
		lines.push('  ' + (runtime.name ?? callback.name ?? '(anonymous)') + '  [' + [...(runtime.fibers ?? [])].map((fiber) => fiber.uid + (fiber.error === undefined ? ':ok' : ':ERR ' + fiber.error)).join(', ') + ']')
	}
	return lines.join('\n')
}

const PROJECT_A = 'C:\\work\\project-a'
const PROJECT_B = 'C:\\work\\project-b'

async function main() {
	console.log('project-memory behaviour tests\n')

	const { root, loader } = await boot()
	const memory = await waitFor(() => root.get('projectMemory'))
	check('M1 the plugin mounts through a real Loader composition', memory !== undefined, diagnostics(root))
	if (memory === undefined) {
		console.log(diagnostics(root))
		process.exit(1)
	}
	const systemPrompt = root.get('systemPrompt')
	const tools = root.get('tools')
	check('M2 all four tools registered into the host registry', ['memory_search', 'memory_record', 'memory_correct', 'memory_audit'].every((name) => tools.get(name) !== undefined))

	const subject = 'SYM-1 的故障复现了'
	const sessionA1 = fakeSession('session-a1', PROJECT_A, ['SYM-1 的故障复现了'])
	const sessionA2 = fakeSession('session-a2', PROJECT_A, ['SYM-1 的故障又出现了'])
	const sessionA3 = fakeSession('session-a3', PROJECT_A, ['completely different topic'])
	const sessionB1 = fakeSession('session-b1', PROJECT_B, ['SYM-1 的故障又出现了'])

	// ── A. first encounter, no history ─────────────────────────────────────────
	console.log('\nA. first encounter with no history at all')
	const empty = memory.recall(sessionA1)
	check('A1 a fresh project has zero live records', empty.considered === 0 && empty.records.length === 0, JSON.stringify(empty.records.length))
	check('A2 the session is bound to a project key', typeof empty.project === 'string' && empty.project.length > 0)
	check('A3 no recall text is produced (nothing is injected)', memory.recallText(fakeAgent(sessionA1)) === '')
	{
		const agent = fakeAgent(sessionA1)
		const assembly = await systemPrompt.assemble({ agent, scope: agent })
		check('A4 every assembled context carries text (no undefined contribution)', assembly.contexts.every((entry) => typeof entry.text === 'string'), JSON.stringify(assembly.contexts.map((entry) => typeof entry.text)))
		check('A5 no empty recall context reaches the prompt', assembly.contexts.every((entry) => !entry.text.includes('Project Memory')))
		check('A6 the usage section is present in the system prompt', assembly.sections.some((section) => section.name === 'project-memory:usage'))
		check('A7 the usage section routes recording through memory_record', (assembly.sections.find((section) => section.name === 'project-memory:usage') ?? {}).text?.includes('memory_record'))
		check('A8 the usage section routes revision through memory_correct', (assembly.sections.find((section) => section.name === 'project-memory:usage') ?? {}).text?.includes('memory_correct'))
	}

	// ── B. write ───────────────────────────────────────────────────────────────
	console.log('\nB. recording one conclusion')
	const failedAttempts = ['FAILED-1 已试过并失败的方案', 'FAILED-2 已试过并失败的方案']
	const created = await tool(root, 'memory_record').execute({
		problem: subject,
		conclusion: 'verified',
		symptoms: ['SYMPTOM-1', 'SYMPTOM-2'],
		facts: [
			{ statement: 'FACT-1 已确认的事实', source: 'SOURCE-1' },
			{ statement: 'FACT-2 已确认的事实', source: 'SOURCE-2' },
		],
		hypotheses: [{ statement: 'HYPOTHESIS-1', status: 'rejected' }],
		attempts: [
			{ action: 'FAILED-1 已试过并失败的方案', outcome: 'failed', why: 'REASON-1 失败原因' },
			{ action: 'FAILED-2 已试过并失败的方案', outcome: 'failed', why: 'REASON-2 失败原因' },
			{ action: 'FIX-1 有效方案', outcome: 'succeeded', why: 'REASON-3 有效原因' },
		],
		failed_attempts: failedAttempts,
		root_cause: 'ROOT-CAUSE-1',
		changes: ['CHANGE-1'],
		verification: 'VERIFICATION-1 复现方式',
		constraints: ['CONSTRAINT-1 后续不能破坏的约束'],
		related_files: ['src/module/file.js'],
		related_symbols: ['symbolName'],
		tags: ['tag-one', 'tag-two'],
	}, { agent: fakeAgent(sessionA1) })
	check('B1 a record id is returned', typeof created.record_id === 'string' && created.record_id.startsWith('mem-'), JSON.stringify(created.record_id))
	check('B2 the record is bound to this project', created.project === empty.project)
	check('B3 the stored record is JSON-lossless', (() => {
		try {
			JSON.parse(JSON.stringify(memory.get(created.record_id)))
			return true
		} catch {
			return false
		}
	})())
	check('B4 facts, hypotheses and the verified conclusion stay separate', (() => {
		const stored = memory.get(created.record_id)
		return stored.facts.length === 2
			&& stored.hypotheses.length === 1
			&& stored.hypotheses[0].status === 'rejected'
			&& stored.conclusion === 'verified'
			&& stored.root_cause === 'ROOT-CAUSE-1'
	})())
	check('B5 failed attempts are stored as a first-class field', memory.get(created.record_id).failed_attempts.length === 2)
	check('B6 a claim of "verified" without a reproduction is rejected', await (async () => {
		try {
			await tool(root, 'memory_record').execute({ problem: 'X', conclusion: 'verified' }, { agent: fakeAgent(sessionA1) })
			return false
		} catch (error) {
			return String(error.message).includes('requires a non-empty `verification`')
		}
	})())
	check('B7 a tool without an agent session fails loud', await (async () => {
		try {
			await tool(root, 'memory_search').execute({ query: 'X' }, {})
			return false
		} catch (error) {
			return String(error.message).includes('owning agent session')
		}
	})())

	// ── C. a NEW session recalls it ────────────────────────────────────────────
	console.log('\nC. a new session on the same project recalls it')
	const recalled = memory.recall(sessionA2)
	check('C1 the record is recalled', recalled.records.length === 1, JSON.stringify(recalled.records.map((entry) => entry.record.id)))
	check('C2 it is the record written in B', recalled.records[0] !== undefined && recalled.records[0].record.id === created.record_id)
	check('C3 the recall explains why it matched', recalled.reasons.join(' ').length > 0, JSON.stringify(recalled.reasons))
	{
		const agent = fakeAgent(sessionA2)
		const text = memory.recallText(agent)
		check('C4 a recall context is produced', typeof text === 'string' && text.includes('Project Memory'))
		check('C5 the injected text names both failed approaches', text.includes('FAILED-1') && text.includes('FAILED-2'))
		check('C6 the injected text carries the prohibition', text.includes('DO NOT REPEAT'))
		check('C7 the injected text carries the constraint', text.includes('CONSTRAINT-1'))
		check('C8 the injected text carries the verification', text.includes('VERIFICATION-1'))
		check('C9 the injected text is bounded', text.length <= 2600, String(text.length))
		const assembly = await systemPrompt.assemble({ agent, scope: agent })
		const injected = assembly.contexts.filter((entry) => entry.text.includes('Project Memory'))
		check('C10 the recall reaches a real prompt assembly exactly once', injected.length === 1)
		check('C11 it is a distinct named context contribution', injected[0] !== undefined && injected[0].name === 'project-memory:recall')
		check('C12 every context still carries text', assembly.contexts.every((entry) => typeof entry.text === 'string'))
	}

	// ── D. a known-failed plan is surfaced ─────────────────────────────────────
	console.log('\nD. a previously failed plan is surfaced before the agent plans again')
	{
		const text = memory.recallText(fakeAgent(sessionA2))
		check('D1 the failed plan is named', text.includes('FAILED-1'))
		check('D2 the retry condition is stated', text.includes('requires stating what is different now'))
		check('D3 the failed plan carries its reason', text.includes('REASON-1') || text.includes('REASON-2'))
		const found = await tool(root, 'memory_search').execute({ query: 'SYM-1 FAILED' }, { agent: fakeAgent(sessionA2) })
		check('D4 explicit search finds it too', found.count >= 1 && found.records[0].failed_attempts.length === 2)
		check('D5 explicit search returns the constraint list', found.records[0].constraints.length === 1)
	}

	// ── E. new evidence corrects an earlier conclusion ─────────────────────────
	console.log('\nE. new evidence supersedes an earlier conclusion')
	let wrongRecordId = ''
	let replacementId = ''
	{
		const wrong = await tool(root, 'memory_record').execute({
			problem: 'SYM-1 的错误结论',
			conclusion: 'inferred',
			root_cause: 'ROOT-CAUSE-WRONG',
			related_files: ['src/module/other.js'],
			tags: ['tag-one'],
		}, { agent: fakeAgent(sessionA1) })
		wrongRecordId = wrong.record_id
		const corrected = await tool(root, 'memory_correct').execute({
			record_id: wrong.record_id,
			status: 'superseded',
			reason: 'REASON-4 新证据推翻了旧结论',
			new_problem: 'SYM-1 的故障复现了（修正版）',
			new_root_cause: 'ROOT-CAUSE-1',
			new_verification: 'VERIFICATION-1 复现方式',
			new_failed_attempts: failedAttempts,
			new_constraints: ['CONSTRAINT-1 后续不能破坏的约束'],
			related_files: ['src/module/other.js'],
			tags: ['tag-one'],
		}, { agent: fakeAgent(sessionA1) })
		replacementId = corrected.replacement_id ?? ''
		check('E1 the old record is marked superseded', corrected.revised_status === 'superseded')
		check('E2 a replacement record was written', typeof corrected.replacement_id === 'string')
		const old = memory.get(wrong.record_id)
		check('E3 the old record points at its replacement', old.superseded_by === corrected.replacement_id)
		check('E4 the replacement points back at the old record', memory.get(corrected.replacement_id).supersedes.includes(wrong.record_id))
		check('E5 the old record was revised, not deleted', old.revision === 2 && old.revised_at !== null)
		check('E6 the superseded conclusion no longer competes', memory.recall(sessionA2).records.every((entry) => entry.record.id !== wrong.record_id))
		check('E7 the replacement is recalled instead', memory.recall(sessionA2).records.some((entry) => entry.record.id === corrected.replacement_id))
		check('E8 revising another project\'s record is refused', await (async () => {
			try {
				await tool(root, 'memory_correct').execute({ record_id: wrong.record_id, status: 'confirmed', reason: 'X' }, { agent: fakeAgent(sessionB1) })
				return false
			} catch (error) {
				return String(error.message).includes('another project')
			}
		})())
		check('E9 revising an unknown record is refused', await (async () => {
			try {
				await tool(root, 'memory_correct').execute({ record_id: 'mem-does-not-exist', status: 'confirmed', reason: 'X' }, { agent: fakeAgent(sessionA1) })
				return false
			} catch (error) {
				return String(error.message).includes('no record')
			}
		})())
	}

	// ── F. project isolation ───────────────────────────────────────────────────
	console.log('\nF. two projects with an identical symptom do not share memory')
	let projectB = ''
	{
		const beta = memory.recall(sessionB1)
		check('F1 the other project recalls nothing from project A', beta.considered === 0 && beta.records.length === 0, JSON.stringify(beta.records.length))
		check('F2 no context is injected for the other project', memory.recallText(fakeAgent(sessionB1)) === '')
		const betaSearch = await tool(root, 'memory_search').execute({ query: 'SYM-1 FAILED' }, { agent: fakeAgent(sessionB1) })
		check('F3 explicit search in the other project returns nothing', betaSearch.count === 0)
		projectB = betaSearch.project
		check('F4 the two project keys differ', projectB !== created.project, projectB + ' vs ' + created.project)
		await tool(root, 'memory_record').execute({
			problem: 'SYM-1 的故障又出现了',
			conclusion: 'verified',
			root_cause: 'ROOT-CAUSE-B',
			verification: 'VERIFICATION-B',
			tags: ['tag-one'],
		}, { agent: fakeAgent(sessionB1) })
		const betaAfter = memory.recall(sessionB1)
		const alphaAfter = memory.recall(sessionA2)
		check('F5 each project recalls only its own records', betaAfter.records.length === 1
			&& betaAfter.records[0].record.project === projectB
			&& alphaAfter.records.every((entry) => entry.record.project === created.project))
		check('F6 the identical symptom text did not leak across projects', betaAfter.records[0].record.root_cause === 'ROOT-CAUSE-B')
	}

	// ── G. bounded recall over a large history ─────────────────────────────────
	console.log('\nG. with a large history only a few relevant records are recalled')
	{
		for (let index = 0; index < 40; index++) {
			await tool(root, 'memory_record').execute({
				problem: 'NOTE-' + index + ' 另一件事，措辞尽量不同',
				conclusion: 'fact',
				root_cause: 'ROOT-CAUSE-UNRELATED',
				related_files: ['src/unrelated/file_' + index + '.js'],
				tags: ['unrelated'],
			}, { agent: fakeAgent(sessionA1) })
		}
		const total = memory.allForProject(created.project).length
		const result = memory.recall(sessionA2)
		const text = memory.recallText(fakeAgent(sessionA2))
		check('G1 the project really holds a large history', total >= 40, String(total))
		check('G2 recall returns at most maxRecallRecords', result.records.length <= 3, String(result.records.length))
		check('G3 recall does not return the whole history', result.records.length < total, result.records.length + ' of ' + total)
		check('G4 every recalled record is one of the relevant ones', result.records.every((entry) => entry.record.tags.includes('tag-one')), JSON.stringify(result.records.map((entry) => entry.record.tags)))
		check('G5 the injected text stays bounded', text.length <= 2600, String(text.length))
		check('G6 the injected text excludes the bulk noise', !text.includes('NOTE-'))
		check('G7 an unrelated task recalls no bulk record', memory.recall(sessionA3).records.every((entry) => !entry.record.tags.includes('unrelated')))
	}

	// ── H. transparency ────────────────────────────────────────────────────────
	console.log('\nH. the recall decision is auditable')
	{
		const auditTool = tool(root, 'memory_audit')
		const audit = await auditTool.execute({ limit: 200 })
		const injected = audit.entries.filter((entry) => entry.action === 'recall-injected')
		check('H1 recall injections are audited', injected.length > 0)
		check('H2 the audit names the records that were injected', injected[0].records.length > 0)
		check('H3 the audit explains why each was relevant', injected[0].reasons.join(' ').length > 0)
		check('H4 the audit records how many candidates lost', typeof injected[0].considered === 'number')
		check('H5 the audit records the query that was used', typeof injected[0].query.text === 'string' && injected[0].query.text.length > 0)
		check('H6 the audit records the injected size', typeof injected[0].injected_chars === 'number')
		check('H7 writes are audited', audit.entries.some((entry) => entry.action === 'record-created'))
		check('H8 revisions are audited', audit.entries.some((entry) => entry.action === 'record-revised'))
		check('H9 the audit is filterable by action', (await auditTool.execute({ action: 'record-created', limit: 200 })).entries.every((entry) => entry.action === 'record-created'))
		check('H10 the audit is filterable by project', (await auditTool.execute({ project: created.project, limit: 200 })).entries.every((entry) => entry.project === created.project))
	}

	// ── I. restart over the same medium ────────────────────────────────────────
	console.log('\nI. the same medium serves a fresh process')
	{
		const domain = root.get('storage').domain.get('dsh_project_memory')
		check('I1 the domain is open on the storage facility', domain !== undefined)
		let stored = 0
		for (const [, record] of domain.table('records').entries()) {
			stored++
			if (JSON.parse(JSON.stringify(record)).id !== record.id) throw new Error('stored record is not JSON-lossless')
		}
		check('I2 the medium holds every written record', stored >= 40, String(stored))
		const projectACount = memory.allForProject(created.project).length
		const projectBCount = memory.allForProject(projectB).length

		await loader.remove('root')
		await new Promise((resolve) => setTimeout(resolve, 20))
		check('I3 the first tree released its domain unit', medium.open.has('dsh_project_memory') === false, JSON.stringify([...medium.open]))

		const { root: restarted } = await boot()
		const revived = await waitFor(() => restarted.get('projectMemory'))
		check('I4 the plugin remounts over the existing medium', revived !== undefined)
		if (revived !== undefined) {
			check('I5 every stored record reloaded, both projects included', revived.allForProject(created.project).length === projectACount && revived.allForProject(projectB).length === projectBCount, revived.allForProject(created.project).length + '/' + projectACount + ' + ' + revived.allForProject(projectB).length + '/' + projectBCount)
			check('I6 a new session still recalls the relevant record', revived.recall(sessionA2).records.some((entry) => entry.record.id === replacementId))
			check('I7 the superseded record is still superseded after reload', revived.get(wrongRecordId).status === 'superseded')
			check('I8 the other project is still isolated after reload', revived.allForProject(created.project).every((record) => record.project === created.project))
		}
	}

	console.log('\n' + (failures === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : failures + ' of ' + checks + ' CHECKS FAILED'))
	process.exit(failures === 0 ? 0 : 1)
}

await main()
