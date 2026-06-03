import { config } from '../config.js';
import { discoverVault } from '../ingest/discover.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

export async function printDiscoveryReport(vaultPath = config.vaultPath): Promise<void> {
  const { files, ignored, warnings } = await discoverVault(vaultPath, config.moduleSlug);

  console.log(`\n=== StudyBuddy discovery report ===`);
  console.log(`Vault: ${vaultPath}`);
  console.log(`Module: ${config.moduleName} (${config.moduleSlug})`);
  console.log(`Classified ${files.length} file(s); ignored ${ignored.length}; ${warnings.length} warning(s).\n`);

  console.log(pad('WEEK', 6) + pad('TYPE', 12) + pad('CODE', 6) + pad('KIND', 14) + pad('PRIMARY', 9) + 'FILE → TITLE');
  console.log('-'.repeat(110));
  for (const f of files) {
    console.log(
      pad(f.week === null ? 'null' : String(f.week), 6) +
        pad(f.sourceType, 12) +
        pad(f.code ?? '-', 6) +
        pad(f.kind, 14) +
        pad(f.isPrimary ? 'yes' : 'no', 9) +
        `${f.relPath}  →  ${f.title}`,
    );
  }

  if (ignored.length) {
    console.log(`\n--- Ignored (not fed to any pipeline) ---`);
    for (const i of ignored) console.log(`  ${pad(i.relPath, 40)} ${i.reason}`);
  }
  if (warnings.length) {
    console.log(`\n--- Warnings / unmatched ---`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }

  // Quick per-type / per-week summary.
  const byType = new Map<string, number>();
  for (const f of files) byType.set(f.sourceType, (byType.get(f.sourceType) ?? 0) + 1);
  console.log(`\nBy type: ${[...byType].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  const weeks = [...new Set(files.map((f) => f.week).filter((w) => w !== null))].sort((a, b) => a! - b!);
  console.log(`Weeks present: ${weeks.join(', ')}`);
  console.log('');
}

// Run directly.
const isMain = process.argv[1] && process.argv[1].endsWith('discover.ts');
if (isMain) {
  printDiscoveryReport()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
