#!/usr/bin/env node
// The full gate: web tests and build (which type-checks the app, service worker and build config), the
// web tests, server and scripts type-checks, server tests, fixture checks, the usage-stats collector, and asset and release-notes checks. Any non-zero exit
// fails it (tsrs exits 2 on type errors).
//
// Every type check is tsrs, which follows TypeScript 7.1. Known blind spot: 7.1 infers destructured
// parameters with a `= {}` default differently (https://github.com/microsoft/TypeScript/issues/64431),
// so it misses some errors that 7.0's tsc reports there. Annotate such parameters' types explicitly.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// No single test takes more than a few seconds, so one that runs for 2 minutes is hung: fail it.
const TEST_TIMEOUT = '--test-timeout=120000';
const run = (command: string, args: string[], cwd = root) => { const { status } = spawnSync(command, args, { cwd, stdio: 'inherit' }); if (status !== 0) process.exit(status ?? 1); };
run('npm', ['test'], path.join(root, 'web'));
run('npm', ['run', 'build'], path.join(root, 'web'));
run('npm', ['run', 'typecheck:tests'], path.join(root, 'web'));
run('npm', ['run', 'typecheck'], path.join(root, 'server'));
run('node', ['--test', TEST_TIMEOUT, ...readdirSync(path.join(root, 'server')).filter((name) => name.endsWith('.test.mts'))], path.join(root, 'server'));
run('node', ['--test', TEST_TIMEOUT, 'scripts/fixture.test.mts']);
// The usage-stats collector (telemetry/), a Cloudflare Worker: its type check and tests.
run(path.join(root, 'server', 'node_modules', '.bin', 'tsrs'), ['-p', 'telemetry/tsconfig.json']);
run('node', ['--test', TEST_TIMEOUT, 'telemetry/test/worker.test.ts']);
run('node', ['--test', TEST_TIMEOUT, 'scripts/verify-assets.test.mts', 'scripts/release-notes.test.mts']);
console.log('All checks passed.');
