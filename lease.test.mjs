/**
 * Cross-process write test.
 *
 * Two SEPARATE OS processes mutate ONE record of ONE project through the real
 * plugin, over a real `dsh-storage-json` store on disk. Every increment is
 * `revision += 1` computed from what that writer knows, so the final revision
 * counts exactly how many updates survived:
 *
 *   both writers serialized  -> revision === 1 + 2 * N   (nothing lost)
 *   last-write-wins          -> revision ~= 1 + N        (half the updates lost)
 *
 * A third process then boots fresh and reports what the plugin sees.
 *
 * Run from this directory:
 *   DSH_PLUGIN_DEPS=<path to $DSH_HOME/profiles/node_modules> \
 *     node --import ./register-deps.mjs lease.test.mjs
 */

import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryGroup } from '@deepseek-ai/cordis-plugin-loader'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import { projectIdOf } from './index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = new URL('./index.js', import.meta.url).href
const DEFAULT_HOME = (process.env.USERPROFILE ?? process.env.HOME ?? '.') + '/.dsh'
const HARNESS_BASE = pathToFileURL(process.env.DSH_PLUGIN_DEPS ?? (process.env.DSH_HOME ?? DEFAULT_HOME) + '/profiles/node_modules/').href
const N = 40
const CWD = 'C:\\work\\lease-project'
const DOMAIN_DIR = 'dsh_project_memory'

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
function yamlValue(value) {
	return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

/** Write one composition file naming these rows, in order. */
function composition(rows) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-lease-comp-'))
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
 * Mount the real registries, the real JSON backend over `store`, and the plugin.
 * @param store - the storage root directory.
 * @returns the mounted root context.
 */
async function boot(store) {
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
		{ id: 'project-memory', name: PLUGIN, config: { storeDir: join(store, DOMAIN_DIR) } },
	])
	await loader.create({ id: 'root', name: 'cordis:include', config: { path: pathToFileURL(file).href } })
	await loader.await()
	return root
}

/**
 * A class plugin's `[Service.init]` is a detached promise: wait for the service.
 * @param read - reads the service (or undefined).
 * @param timeoutMs - how long to wait.
 * @returns the service, or undefined on timeout.
 */
async function waitFor(read, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const value = read()
		if (value !== undefined) return value
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
	return read()
}

/** The per-record document as it sits on disk, independent of any in-memory view. */
function readRecordFile(store, id) {
	return JSON.parse(readFileSync(join(store, DOMAIN_DIR, 'records', id + '.json'), 'utf8')).record
}

/** Sleep, for polling. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wait until one path exists, or give up. */
async function waitForPath(path, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (existsSync(path)) return true
		await sleep(10)
	}
	return false
}

/** Run one child process to completion; `stdio: 'inherit'` is what this sandbox allows. */
function runChild(args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ['--import', './register-deps.mjs', 'lease.test.mjs', 'child', ...args], {
			cwd: HERE,
			stdio: 'inherit',
		})
		child.on('exit', (code) => resolve(code))
	})
}

/** The child role: one rival writer, or the fresh-eye verifier. */
async function childRole(role, store, n) {
	const project = projectIdOf(CWD)
	const root = await boot(store)
	const memory = await waitFor(() => root.get('projectMemory'))
	if (memory === undefined) throw new Error('child ' + role + ': the plugin did not mount')
	const id = readFileSync(join(store, 'seed-id.txt'), 'utf8').trim()
	writeFileSync(join(store, 'ready-' + role + '.json'), JSON.stringify({ role }))

	if (role === 'verify') {
		const record = memory.get(id)
		writeFileSync(join(store, 'result-verify.json'), JSON.stringify({
			seen: record !== undefined,
			revision: record?.revision,
			status: record?.status,
			ids: memory.idsForProject(project).length,
			projects: memory.allForProject(project).length,
		}))
		return 0
	}

	// Both writers wait for the same starting gun, so the race is real.
	if (!(await waitForPath(join(store, 'go'), 30000))) throw new Error('child ' + role + ': no starting gun')
	const errors = []
	for (let index = 0; index < n; index++) {
		try {
			await memory.markRevised(id, 'confirmed', null)
		} catch (error) {
			errors.push(String((error && error.code) ?? error))
		}
	}
	writeFileSync(join(store, 'result-' + role + '.json'), JSON.stringify({ role, calls: n, errors }))
	return 0
}

async function main() {
	if (process.argv[2] === 'child') {
		process.exit(await childRole(process.argv[3], process.argv[4], Number(process.argv[5])))
	}

	console.log('cross-process write tests\n')
	const project = projectIdOf(CWD)
	const store = mkdtempSync(join(tmpdir(), 'dsh-memory-lease-'))

	// Seed exactly one record, then hand the store to two rival processes.
	const root = await boot(store)
	const memory = await waitFor(() => root.get('projectMemory'))
	check('L1 the plugin mounts over a real JSON store', memory !== undefined)
	if (memory === undefined) process.exit(1)
	const seeded = await memory.put({
		project,
		project_path: CWD,
		problem: 'LEASE-SEED',
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
	}, { session_id: 'session-seed', cwd: CWD })
	writeFileSync(join(store, 'seed-id.txt'), seeded.id)
	check('L2 the seed record is on disk at revision 1', readRecordFile(store, seeded.id).revision === 1)

	const writers = [runChild(['A', store, N]), runChild(['B', store, N])]
	const ready = await Promise.all(['A', 'B'].map((role) => waitForPath(join(store, 'ready-' + role + '.json'), 30000)))
	check('L3 both rival processes reached the starting line', ready.every(Boolean), JSON.stringify(ready))
	writeFileSync(join(store, 'go'), 'go')
	const codes = await Promise.all(writers)
	check('L4 both rival processes exited cleanly', codes.every((code) => code === 0), JSON.stringify(codes))

	const errors = ['A', 'B'].flatMap((role) => {
		const path = join(store, 'result-' + role + '.json')
		return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).errors : ['child ' + role + ' produced no result']
	})
	check('L5 no write failed in either process', errors.length === 0, JSON.stringify(errors.slice(0, 5)))

	const final = readRecordFile(store, seeded.id)
	check('L6 every update survived (1 + 2N)', final.revision === 1 + 2 * N, 'revision=' + final.revision + ' expected=' + (1 + 2 * N))

	const leases = join(store, DOMAIN_DIR, '.leases')
	const held = existsSync(leases) ? readdirSync(leases) : []
	check('L7 every lease was released', held.length === 0, JSON.stringify(held))

	await runChild(['verify', store, 0])
	const seen = JSON.parse(readFileSync(join(store, 'result-verify.json'), 'utf8'))
	check('L8 a fresh process sees the final revision', seen.revision === 1 + 2 * N, JSON.stringify(seen))
	check('L9 a fresh process resolves the record through its project index', seen.ids === 1 && seen.projects === 1, JSON.stringify(seen))

	console.log('\n' + (failures === 0 ? 'all green' : failures + ' of ' + checks + ' checks FAILED'))
	process.exit(failures === 0 ? 0 : 1)
}

await main()
