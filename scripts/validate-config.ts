/** Pre-deploy configuration check: cross-validates src/config.ts against
 *  wrangler.toml and prints concrete fixes for anything that would make the
 *  deploy fail — or worse, make the kill switch silently do nothing when it
 *  fires. Run via `pnpm run validate`; `pnpm run deploy` runs it automatically.
 *
 *  Execute with tsx (not plain node): config.ts uses `.js` import specifiers
 *  that Node's type stripping does not resolve to .ts files. */
import { readFileSync } from 'node:fs';
import { parseWranglerToml, validate, type IssueLevel } from './validate-lib.js';

function missing(relative: string, fixes: string[]): never {
  console.error(`ERROR: ${relative.replace('../', '')} not found.`);
  for (const line of fixes) console.error(`  ${line}`);
  process.exit(1);
}

function readOrExit(relative: string, fixes: string[]): string {
  try {
    return readFileSync(new URL(relative, import.meta.url), 'utf8');
  } catch {
    return missing(relative, fixes);
  }
}

const toml = readOrExit('../wrangler.toml', [
  'Fix: copy wrangler.toml.example to wrangler.toml and fill in your IDs,',
  'or run the interactive setup script (setup.ps1 / setup.sh).',
]);

// src/config.ts is untracked and copied from src/config.example.ts, so on a
// fresh clone it does not exist yet. It has to be loaded dynamically, after
// that check: a static import throws at module load, before this script can
// print anything useful.
readOrExit('../src/config.ts', [
  'Fix: copy src/config.example.ts to src/config.ts and edit your thresholds,',
  'or run the interactive setup script (setup.ps1 / setup.sh).',
]);
const { CONFIG } = await import('../src/config.js');

const issues = validate(CONFIG, parseWranglerToml(toml));

const LABEL: Record<IssueLevel, string> = { error: 'ERROR', warning: 'WARNING', note: 'NOTE' };
const ORDER: IssueLevel[] = ['error', 'warning', 'note'];

for (const level of ORDER) {
  for (const issue of issues.filter((i) => i.level === level)) {
    console.log(`${LABEL[level]}: ${issue.title}`);
    for (const line of issue.detail) console.log(`  ${line}`);
    console.log('');
  }
}

const errors = issues.filter((i) => i.level === 'error').length;
const warnings = issues.filter((i) => i.level === 'warning').length;

if (errors > 0) {
  console.error(
    `Config check failed: ${errors} error(s), ${warnings} warning(s). Fix the errors above before deploying.`,
  );
  process.exit(1);
}
console.log(
  warnings > 0 ? `Config check passed with ${warnings} warning(s).` : 'Config check passed.',
);
