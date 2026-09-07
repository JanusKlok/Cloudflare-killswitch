/** Pre-deploy configuration check: cross-validates src/config.ts against
 *  wrangler.toml and prints concrete fixes for anything that would make the
 *  deploy fail — or worse, make the kill switch silently do nothing when it
 *  fires. Run via `pnpm run validate`; `pnpm run deploy` runs it automatically.
 *
 *  Execute with tsx (not plain node): config.ts uses `.js` import specifiers
 *  that Node's type stripping does not resolve to .ts files. */
import { readFileSync } from 'node:fs';
import { CONFIG } from '../src/config.js';
import { parseWranglerToml, validate, type IssueLevel } from './validate-lib.js';

const tomlUrl = new URL('../wrangler.toml', import.meta.url);
let toml: string;
try {
  toml = readFileSync(tomlUrl, 'utf8');
} catch {
  console.error('ERROR: wrangler.toml not found.');
  console.error('  Fix: copy wrangler.toml.example to wrangler.toml and fill in your IDs,');
  console.error('  or run the interactive setup script (setup.ps1 / setup.sh).');
  process.exit(1);
}

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
