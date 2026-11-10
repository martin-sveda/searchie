import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

/**
 * Smoke tests in a real VS Code (§13.1). `SEARCHIE_VSCODE` = `installed` (local app, no download), `stable`, or a
 * version such as `1.106.0`. Uses a throwaway user-data dir whose settings point Searchie at the fixtures only.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURES = path.join(ROOT, 'src', 'test', 'fixtures', 'vscode');

function installedExecutable(): string {
  if (process.platform === 'darwin') return '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  throw new Error('SEARCHIE_VSCODE=installed is only supported on macOS; use stable or a version');
}

async function main(): Promise<void> {
  const version = process.env.SEARCHIE_VSCODE ?? 'installed';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'searchie-smoke-'));
  const userData = path.join(tmp, 'user-data');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify(
      {
        'searchie.sources.vscode': false,
        'searchie.sources.vscodeInsiders': false,
        'searchie.additionalSessionRoots': [FIXTURES],
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
        'workbench.enableExperiments': false,
        'workbench.startupEditor': 'none',
        'security.workspace.trust.enabled': false,
      },
      null,
      2,
    ),
  );
  const out = process.env.SEARCHIE_SMOKE_OUT ?? path.join(tmp, 'results.json');
  const vscodeExecutablePath = version === 'installed' ? installedExecutable() : await downloadAndUnzipVSCode(version);
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      extensionTestsEnv: { SEARCHIE_SMOKE_OUT: out },
      launchArgs: ['--user-data-dir', userData, '--extensions-dir', path.join(tmp, 'extensions'), '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window'],
    });
    if (fs.existsSync(out)) console.log(fs.readFileSync(out, 'utf8'));
  } finally {
    if (!process.env.SEARCHIE_SMOKE_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  console.error(`smoke tests failed: ${(e as Error).message}`);
  process.exit(1);
});
