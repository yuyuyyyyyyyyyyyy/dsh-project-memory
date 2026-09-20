/**
 * Test-only storage backend: the shipped `dsh-storage-json` contract with an
 * in-memory medium.
 *
 * The shipped backend is a Cordis plugin that publishes TWO things, and the
 * domain layer depends on both:
 *
 *  1. the lifecycle service key `storage.backend.<name>` — `dsh-storage-domain`'s
 *     `apply` injects `storageBackendServiceKey(config.backend)`, so a backend
 *     that only registers into the hub's registry leaves every domain waiting
 *     forever (the failure mode that looks exactly like "the plugin never
 *     mounted"); and
 *  2. the backend value in `ctx.storage.backend`.
 *
 * The medium is a `Map`, so handing the same map to a second mount is exactly a
 * process restart over the same storage.
 *
 * @module memory-backend
 */

import { Service } from '@deepseek-ai/cordis'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'

/** The backend registry name this plugin serves. */
const BACKEND_NAME = 'memory'

/**
 * The shared medium: the records themselves plus the set of unit names a live
 * handle currently holds. Both travel together, so swapping the medium is
 * exactly "a new process opening the same storage directory".
 */
const medium = { units: new Map(), open: new Set() }

/** Deep-clone through JSON: the durable boundary stores plain data only. */
function clone(value) {
	return JSON.parse(JSON.stringify(value))
}

/**
 * One opened unit over the in-memory medium.
 *
 * `close()` releases the OPEN HANDLE only. The records stay in the medium —
 * exactly like the JSON backend, whose files survive closing the unit. A
 * backend that dropped its records on close would make every restart look like
 * data loss and would hide a real durability bug.
 */
function openUnit(descriptor) {
	const units = medium.units
	if (medium.open.has(descriptor.name)) throw new Error('unit already open: ' + descriptor.name)
	const state = units.get(descriptor.name) ?? { tables: {}, global: null }
	for (const table of descriptor.tables) state.tables[table] ??= {}
	units.set(descriptor.name, state)
	medium.open.add(descriptor.name)
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
			medium.open.delete(descriptor.name)
		},
	}
}

/** The backend value registered in the hub. */
const backend = { kv: { open: (descriptor) => Promise.resolve(openUnit(descriptor)) } }

/** The lifecycle-only service name the domain layer injects for this backend. */
const SERVICE_KEY = storageBackendServiceKey(BACKEND_NAME)

/** A published placeholder: the domain layer injects the key, not the value. */
class BackendLifecycle extends Service {
	constructor(ctx) {
		super(ctx, SERVICE_KEY)
	}
}

const name = 'memory-backend'
const inject = ['storage']

/**
 * Publish the backend lifecycle service and register the backend in the hub.
 * @param ctx - the plugin context.
 */
function apply(ctx) {
	ctx.plugin(BackendLifecycle)
	ctx.storage.backend.register(BACKEND_NAME, backend)
}

export { BACKEND_NAME, SERVICE_KEY, apply, backend, inject, medium, name }
