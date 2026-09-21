// Local preflight: no network access and no release or file mutations.
const fs = require('node:fs');
const path = require('node:path');

function validateVersions(pkg, lock, gradle, workflow) {
  const errors = [];
  const version = pkg.version;
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) errors.push('package.json: expected a stable MAJOR.MINOR.PATCH version');
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    errors.push('package-lock.json: both root versions must match package.json');
  }
  const androidName = gradle.match(/^\s*versionName\s+"([^"]+)"/m)?.[1];
  const androidCode = Number(gradle.match(/^\s*versionCode\s+(\d+)/m)?.[1]);
  if (androidName !== version) errors.push('Android versionName must match package.json');
  if (!Number.isSafeInteger(androidCode) || androidCode < 1 || androidCode > 2100000000) {
    errors.push('Android versionCode must be a valid positive integer');
  }
  if (pkg.androidVersionCode !== undefined && pkg.androidVersionCode !== androidCode) {
    errors.push('Android versionCode must match package.json androidVersionCode');
  }
  // Restarting the public version must preserve Android upgrade ordering.
  if (/^0\./.test(version || '')) {
    if (!Number.isSafeInteger(pkg.androidVersionCode) || pkg.androidVersionCode <= 21431) {
      errors.push('Restart requires an independent androidVersionCode greater than legacy 21431');
    }
    if (/MAJOR\s*\*\s*10000/.test(workflow)) {
      errors.push('Android CI still derives versionCode from semver; migrate it before restarting');
    }
  }
  return errors;
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const errors = validateVersions(
    JSON.parse(read('package.json')),
    JSON.parse(read('package-lock.json')),
    read('android/app/build.gradle'),
    read('.github/workflows/android-apk-release.yml'),
  );
  if (errors.length) {
    for (const error of errors) console.error(`Version check: ${error}`);
    process.exitCode = 1;
  } else {
    console.log('Version metadata is consistent. This does not verify updater isolation or release assets.');
  }
}

module.exports = { validateVersions };
