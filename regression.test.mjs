/**
 * Regression tests for two reported defects. Written to FAIL against the
 * current build before the fixes, so the fix is proven rather than asserted.
 *
 * Run next to a deployed copy (index.js + memory-backend.mjs must resolve from
 * the same directory this file lives in):
 *   node regression.test.mjs
 */
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const HERE = new URL('.', import.meta.url)
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
	const { Context: C } = await import('@deepseek-ai/cordis')
	const { default: Loader, EntryGroup } = await import('@deepseek-ai/cordis-plugin-loader')
	const { Include } = await import('@deepseek-ai/cordis-plugin-include')
	const root = new C()
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
	const dir = mkdtempSync(join(tmpdir(), 'dsh-regress-'))
	const file = join(dir, 'cordis.yml')
	writeFileSync(file, [
		'- id: storage-domain', "  name: '@deepseek-ai/dsh-storage-domain'", '  config:', '    backend: memory',
		'- id: tools', "  name: '@deepseek-ai/dsh-tools'",
		'- id: system-prompt', "  name: '@deepseek-ai/dsh-system-prompt'",
		'- id: project-memory', '  name: ' + JSON.stringify(PLUGIN),
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

const session = { id: 's', header: { cwd: 'C:\\work\\regress' }, deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'SYM-1 复现' }] }], snapshotEvents: () => [] }
const tool = (root, name) => root.get('tools').get(name)

async function main() {
	const { root, loader, memory } = await boot()
	if (memory === undefined) {
		console.log('mount failed'); process.exit(1)
	}

	// ── Defect 1: an index of the right LENGTH but wrong CONTENT ──────────────
	console.log('\n1. index self-heal with equal-length corruption')
	const a = await tool(root, 'memory_record').execute({ problem: 'SYM-1 复现', conclusion: 'fact', root_cause: 'R-A' }, { agent: { session } })
	const b = await tool(root, 'memory_record').execute({ problem: 'SYM-1 复现（二）', conclusion: 'fact', root_cause: 'R-B' }, { agent: { session } })
	const c = await tool(root, 'memory_record').execute({ problem: 'SYM-1 复现（三）', conclusion: 'fact', root_cause: 'R-C' }, { agent: { session } })
	const real = [a.record_id, b.record_id, c.record_id]
	const project = a.project.toString()
	{
		// Corrupt one entry in place: same length, wrong content.
		const domain = root.get('storage').domain.get('dsh_project_memory')
		const index = domain.table('index')
		const stored = index.get(project)
		check('1a the index holds three ids before corruption', stored !== undefined && stored.ids.length === 3, JSON.stringify(stored && stored.ids.length))
		const corrupt = [...stored.ids]
		corrupt[1] = 'mem-00000000T000000Z-ffffff'
		index.put(project, { ids: corrupt })
		await new Promise((r) => setTimeout(r, 30))
		const afterCorrupt = index.get(project).ids
		check('1b corruption has the same length as the truth', afterCorrupt.length === real.length, afterCorrupt.length + ' vs ' + real.length)
	}

	// Remount: init runs rebuildIndex, which is what claims to self-heal.
	await loader.remove('root')
	await new Promise((r) => setTimeout(r, 30))
	const second = await boot()
	check('1c the plugin remounts', second.memory !== undefined)
	if (second.memory !== undefined) {
		// Read the INDEX ITSELF, not allForProject: a corrupt id yields no record,
		// so allForProject would look right while the stored index is still wrong.
		const indexAfter = second.root.get('storage').domain.get('dsh_project_memory').table('index').get(project).ids
		check('1d a same-length corrupt index is repaired on open', JSON.stringify([...indexAfter].sort()) === JSON.stringify([...real].sort()), JSON.stringify(indexAfter))
		check('1e a corrupt id still reaches nothing through recall', second.memory.allForProject(project).every((record) => real.includes(record.id)))
	}
	if (second.root === undefined || second.memory === undefined) {
		console.log('\naborting: the remounted tree is unusable')
		console.log('\n' + failures + ' of ' + checks + ' CHECKS FAILED')
		process.exit(1)
	}
	// Everything after this point runs on the REMOUNTED tree: disposing the first
	// root unloads its tool registry.
	const live = { root: second.root, memory: second.memory }

	// ── Defect 2: `corrected` with no replacement ----------------------------
	console.log('\n2. memory_correct("corrected") without a replacement')
	const target = await tool(live.root, 'memory_record').execute({ problem: 'SYM-1 的错误结论', conclusion: 'inferred', root_cause: 'R-WRONG' }, { agent: { session } })
	let threw = undefined
	try {
		await tool(live.root, 'memory_correct').execute({ record_id: target.record_id, status: 'corrected', reason: 'REASON' }, { agent: { session } })
	} catch (error) {
		threw = String(error.message)
	}
	check('2a "corrected" with no replacement is refused', threw !== undefined && /replacement/i.test(threw), String(threw))

	const recalling = live.memory.recall(session).records.map((entry) => entry.record.id)
	check('2b an un-replaced "corrected" record cannot keep feeding recall', !recalling.includes(target.record_id), JSON.stringify(recalling))

	// The legitimate forms still work.
	console.log('\n3. the legitimate forms still work')
	const confirmee = await tool(live.root, 'memory_record').execute({ problem: 'SYM-1 复现（四）', conclusion: 'fact', root_cause: 'R-D' }, { agent: { session } })
	check('3a "confirmed" still works with no replacement', await (async () => {
		try {
			const out = await tool(live.root, 'memory_correct').execute({ record_id: confirmee.record_id, status: 'confirmed', reason: 'R' }, { agent: { session } })
			return out.revised_status === 'confirmed'
		} catch { return false }
	})())
	const invalidatee = await tool(live.root, 'memory_record').execute({ problem: 'SYM-1 复现（五）', conclusion: 'inferred', root_cause: 'R-E' }, { agent: { session } })
	check('3b "invalidated" still works with no replacement', await (async () => {
		try {
			const out = await tool(live.root, 'memory_correct').execute({ record_id: invalidatee.record_id, status: 'invalidated', reason: 'R' }, { agent: { session } })
			return out.revised_status === 'invalidated'
		} catch { return false }
	})())
	const supersee = await tool(live.root, 'memory_record').execute({ problem: 'SYM-1 的错误结论（二）', conclusion: 'inferred', root_cause: 'R-F' }, { agent: { session } })
	check('3c "superseded" with a replacement still works and links both ways', await (async () => {
		try {
			const out = await tool(live.root, 'memory_correct').execute({
				record_id: supersee.record_id, status: 'superseded', reason: 'R',
				new_problem: 'SYM-1 复现（修正）', new_root_cause: 'R-G', new_verification: 'V-G',
			}, { agent: { session } })
			const old = live.memory.get(supersee.record_id)
			const replacement = live.memory.get(out.replacement_id)
			return old.superseded_by === out.replacement_id && replacement.supersedes.includes(supersee.record_id)
		} catch { return false }
	})())

	console.log('\n' + (failures === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : failures + ' of ' + checks + ' CHECKS FAILED'))
	process.exit(failures === 0 ? 0 : 1)
}

await main()
