const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const projectRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(projectRoot, 'package.json');
const releaseDir = path.join(projectRoot, 'release');

// electron-updater channel file naming conventions (see electron-userland/electron-builder):
//   Windows:
//     x64    -> latest.yml          (historical default, no arch suffix)
//     arm64  -> latest-arm64.yml
//   Linux (electron-builder renders ${arch} following uname -m, so x64 -> x86_64):
//     x86_64 -> latest-linux.yml
//     arm64  -> latest-linux-arm64.yml
//
// F2B.5: NSIS artifactName is now `Kumiko-Amadeus-Setup-${arch}-${version}.exe`
// (e.g. `Kumiko-Amadeus-Setup-x64-2.14.0.exe`). The regex accepts an optional
// `-<version>` suffix so this script keeps working against both the new layout
// and any legacy `Kumiko-Amadeus-Setup-<arch>.exe` files left over from older
// builds. The capture group remains the arch only, since that's what feeds
// the `channelFile` lookup.
const PLATFORMS = [
  {
    id: 'win',
    pattern: /^Kumiko-Amadeus-Setup-(x64|arm64)(?:-[0-9]+\.[0-9]+\.[0-9]+(?:[A-Za-z0-9.\-+]*)?)?\.exe$/,
    channelFile: {
      x64: 'latest.yml',
      arm64: 'latest-arm64.yml',
    },
  },
  {
    id: 'linux',
    pattern: /^Kumiko-Amadeus-(x86_64|arm64)\.AppImage$/,
    channelFile: {
      x86_64: 'latest-linux.yml',
      arm64: 'latest-linux-arm64.yml',
    },
  },
];

function yamlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function findArtifactsFor(platform) {
  const found = {};
  for (const entry of fs.readdirSync(releaseDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(platform.pattern);
    if (match) {
      found[match[1]] = entry.name;
    }
  }
  return found;
}

function buildYaml(version, artifactName, buffer, stat) {
  const sha512 = crypto.createHash('sha512').update(buffer).digest('base64');
  const releaseDate = new Date(stat.mtimeMs).toISOString();
  return [
    `version: ${yamlQuote(version)}`,
    'files:',
    `  - url: ${yamlQuote(artifactName)}`,
    `    sha512: ${yamlQuote(sha512)}`,
    `    size: ${stat.size}`,
    `path: ${yamlQuote(artifactName)}`,
    `sha512: ${yamlQuote(sha512)}`,
    `releaseDate: ${yamlQuote(releaseDate)}`,
    '',
  ].join('\n');
}

function main() {
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`Release directory not found: ${releaseDir}`);
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = pkg.version;

  let totalGenerated = 0;
  const perPlatformReport = [];
  for (const platform of PLATFORMS) {
    const artifacts = findArtifactsFor(platform);
    const archs = Object.keys(artifacts);
    if (archs.length === 0) {
      perPlatformReport.push(`  [${platform.id}] no artifacts found, skipping`);
      continue;
    }

    for (const arch of archs) {
      const artifactName = artifacts[arch];
      const channelFile = platform.channelFile[arch];
      if (!channelFile) {
        throw new Error(`Unsupported arch "${arch}" for platform "${platform.id}" — no channel file mapping`);
      }

      const artifactPath = path.join(releaseDir, artifactName);
      const buffer = fs.readFileSync(artifactPath);
      const stat = fs.statSync(artifactPath);
      const content = buildYaml(version, artifactName, buffer, stat);
      const outputPath = path.join(releaseDir, channelFile);
      fs.writeFileSync(outputPath, content, 'utf8');
      console.log(`Generated ${path.relative(projectRoot, outputPath)} for ${artifactName}`);
      totalGenerated += 1;
    }
  }

  if (totalGenerated === 0) {
    const entries = fs
      .readdirSync(releaseDir)
      .filter((n) => /\.(exe|AppImage)$/i.test(n))
      .join(', ');
    throw new Error(
      `No Kumiko-Amadeus installer/AppImage artifacts found in ${releaseDir}.\n` +
        `Expected one of: Kumiko-Amadeus-Setup-{x64|arm64}-<version>.exe or Kumiko-Amadeus-{x86_64|arm64}.AppImage.\n` +
        `Found: ${entries || 'none'}`
    );
  }

  if (perPlatformReport.length) {
    console.log(perPlatformReport.join('\n'));
  }
}

main();
