/**
 * Regression tests for memory FORGETTING: the store could grow forever with no
 * way to drop a record. Written to FAIL before the tool exists.
 *
 * Run beside a deployment copy (index.js + memory-backend.mjs in this dir):
 *   DSH_PLUGIN_DEPS=<mirror> node --import ./register-deps.mjs regression-forget.test.mjs
 */
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryGroup } from '@deepseek-ai/cordis-plugin-loader'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const PLUGIN = new URL('./index.js', import.meta.url).href
const BACKEND = new URL('./memory-backend.mjs', import.meta.url).href
const HARNESS_BASE = pathToFileURL(dshHomePath('profiles', 'node_modules') + '/').href

let failures = 0
let checks = 0
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

async function boot() {
	const root = new Context()
	const loader = new Loader(root)
	await root.plugin((ctx) => {
		ctx.provide('logger', { info() {}, warn(...a) { console.log('[warn]', ...a) }, error(...a) { console.log('[error]', ...a) }, debug() {} })
	})
	await root.plugin((await import('@deepseek-ai/dsh-storage')).default)
	await root.plugin(await import(BACKEND))
	loader.builtins.group = EntryGroup
	loader.builtins.include = class extends Include {
		import(name, getOuterStack) {
			if (name.startsWith('.') || name.startsWith('cordis:')) return super.import(name, getOuterStack)
			const internal = this.ctx.loader.internal
			if (internal === undefined) return super.import(name, getOuterStack)
			return internal.import(name, HARNESS_BASE, {})
		}
	}
	const dir = mkdtempSync(join(tmpdir(), 'dsh-forget-'))
	const file = join(dir, 'cordis.yml')
	writeFileSync(file, [
		'- id: storage-domain', "  name: '@deepseek-ai/dsh-storage-domain'", '  config:', '    backend: memory',
		'- id: tools', "  name: '@deepseek-ai/dsh-tools'",
		'- id: system-prompt', "  name: '@deepseek-ai/dsh-system-prompt'",
		'- id: project-memory', '  name: ' + JSON.stringify(PLUGIN), '  config:', '    storeDir: ' + JSON.stringify(dir),
		'',
	].join('\n'))
	await loader.create({ id: 'root', name: 'cordis:include', config: { path: pathToFileURL(file).href } })
	await loader.await()
	const deadline = Date.now() + 3000
	let memory = root.get('projectMemory')
	while (memory === undefined && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 25))
		memory = root.get('projectMemory')
	}
	return { root, loader, memory }
}

const session = { id: 's', header: { cwd: 'C:\\work\\forget' }, deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'SYM-1 复现' }] }], snapshotEvents: () => [] }
const other = { id: 'o', header: { cwd: 'C:\\work\\other' }, deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'SYM-1 复现' }] }], snapshotEvents: () => [] }
const tool = (root, name) => root.get('tools').get(name)

async function main() {
	const { root, memory } = await boot()
	if (memory === undefined) { console.log('mount failed'); process.exit(1) }

	check('F0 memory_forget is registered', root.get('tools').get('memory_forget') !== undefined)
	if (root.get('tools').get('memory_forget') === undefined) {
		console.log('\n' + failures + ' of ' + checks + ' CHECKS FAILED')
		process.exit(1)
	}

	const foreign = await tool(root, 'memory_record').execute({ problem: 'SYM-1 复现（别的项目）', conclusion: 'fact', root_cause: 'R-X' }, { agent: { session: other } })
	const doomed = await tool(root, 'memory_record').execute({ problem: 'SYM-1 复现（待删）', conclusion: 'fact', root_cause: 'R-DOOM' }, { agent: { session } })
	const keeper = await tool(root, 'memory_record').execute({ problem: 'SYM-1 复现（保留）', conclusion: 'fact', root_cause: 'R-KEEP' }, { agent: { session } })

	// 1. Explicit single deletion.
	console.log('\n1. explicit deletion')
	const gone = await tool(root, 'memory_forget').execute({ record_id: doomed.record_id }, { agent: { session } })
	check('1a forgetting one record reports it', gone.forgotten.includes(doomed.record_id), JSON.stringify(gone))
	check('1b the record is gone from the store', memory.get(doomed.record_id) === undefined)
	check('1c it no longer appears in its project\'s records', !memory.allForProject(doomed.project.toString()).some((r) => r.id === doomed.record_id))
	check('1d the durable index no longer lists it', !root.get('storage').domain.get('dsh_project_memory').table('index').get(doomed.project.toString()).ids.includes(doomed.record_id))
	check('1e other records survive', memory.get(keeper.record_id) !== undefined)

	// 2. Cross-project refusal.
	console.log('\n2. scope')
	check('2a another project\'s record cannot be forgotten', await (async () => {
		try {
			await tool(root, 'memory_forget').execute({ record_id: foreign.record_id }, { agent: { session } })
			return false
		} catch (error) { return String(error.message).includes('another project') }
	})())

	// 3. Purging superseded/invalidated records only.
	console.log('\n3. purging inactive records')
	const stale = await tool(root, 'memory_record').execute({ problem: 'SYM-1 复现（旧结论）', conclusion: 'inferred', root_cause: 'R-OLD' }, { agent: { session } })
	await tool(root, 'memory_correct').execute({ record_id: stale.record_id, status: 'invalidated', reason: 'R' }, { agent: { session } })
	const bad = await tool(root, 'memory_record').execute({ problem: 'SYM-1 复现（错结论）', conclusion: 'inferred', root_cause: 'R-BAD' }, { agent: { session } })
	await tool(root, 'memory_correct').execute({ record_id: bad.record_id, status: 'superseded', reason: 'R', new_problem: 'SYM-1 复现（修正）', new_root_cause: 'R-NEW' }, { agent: { session } })
	const purged = await tool(root, 'memory_forget').execute({ only_inactive: true }, { agent: { session } })
	check('3a purge reports what it removed', purged.forgotten.length >= 2, JSON.stringify(purged.forgotten))
	check('3b the invalidated record is gone', memory.get(stale.record_id) === undefined)
	check('3c the superseded record is gone', memory.get(bad.record_id) === undefined)
	check('3d active records are untouched by a purge', memory.get(keeper.record_id) !== undefined)
	check('3e a purge never removes another project\'s record', memory.get(foreign.record_id) !== undefined)

	// 4. Refusals.
	console.log('\n4. refusals')
	check('4a unknown record is refused', await (async () => {
		try {
			await tool(root, 'memory_forget').execute({ record_id: 'mem-does-not-exist' }, { agent: { session } })
			return false
		} catch (error) { return String(error.message).includes('no record') }
	})())
	check('4b neither selector given is refused', await (async () => {
		try {
			await tool(root, 'memory_forget').execute({}, { agent: { session } })
			return false
		} catch (error) { return /record_id|only_inactive/.test(String(error.message)) }
	})())
	check('4c no agent session is refused', await (async () => {
		try {
			await tool(root, 'memory_forget').execute({ record_id: keeper.record_id }, {})
			return false
		} catch (error) { return String(error.message).includes('owning agent session') }
	})())

	console.log('\n' + (failures === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : failures + ' of ' + checks + ' CHECKS FAILED'))
	process.exit(failures === 0 ? 0 : 1)
}

await main()
