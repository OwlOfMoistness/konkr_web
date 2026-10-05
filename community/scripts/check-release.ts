import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const database = process.env.CATALOG_TEST_DATABASE_URL;
if (!database) throw new Error('Set CATALOG_TEST_DATABASE_URL to a disposable local PostgreSQL database. See deploy/README.md.');
await access(chromium.executablePath()).catch(() => {
  throw new Error('Install the local test browser first: npx --no-install playwright install chromium');
});
const pool = new Pool({ connectionString: database, connectionTimeoutMillis: 5000, max: 1 });
try { await pool.query('SELECT 1'); } finally { await pool.end(); }

const fixtures = await mkdtemp(path.join(tmpdir(), 'konkr-release-fixtures-'));
const env = { ...process.env, KONKR_MAP_FIXTURES: fixtures, KONKR_FIXTURE_DIR: fixtures };
async function run(command: string, args: string[], checkCoverage = false): Promise<void> {
  console.log(`\nRunning ${command} ${args.join(' ')}`);
  const child = spawn(command, args, { cwd: root, env, stdio: ['inherit', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    process.stdout.write(chunk);
    if (checkCoverage) output += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
  if (checkCoverage && (!/^# skipped 0$/m.test(output) || /# SKIP\b/i.test(output))) {
    throw new Error('Local release checks require the full test set without skips.');
  }
}

try {
  const { cases } = JSON.parse(await readFile(path.join(root, 'tests/fixtures/base-cases.json'), 'utf8'));
  for (const [id, file] of [['prison-first-turn-normal', 'prison.konkr'], ['gifts-two-turns-normal', 'escalating-quickly.konkr']]) {
    const item = cases.find((item: { id: string; encodedMap?: string }) => item.id === id);
    if (!item?.encodedMap) throw new Error(`Missing committed map: ${id}`);
    await writeFile(path.join(fixtures, file!), item.encodedMap);
  }
  await run('npm', ['run', 'build']);
  await run('npm', ['run', 'build:static']);
  const tests = (await readdir(path.join(root, 'tests'))).filter(file => file.endsWith('.test.ts')).sort();
  if (!tests.length) throw new Error('No test files found');
  await run(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...tests.map(file => `tests/${file}`)], true);
} finally {
  await rm(fixtures, { recursive: true, force: true });
}
