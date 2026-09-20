/**
 * Regression suite for the consistency defects the independent audit found on
 * 2026-09-20 (see `_audit/dsh-memory-audit-20260920/REPORT.md` in the workspace).
 *
 * Every check here FAILED against the build published as 1.1.0 / ba4778a, so the
 * fixes are proven rather than asserted. The two instances share one real JSON
 * store but keep separate in-memory tables — exactly the "second process" the
 * defects need, without paying for OS processes.
 *
 * Run from this directory:
 *   DSH_PLUGIN_DEPS=<path to $DSH_HOME/profiles/node_modules> \
 *     node --import ./register-deps.mjs regression-consistency.test.mjs
 */

import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryGroup } from '@deepseek-ai/cordis-plugin-loader'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import { projectIdOf } from './index.js'

const PLUGIN = new URL('./index.js', import.meta.url).href
const DEFAULT_HOME = (process.env.USERPROFILE ?? process.env.HOME ?? '.') + '/.dsh'
const HARNESS_BASE = pathToFileURL((process.env.DSH_HOME ?? DEFAULT_HOME) + '/profiles/node_modules/').href
const DOMAIN_DIR = 'dsh_project_memory'
const CWD = 'C:\\work\\consistency-project'
const OTHER_CWD = 'C:\\work\\some-other-project'

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

/** Render one composition value as YAML, quoting strings so a path stays a path. */
const yamlValue = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value))

/** Write one composition file naming these rows, in order. */
function composition(rows) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-cons-comp-'))
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

/** Mount the real registries, the real JSON backend over `store`, and the plugin. */
async function boot(store, pluginConfig = {}) {
	const root = new Context()
	const loader = new Loader(root)
	await root.plugin((ctx) => {
		ctx.provide('logger', { info() {}, warn() {}, error() {}, debug() {} })
	})
	await root.plugin((await import('@deepseek-ai/dsh-storage')).default)
	await root.plugin(await import('@deepseek-ai/dsh-storage-json'), { root: store })
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
		{ id: 'storage-domain', name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
		{ id: 'tools', name: '@deepseek-ai/dsh-tools' },
		{ id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
		{ id: 'project-memory', name: PLUGIN, config: { storeDir: join(store, DOMAIN_DIR), ...pluginConfig } },
	])
	await loader.create({ id: 'root', name: 'cordis:include', config: { path: pathToFileURL(file).href } })
	await loader.await()
	const deadline = Date.now() + 8000
	let memory = root.get('projectMemory')
	while (memory === undefined && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25))
		memory = root.get('projectMemory')
	}
	if (memory === undefined) throw new Error('the plugin did not mount')
	return { root, memory }
}

/** One synthetic session: the exact surface the plugin reads. */
const session = (cwd, messages = []) => ({
	id: 'session-' + cwd,
	header: { cwd, createdAt: Date.now(), version: 3 },
	deriveMessages() {
		return messages.map((text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }))
	},
	snapshotEvents() {
		return []
	},
})
const agent = (cwd, messages) => ({ id: 'agent', session: session(cwd, messages) })

/** A record input bound to one project. */
function inputFor(project, cwd, problem) {
	return {
		project,
		project_path: cwd,
		problem,
		symptoms: [],
		facts: [],
		hypotheses: [],
		attempts: [],
		failed_attempts: [],
		root_cause: '',
		conclusion: 'inferred',
		changes: [],
		verification: '',
		constraints: [],
		related_files: [],
		related_symbols: [],
		tags: [],
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const recordPath = (store, id) => join(store, DOMAIN_DIR, 'records', id + '.json')
const indexIds = (store, project) => JSON.parse(readFileSync(join(store, DOMAIN_DIR, 'index', project + '.json'), 'utf8')).record.ids
const leasePath = (store, project) => join(store, DOMAIN_DIR, '.leases', project + '.lock')

async function main() {
	console.log('consistency regression suite\n')
	const store = mkdtempSync(join(tmpdir(), 'dsh-memory-cons-'))
	const project = projectIdOf(CWD)
	const otherProject = projectIdOf(OTHER_CWD)

	const a = await boot(store)
	const seed = await a.memory.put(inputFor(project, CWD, 'CONSISTENCY-SEED'), { session_id: 'a', cwd: CWD })
	// The second instance snapshots the store HERE, which is what makes it stale.
	const b = await boot(store)

	// ── C. a deletion must stick ───────────────────────────────────────────────
	console.log('C. a record deleted by one process stays deleted')
	await a.memory.forget(seed.id)
	check('C1 the document is gone from the medium', existsSync(recordPath(store, seed.id)) === false)
	const other = await b.memory.put(inputFor(project, CWD, 'CONSISTENCY-OTHER'), { session_id: 'b', cwd: CWD })
	check('C2 the stale writer\'s unrelated write still succeeds', typeof other.id === 'string')
	check('C3 the stale writer does not re-index the deleted record', indexIds(store, project).includes(seed.id) === false, JSON.stringify(indexIds(store, project)))
	let refused = undefined
	try {
		await b.memory.markRevised(seed.id, 'confirmed', null)
	} catch (error) {
		refused = String(error.message)
	}
	check('C4 revising a deleted record is refused', refused !== undefined, String(refused))
	check('C5 the deleted document was NOT written back', existsSync(recordPath(store, seed.id)) === false)
	check('C6 the deleted record is out of the stale writer\'s own view', b.memory.get(seed.id) === undefined)

	// ── R. tool boundaries ─────────────────────────────────────────────────────
	console.log('\nR. tool boundaries hold a project')
	let correctError = undefined
	try {
		await b.root.get('tools').get('memory_correct').execute(
			{ record_id: other.id, status: 'invalidated', reason: 'missing cwd probe' },
			{ agent: { session: { id: 'no-cwd', header: {} } } },
		)
	} catch (error) {
		correctError = String(error.message)
	}
	check('R1 memory_correct without a cwd is refused', correctError !== undefined, String(correctError))
	check('R2 the record was left alone', b.memory.get(other.id).status === 'active', String(b.memory.get(other.id).status))

	await b.root.get('tools').get('memory_search').execute({ query: 'CONSISTENCY-OTHER' }, { agent: agent(CWD) })
	const leaked = await b.root.get('tools').get('memory_audit').execute({ limit: 200 }, { agent: agent(OTHER_CWD) })
	check('R3 memory_audit does not show another project\'s entries', leaked.entries.every((entry) => entry.project === otherProject), JSON.stringify(leaked.entries.map((entry) => entry.project)))
	const own = await b.root.get('tools').get('memory_audit').execute({ limit: 200 }, { agent: agent(CWD) })
	check('R4 memory_audit still shows this project\'s entries', own.entries.length > 0 && own.entries.every((entry) => entry.project === project), String(own.entries.length))
	check('R5 memory_audit is still filterable by action', await (async () => {
		const only = await b.root.get('tools').get('memory_audit').execute({ action: 'explicit-search', limit: 200 }, { agent: agent(CWD) })
		return only.entries.length > 0 && only.entries.every((entry) => entry.action === 'explicit-search')
	})())
	let auditArgumentError = undefined
	try {
		await b.root.get('tools').get('memory_audit').execute({ project: otherProject }, { agent: agent(CWD) })
	} catch (error) {
		auditArgumentError = String(error.message)
	}
	check('R6 memory_audit refuses to be pointed at another project', auditArgumentError !== undefined, String(auditArgumentError))

	// ── L. lease semantics ─────────────────────────────────────────────────────
	console.log('\nL. the write lease keeps its promises')
	let active = 0
	let maxActive = 0
	const hold = (service, ms, operation) => service.withProjectWrite(project, { operation }, async () => {
		active += 1
		maxActive = Math.max(maxActive, active)
		await sleep(ms)
		active -= 1
	})

	const first = hold(a.memory, 300, 'probe')
	await sleep(60)
	await hold(b.memory, 30, 'probe')
	await first
	check('L1 a live holder is waited out, not bypassed', maxActive === 1, 'maxActive=' + maxActive)
	const conflict = b.memory.audit.filter((entry) => entry.action === 'write-conflict')
	check('L2 the contention is audited under its own action', conflict.length > 0, JSON.stringify(b.memory.audit.map((entry) => entry.action)))
	check('L3 the audited conflict keeps the business operation', conflict.length > 0 && conflict[0].operation === 'probe', JSON.stringify(conflict[0]))

	// Budget exhausted against a live holder: take over rather than write unlocked.
	b.memory.config.leaseWaitMs = 120
	let insideB
	const enteredB = new Promise((resolve) => { insideB = resolve })
	let releaseB
	const gateB = new Promise((resolve) => { releaseB = resolve })
	const holderA = hold(a.memory, 400, 'old-holder')
	await sleep(60)
	const bypassing = b.memory.withProjectWrite(project, { operation: 'successor' }, async () => {
		insideB()
		await gateB
	})
	await enteredB
	const lockOf = () => {
		try {
			return JSON.parse(readFileSync(leasePath(store, project), 'utf8'))
		} catch {
			return undefined
		}
	}
	const held = lockOf()
	check('L4 the bypassing writer owns a lock of its own', held !== undefined && held.pid === process.pid && typeof held.token === 'string', JSON.stringify(held))
	const tokenWhileB = held?.token
	await holderA
	const afterOld = lockOf()
	check('L5 the old holder does not remove the successor\'s lock', afterOld !== undefined, JSON.stringify(afterOld))
	check('L6 the successor\'s lock is untouched', afterOld?.token === tokenWhileB && tokenWhileB !== undefined)
	const bypass = b.memory.audit.filter((entry) => entry.action === 'write-bypass')
	check('L7 the bypass is audited as a bypass', bypass.length === 1, JSON.stringify(bypass))
	releaseB()
	await bypassing
	check('L8 the successor releases its own lock', existsSync(leasePath(store, project)) === false)
	check('L9 no stale lock files are left behind', readdirSync(join(store, DOMAIN_DIR, '.leases')).length === 0, JSON.stringify(readdirSync(join(store, DOMAIN_DIR, '.leases'))))

	// ── B. the recall budget is a budget ───────────────────────────────────────
	console.log('\nB. the injected text respects maxRecallChars exactly')
	const tiny = await boot(store, { maxRecallChars: 200, perRecordChars: 900 })
	for (let index = 0; index < 3; index++) {
		await tiny.memory.put(inputFor(project, CWD, 'BUDGET-TAG ' + 'x'.repeat(380) + ' #' + index), { session_id: 'tiny', cwd: CWD })
	}
	const text = tiny.memory.recallText(agent(CWD, ['BUDGET-TAG BUDGET-TAG']))
	check('B1 a recall that overflows is truncated to the configured budget', text.length <= 200, 'length=' + text.length)
	check('B2 the truncation is still marked', text.endsWith('[recall truncated]'), JSON.stringify(text.slice(-30)))

	console.log('\n' + (failures === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : failures + ' of ' + checks + ' CHECKS FAILED'))
	process.exit(failures === 0 ? 0 : 1)
}

await main()
