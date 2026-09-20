/**
 * Mount `index.js` through a real Cordis Loader using an absolute-path row, the
 * way a profile's patch layer names it. Resolving nothing through a resolver
 * hook, so a clean pass is evidence that the file loads as a bare module.
 *
 * This needs a DSH installation to resolve `@deepseek-ai/*` and one of the
 * plugin's dependencies (`@deepseek-ai/dsh-tools`). Point DSH_PLUGIN_DEPS at the
 * harness dependency mirror:
 *
 *   DSH_PLUGIN_DEPS="$DSH_HOME/profiles/node_modules" node --import ./register-deps.mjs loader.test.mjs
 */
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryGroup } from '@deepseek-ai/cordis-plugin-loader'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'

const HERE = new URL('.', import.meta.url)
const PLUGIN = new URL('./index.js', import.meta.url).href

/** The installed harness, used as the base for bare `@deepseek-ai/*` names. */
const DEPS = process.env.DSH_PLUGIN_DEPS
if (DEPS === undefined || DEPS.length === 0) throw new Error('DSH_PLUGIN_DEPS is not set (point it at $DSH_HOME/profiles/node_modules)')
const HARNESS_BASE = pathToFileURL(DEPS.replace(/\\/g, '/').replace(/\/?$/, '/')).href
void HERE

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

/** A minimal in-memory KV backend with the JSON backend's contract. */
function memoryBackend() {
	const units = new Map()
	const open = new Set()
	const clone = (value) => JSON.parse(JSON.stringify(value))
	return {
		kv: {
			async open(descriptor) {
				if (open.has(descriptor.name)) throw new Error('unit already open: ' + descriptor.name)
				const state = units.get(descriptor.name) ?? { tables: {}, global: null }
				for (const table of descriptor.tables) state.tables[table] ??= {}
				units.set(descriptor.name, state)
				open.add(descriptor.name)
				return {
					async loadAll() {
						return { version: descriptor.version, tables: clone(state.tables), global: clone(state.global) }
					},
					async putRecord(table, key, value) {
						state.tables[table][key] = clone(value)
					},
					async deleteRecord(table, key) {
						const had = Object.hasOwn(state.tables[table], key)
						delete state.tables[table][key]
						return had
					},
					async backupRecord(_table, key) {
						return key + '.json.bak.test'
					},
					async close() {
						open.delete(descriptor.name)
					},
				}
			},
		},
	}
}

/**
 * Wait for a service to appear. A class plugin's `[Service.init]` is a detached
 * promise, so the Loader's `await()` can settle a few milliseconds before the
 * service publishes.
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

async function main() {
	console.log('project-memory loader test')
	console.log('plugin : ' + PLUGIN)
	console.log('deps   : ' + HARNESS_BASE + '\n')

	const root = new Context()
	const loader = new Loader(root)
	await root.plugin((ctx) => {
		ctx.provide('logger', { info() {}, warn(...a) { console.log('[warn]', ...a) }, error(...a) { console.log('[error]', ...a) }, debug() {} })
	})
	await root.plugin((await import('@deepseek-ai/dsh-storage')).default)
	// The backend, published as the lifecycle key the domain layer injects.
	await root.inject(['storage'], (ctx) => {
		ctx.provide(storageBackendServiceKey('memory'), { placeholder: true })
		ctx.storage.backend.register('memory', memoryBackend())
	})

	// A real composition file naming each row, the way a profile patch does.
	loader.builtins.group = EntryGroup
	loader.builtins.include = class HostResolvedRootInclude extends Include {
		import(name, getOuterStack) {
			if (name.startsWith('.') || name.startsWith('cordis:')) return super.import(name, getOuterStack)
			const internal = this.ctx.loader.internal
			if (internal === undefined) return super.import(name, getOuterStack)
			return internal.import(name, HARNESS_BASE, {})
		}
	}
	const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-loader-'))
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

	const memory = await waitFor(() => root.get('projectMemory'))
	check('L1 index.js mounts through a Loader row named by absolute path', memory !== undefined)
	if (memory === undefined) {
		for (const [callback, runtime] of root.registry.entries()) {
			console.log('    row: ' + (runtime.name ?? callback.name) + ' ' + [...(runtime.fibers ?? [])].map((fiber) => fiber.uid + (fiber.error === undefined ? ':ok' : ':ERR ' + fiber.error)).join(','))
		}
	} else {
		const tools = root.get('tools')
		check('L2 the four tools registered', ['memory_search', 'memory_record', 'memory_correct', 'memory_audit'].every((name) => tools.get(name) !== undefined))
		const session = { id: 'loader-test', header: { cwd: 'C:\\work\\loader-test' }, deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'SYM-1 复现' }] }], snapshotEvents: () => [] }
		const created = await tools.get('memory_record').execute({
			problem: 'SYM-1 复现',
			conclusion: 'verified',
			root_cause: 'ROOT-CAUSE-1',
			verification: 'VERIFICATION-1',
			failed_attempts: ['FAILED-1'],
			tags: ['tag-one'],
		}, { agent: { session } })
		check('L3 a record round-trips through the mounted service', memory.get(created.record_id).problem === 'SYM-1 复现')
		check('L4 recall renders the prohibition', memory.recallText({ session }).includes('DO NOT REPEAT'))
		const systemPrompt = root.get('systemPrompt')
		const assembly = await systemPrompt.assemble({ agent: { session }, scope: { session } })
		check('L5 the recall reaches a real prompt assembly', assembly.contexts.some((entry) => entry.text.includes('Project Memory')))
		check('L6 the usage section is registered', assembly.sections.some((section) => section.name === 'project-memory:usage'))
	}

	console.log('\n' + (failures === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : failures + ' of ' + checks + ' CHECKS FAILED'))
	process.exit(failures === 0 ? 0 : 1)
}

await main()
