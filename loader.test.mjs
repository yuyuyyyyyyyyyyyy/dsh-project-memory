/**
 * Mount the DEPLOYED plugin through a real Cordis Loader, resolving every
 * dependency exactly as production does — by Node's ordinary upward walk from
 * `$DSH_HOME/profiles/`, with NO resolver hook. Running this file is therefore
 * itself evidence that the deployed copy imports cleanly in place.
 *
 * Run in place: node loader-deployed.test.mjs
 */

import { writeFileSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { EntryGroup } from '@deepseek-ai/cordis-plugin-loader'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = pathToFileURL(join(HERE, 'index.js')).href
const HARNESS_BASE = pathToFileURL(join(HERE, '..', 'node_modules') + '/').href

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
}

/** A minimal in-memory KV backend with the json backend's contract. */
function memoryBackend() {
	const units = new Map()
	const open = new Set()
	const clone = (value) => JSON.parse(JSON.stringify(value))
	return {
		kv: {
			async open(descriptor) {
				if (open.has(descriptor.name)) throw new Error('unit already open')
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
						delete state.tables[table][key]
						return true
					},
					async close() {
						open.delete(descriptor.name)
					},
				}
			},
		},
	}
}

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
	console.log('deployed-plugin loader check (no resolver hook)')
	console.log('plugin: ' + PLUGIN + '\n')

	const root = new Context()
	const loader = new Loader(root)
	await root.plugin((ctx) => {
		ctx.provide('logger', { info() {}, warn(...a) { console.log('[warn]', ...a) }, error(...a) { console.log('[error]', ...a) }, debug() {} })
	})
	await root.plugin((await import('@deepseek-ai/dsh-storage')).default)
	// The backend, published as the lifecycle key the domain layer injects.
	// `inject` is what orders it after the storage hub actually activates.
	await root.inject(['storage'], (ctx) => {
		ctx.provide(storageBackendServiceKey('memory'), { placeholder: true })
		ctx.storage.backend.register('memory', memoryBackend())
	})
	loader.builtins.group = EntryGroup
	loader.builtins.include = class HostResolvedRootInclude extends Include {
		import(name, getOuterStack) {
			if (name.startsWith('.') || name.startsWith('cordis:')) return super.import(name, getOuterStack)
			return this.ctx.loader.internal.import(name, HARNESS_BASE, {})
		}
	}
	const dir = mkdtempSync(join(tmpdir(), 'dsh-deployed-'))
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

	const memory = await waitFor(() => root.get('projectMemory'))
	check('D1 the DEPLOYED copy mounts through the Loader, bare imports resolved in place', memory !== undefined)
	if (memory === undefined) {
		for (const [callback, runtime] of root.registry.entries()) {
			console.log('    row: ' + (runtime.name ?? callback.name) + ' ' + [...(runtime.fibers ?? [])].map((fiber) => fiber.uid + (fiber.error === undefined ? ':ok' : ':ERR ' + fiber.error)).join(','))
		}
	} else {
		const tools = root.get('tools')
		check('D2 the four tools registered', ['memory_search', 'memory_record', 'memory_correct', 'memory_audit'].every((name) => tools.get(name) !== undefined))
		const session = { id: 'deployed', header: { cwd: 'C:\\work\\deployed' }, deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '又遇到 deployed check problem 了' }] }], snapshotEvents: () => [] }
		const created = await tools.get('memory_record').execute({
			problem: 'deployed check problem',
			conclusion: 'verified',
			root_cause: 'deployed check cause',
			verification: 'deployed check verification',
			failed_attempts: ['扩大 matcher'],
			tags: ['deployed-check'],
		}, { agent: { session } })
		check('D3 a record round-trips through the deployed copy', memory.get(created.record_id).problem === 'deployed check problem')
		const text = memory.recallText({ session })
		if (process.env.DEBUG_DEPLOYED === '1') {
			const debug = memory.recall(session)
			console.log('    DEBUG project=' + debug.project + ' considered=' + debug.considered + ' error=' + debug.error)
			console.log('    DEBUG reasons=' + JSON.stringify(debug.reasons))
			console.log('    DEBUG query=' + JSON.stringify(debug.query))
			console.log('    DEBUG text=' + JSON.stringify(text).slice(0, 300))
		}
		check('D4 recall renders the prohibition for the deployed copy', text.includes('DO NOT REPEAT'))
		const systemPrompt = root.get('systemPrompt')
		const assembly = await systemPrompt.assemble({ agent: { session }, scope: { session } })
		check('D5 the recall reaches a real prompt assembly', assembly.contexts.some((entry) => entry.text.includes('Project Memory')))
		check('D6 the usage section is registered', assembly.sections.some((section) => section.name === 'project-memory:usage'))
	}

	console.log('\n' + (failures === 0 ? 'ALL ' + checks + ' CHECKS PASSED' : failures + ' of ' + checks + ' CHECKS FAILED'))
	process.exit(failures === 0 ? 0 : 1)
}

await main()
