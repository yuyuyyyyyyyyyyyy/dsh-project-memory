/**
 * Registers `deps-resolver.mjs` for the offline tests.
 *
 * Usage: node --import ./register-deps.mjs test.mjs
 */
import { register } from 'node:module'

register('./deps-resolver.mjs', import.meta.url)
