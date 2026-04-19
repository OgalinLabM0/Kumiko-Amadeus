#!/usr/bin/env node
// Read-only probe of the HKCU:\Software\KumikoAIAmadeus registry slot,
// mirroring electron-main.cjs::readRegistryValue exactly. Prints whatever is
// currently stored there so we can eyeball the registry → JSON migration path
// before shipping a new install. Doesn't write or delete anything.
//
// Usage: node scripts/probe-registry.cjs

const { execFileSync } = require('child_process');
const path = require('path');

if (process.platform !== 'win32') {
  console.log('not on Windows, nothing to probe');
  process.exit(0);
}

const POWERSHELL_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const USER_DATA_REGISTRY_KEY = 'HKCU:\\Software\\KumikoAIAmadeus';
const KEYS = [
  'UserDataPath',
  'PendingMigrationSource',
  'PendingMigrationTarget',
  'AutoZipBackupEnabled',
];

function readRegistryValue(valueName) {
  try {
    const output = execFileSync(
      POWERSHELL_PATH,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-ItemProperty -Path '${USER_DATA_REGISTRY_KEY.replace(/'/g, "''")}' -Name '${valueName.replace(/'/g, "''")}').${valueName}`,
      ],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const value = output.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

console.log(`Probing ${USER_DATA_REGISTRY_KEY} on this machine:`);
let any = false;
for (const k of KEYS) {
  const v = readRegistryValue(k);
  console.log(`  ${k.padEnd(24)} = ${v === null ? '(not set)' : JSON.stringify(v)}`);
  if (v !== null) any = true;
}
if (!any) {
  console.log('\n=> No legacy values found. Fresh-install migration path will write an empty marker.');
} else {
  console.log('\n=> Legacy values present. Upgrade path will carry them into kumiko-config.json.');
}
