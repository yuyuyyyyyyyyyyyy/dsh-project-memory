/**
 * Resolve `@deepseek-ai/*` and `zod` from ONE installed DSH dependency mirror.
 *
 * The plugin under test lives in the session workspace, where no `node_modules`
 * exists. In production it lives under `$DSH_HOME/profiles/`, which Node's
 * upward `node_modules` walk reaches. This hook reproduces that resolution for
 * an out-of-tree copy.
 *
 * The redirect must cover BOTH the test files and everything under the mirror:
 * a single copy of `@deepseek-ai/cordis` has to back the whole tree, because two
 * copies give two registries and every service lookup then crosses a boundary
 * that does not exist.
 *
 * Set DSH_PLUGIN_DEPS to the dependency mirror root; set DSH_PLUGIN_DEBUG=1 to
 * print every redirect.
 */
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve as resolvePath, dirname } from 'node:path'

const MIRROR = process.env.DSH_PLUGIN_DEPS
if (MIRROR === undefined || MIRROR.length === 0) throw new Error('DSH_PLUGIN_DEPS is not set')
const mirrorRoot = normalize(resolvePath(MIRROR))
const here = normalize(dirname(fileURLToPath(import.meta.url)))
// Anchor on a real file OF the mirror. `$DSH_HOME/profiles/node_modules` is a
// fallback directory whose entries are symlinks/proxies into the installation,
// so anchoring on a synthetic path there resolves back out to the npx cache.
const anchor = pathToFileURL(resolvePath(MIRROR, '@deepseek-ai/dsh-tools/package.json')).href
const require = createRequire(anchor)
const DEBUG = process.env.DSH_PLUGIN_DEBUG === '1'

/** Lowercase a path and use forward slashes, for a case-insensitive prefix test on Windows. */
function normalize(path) {
	return String(path).replace(/\\/g, '/').toLowerCase()
}

/** Prefixes every one of which must resolve from the mirror. */
const OWNED = ['@deepseek-ai/', 'zod']

/** Set by the hook's own first evaluation; the entry point that started the process. */
let entryURL

/** Whether one specifier must be resolved from the mirror rather than by the plain walk. */
function owned(specifier) {
	return OWNED.some((prefix) => specifier === prefix.replace(/\/$/, '') || specifier.startsWith(prefix))
}

/** Whether one importing file participates in this mirror's dependency set. */
function participates(parentURL) {
	if (parentURL === undefined || parentURL.startsWith('file:') === false) return false
	if (parentURL === entryURL) return true
	const path = normalize(fileURLToPath(parentURL))
	return path.startsWith(mirrorRoot) || path.startsWith(here + '/')
}

export async function resolve(specifier, context, nextResolve) {
	entryURL ??= context.parentURL
	if (!owned(specifier) || !participates(context.parentURL)) return nextResolve(specifier, context)
	let target
	try {
		target = require.resolve(specifier)
	} catch {
		return nextResolve(specifier, context)
	}
	if (DEBUG) console.error('[resolve] ' + specifier + '  <-  ' + context.parentURL + '\n           => ' + target)
	return { url: pathToFileURL(target).href, shortCircuit: true }
}
