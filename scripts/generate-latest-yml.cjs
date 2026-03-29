const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(projectRoot, 'package.json');
const releaseDir = path.join(projectRoot, 'release');
const latestYmlPath = path.join(releaseDir, 'latest.yml');

function yamlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function resolveInstallerName(pkg) {
  const configuredName = pkg?.build?.nsis?.artifactName;
  if (typeof configuredName === 'string' && configuredName.trim()) {
    return configuredName.trim();
  }

  const candidates = fs
    .readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .filter((name) => !name.includes('__uninstaller'));

  if (candidates.length === 1) {
    return candidates[0];
  }

  throw new Error(
    `Unable to determine installer artifact in ${releaseDir}. Found: ${candidates.join(', ') || 'none'}`
  );
}

function main() {
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`Release directory not found: ${releaseDir}`);
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = pkg.version;
  const installerName = resolveInstallerName(pkg);
  const installerPath = path.join(releaseDir, installerName);

  if (!fs.existsSync(installerPath)) {
    throw new Error(`Installer artifact not found: ${installerPath}`);
  }

  const buffer = fs.readFileSync(installerPath);
  const sha512 = crypto.createHash('sha512').update(buffer).digest('base64');
  const stat = fs.statSync(installerPath);
  const releaseDate = new Date(stat.mtimeMs).toISOString();

  const content = [
    `version: ${yamlQuote(version)}`,
    'files:',
    `  - url: ${yamlQuote(installerName)}`,
    `    sha512: ${yamlQuote(sha512)}`,
    `    size: ${stat.size}`,
    `path: ${yamlQuote(installerName)}`,
    `sha512: ${yamlQuote(sha512)}`,
    `releaseDate: ${yamlQuote(releaseDate)}`,
    '',
  ].join('\n');

  fs.writeFileSync(latestYmlPath, content, 'utf8');
  console.log(`Generated ${path.relative(projectRoot, latestYmlPath)} for ${installerName}`);
}

main();
