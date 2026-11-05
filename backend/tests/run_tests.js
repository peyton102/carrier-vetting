// One-command test runner.
// Usage (from project root):  node backend/tests/run_tests.js
//        (from backend/):     npm test
// Flags:
//   --rules-only   run rule tests only (required before every push)
//   --live-only    run live SAFER checks only

import { runAll as runRules } from './rules.test.js';
import { runAll as runLive  } from './live.test.js';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[1m', D = '\x1b[2m', X = '\x1b[0m';

const args       = process.argv.slice(2);
const rulesOnly  = args.includes('--rules-only');
const liveOnly   = args.includes('--live-only');

function sep(title) {
  const pad = Math.max(0, 58 - title.length);
  console.log(`\n${B}── ${title} ${'─'.repeat(pad)}${X}`);
}

function row({ name, pass, skip, error }) {
  if (skip)       console.log(`  ${Y}SKIP${X}  ${name}${error ? `  ${D}(${error})${X}` : ''}`);
  else if (pass)  console.log(`  ${G}PASS${X}  ${name}`);
  else            console.log(`  ${R}FAIL${X}  ${name}${error ? `\n        ${D}${error}${X}` : ''}`);
}

async function main() {
  let anyFailed = false;
  let totalPass = 0, totalRun = 0;

  if (!liveOnly) {
    sep('Rule tests (offline)');
    const rs = await runRules();
    rs.forEach(r => { row(r); if (!r.skip) { totalRun++; if (r.pass) totalPass++; else anyFailed = true; } });
    console.log(`\n  ${rs.filter(r => r.pass).length}/${rs.filter(r => !r.skip).length} passed`);
  }

  if (!rulesOnly) {
    sep('Live SAFER checks (read-only)');
    const ls = await runLive();
    ls.forEach(r => { row(r); if (!r.skip) { totalRun++; if (r.pass) totalPass++; else anyFailed = true; } });
    const skipped = ls.filter(r => r.skip).length;
    console.log(`\n  ${ls.filter(r => r.pass).length}/${ls.filter(r => !r.skip).length} passed` +
      (skipped ? `, ${skipped} skipped (network unavailable)` : ''));
  }

  sep('Summary');
  if (!anyFailed) {
    console.log(`  ${G}${B}ALL ${totalPass} TESTS PASSED${X}\n`);
  } else {
    const failed = totalRun - totalPass;
    console.log(`  ${R}${B}${failed} FAILED, ${totalPass} passed${X}\n`);
  }

  process.exit(anyFailed ? 1 : 0);
}

main().catch(e => {
  console.error(`\n${R}Test runner crashed:${X}`, e);
  process.exit(1);
});
