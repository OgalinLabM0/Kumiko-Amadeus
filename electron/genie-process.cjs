// GPT-SoVITS subprocess lifecycle + `genie:*` IPC handlers. Extracted from
// electron-main.cjs (Plan 8 SubPhase 2.4). This module owns:
//
//   - The single `genieProcess` ChildProcess reference (at most one SoVITS
//     server runs at a time per app instance).
//   - Cross-platform process-tree teardown (Windows taskkill /T vs Linux
//     negative-PID SIGTERM/SIGKILL on the detached process group).
//   - The 6 `genie:*` IPC handlers (pick-sovits-dir, pick-sovits-python,
//     test-sovits-python, start, stop, status).
//
// External interactions kept explicit so nothing silently leaks back into
// electron-main.cjs:
//
//   - `setGenieDialogParent(win)` injects the BrowserWindow used as the
//     native dialog parent + recipient of `genie:status-changed` push
//     events. Called from `createWindow` after `setAppUpdaterWindow`.
//   - `terminateGenieProcess()` is invoked from `electron-main.cjs`'s
//     `will-quit` handler to guarantee the SoVITS server is killed when
//     the app exits, so the detached process group doesn't outlive the
//     parent.
//   - Authorization + fingerprint checks live in
//     ./authorized-paths.cjs — kept as a hard dependency because its
//     registry-backed persistence shouldn't be duplicated here.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, dialog } = require('electron');
const {
  isValidSovitsDir,
  getSovitsDirFingerprintError,
  authorizeSovitsDir,
  isAuthorizedSovitsDir,
  isValidSovitsPython,
  authorizeSovitsPython,
  isAuthorizedSovitsPython,
} = require('./authorized-paths.cjs');

const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

let genieProcess = null;
let genieWindow = null;

function setGenieDialogParent(win) {
  genieWindow = win;
}

function isGenieRunning() {
  return genieProcess !== null;
}

// Cross-platform termination of the detached SoVITS server process tree.
//   - Windows: taskkill with /T walks the process tree (cmd.exe → python.exe →
//     torch worker) and /F forces; this is the same behaviour the pre-Linux
//     code had.
//   - Linux: we spawned with detached:true so the child sits in its own process
//     group. A negative PID signals the whole group, which is how we reach
//     python's own subprocesses (DataLoader workers etc.). SIGTERM first for
//     graceful shutdown, then a SIGKILL backstop 3s later if anything is still
//     hanging. We use process.kill instead of genieProcess.kill because that
//     only signals the immediate child.
function terminateGenieProcess() {
  if (!genieProcess) return;
  const pid = genieProcess.pid;
  if (IS_WINDOWS) {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    } catch { /* nothing actionable if taskkill itself fails */ }
  } else if (pid) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { genieProcess.kill('SIGTERM'); } catch { /* already gone */ }
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 0);
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
      } catch { /* group already exited, nothing to do */ }
    }, 3000).unref();
  }
  genieProcess = null;
}

// User-driven native directory picker. This is the ONLY code path that may add a new
// sovits directory to authorizedSovitsDirs. The dialog requires a human at the keyboard
// to confirm the selection, and the fingerprint check ensures the picked directory is
// really a GPT-SoVITS install. Persisted so the authorization survives app restarts.
async function handlePickSovitsDir() {
  try {
    const result = await dialog.showOpenDialog(genieWindow || undefined, {
      title: 'Select GPT-SoVITS installation directory',
      properties: ['openDirectory'],
      defaultPath: app.getPath('home'),
    });
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, canceled: true };
    }
    const resolved = path.resolve(result.filePaths[0]);
    if (!isValidSovitsDir(resolved)) {
      return { success: false, error: getSovitsDirFingerprintError() };
    }
    authorizeSovitsDir(resolved);
    return { success: true, path: resolved };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Linux/macOS BYO-Python flow: user picks their own python3 interpreter (conda
// env / system python / venv). We persist authorization the same way as the
// sovits install directory, so the approval survives restarts. On Windows this
// IPC is still wired up (the bundled runtime/python.exe remains the default),
// but the Settings UI only surfaces it for Linux users.
async function handlePickSovitsPython() {
  try {
    const result = await dialog.showOpenDialog(genieWindow || undefined, {
      title: IS_LINUX
        ? 'Select the Python interpreter for GPT-SoVITS (e.g. ~/miniconda3/envs/GPTSoVits/bin/python)'
        : 'Select a Python executable for GPT-SoVITS',
      properties: ['openFile'],
      defaultPath: IS_LINUX ? '/usr/bin' : app.getPath('home'),
    });
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, canceled: true };
    }
    const resolved = path.resolve(result.filePaths[0]);
    if (!isValidSovitsPython(resolved)) {
      return {
        success: false,
        error: IS_WINDOWS
          ? 'The selected file is not a valid Python executable.'
          : 'The selected file is not a valid executable Python interpreter. Check that the file exists and has the executable bit set.'
      };
    }
    authorizeSovitsPython(resolved);
    return { success: true, path: resolved };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Smoke-test an authorized python interpreter by spawning `python --version`.
// Surfaces the first line of stdout/stderr back to the renderer so the user can
// confirm they picked the interpreter they thought they did (e.g. the env with
// torch / transformers installed, not system python3.12 that lacks SoVITS deps).
async function handleTestSovitsPython(_event, payload = {}) {
  try {
    const { pythonPath } = payload || {};
    if (!pythonPath || typeof pythonPath !== 'string') {
      return { success: false, error: 'No python interpreter path provided.' };
    }
    const resolved = path.resolve(pythonPath);
    if (!isAuthorizedSovitsPython(resolved)) {
      return { success: false, error: 'This Python interpreter has not been authorized. Please pick it via the Browse dialog first.' };
    }
    if (!isValidSovitsPython(resolved)) {
      return { success: false, error: 'Python interpreter is missing or not executable at this path.' };
    }
    return await new Promise((resolveOuter) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let proc;
      try {
        proc = spawn(resolved, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (spawnErr) {
        resolveOuter({ success: false, error: spawnErr && spawnErr.message ? spawnErr.message : 'Failed to spawn python' });
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        resolveOuter({ success: false, error: 'Timed out waiting for `python --version` output.' });
      }, 5000);
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveOuter({ success: false, error: err && err.message ? err.message : 'Python process error' });
      });
      proc.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Python 2 writes version to stderr, Python 3 writes to stdout — accept either.
        const version = ((stdout || stderr).trim().split(/\r?\n/)[0] || '').trim();
        if (code === 0 && version) {
          resolveOuter({ success: true, version });
        } else {
          resolveOuter({
            success: false,
            error: stderr.trim() || stdout.trim() || `python exited with code ${code}`
          });
        }
      });
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function handleStart(_event, config) {
  if (genieProcess) return { success: false, error: 'Already running' };
  try {
    const { sovitsDir: rawDir, port, gptWeights, vitsWeights, pythonInterpreter: rawPython } = config || {};
    if (!rawDir) return { success: false, error: 'GPT-SoVITS directory not configured' };
    const sovitsDir = path.resolve(rawDir);

    // SECURITY: require the user to have picked this exact directory via the native
    // dialog (genie:pick-sovits-dir) at least once. This blocks a renderer-side
    // attacker from redirecting spawn to an arbitrary attacker-controlled folder
    // whose runtime/python.exe has been swapped for malware.
    if (!isAuthorizedSovitsDir(sovitsDir)) {
      return {
        success: false,
        error: 'This GPT-SoVITS directory has not been authorized. Please click the "Browse" button and pick the install folder via the system dialog.'
      };
    }
    // Re-verify fingerprint at spawn time in case the directory got swapped out
    // after authorization.
    if (!isValidSovitsDir(sovitsDir)) {
      return {
        success: false,
        error: IS_WINDOWS
          ? 'The authorized GPT-SoVITS directory is no longer valid (missing runtime/python.exe, api_v2.py, or GPT_SoVITS/configs/tts_infer.yaml).'
          : 'The authorized GPT-SoVITS directory is no longer valid (missing api_v2.py or GPT_SoVITS/configs/tts_infer.yaml).'
      };
    }

    // Resolve weights paths and require them to live INSIDE the authorized sovitsDir
    // (i.e. files supplied by the SoVITS install itself or a subfolder the user has
    // populated there). This stops a renderer from passing paths to files outside the
    // install, which HTTP /set_*_weights would then load.
    function resolveInsideSovits(p) {
      if (!p) return null;
      // SoVITS accepts both absolute paths and paths relative to its own cwd; resolve
      // relative to sovitsDir so both shapes end up anchored there.
      const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(sovitsDir, p);
      if (abs !== sovitsDir && !abs.startsWith(sovitsDir + path.sep)) return null;
      return abs;
    }
    const resolvedGptWeights = gptWeights ? resolveInsideSovits(gptWeights) : null;
    if (gptWeights && !resolvedGptWeights) {
      return { success: false, error: 'gptWeights must be a path inside the authorized GPT-SoVITS directory.' };
    }
    const resolvedVitsWeights = vitsWeights ? resolveInsideSovits(vitsWeights) : null;
    if (vitsWeights && !resolvedVitsWeights) {
      return { success: false, error: 'vitsWeights must be a path inside the authorized GPT-SoVITS directory.' };
    }

    const apiScript = path.join(sovitsDir, 'api_v2.py');
    const configYaml = path.join(sovitsDir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml');
    const serverPort = port || 9880;

    if (IS_WINDOWS) {
      // Windows path: use the bundled runtime/python.exe launched through a temp
      // .bat wrapper so the user gets a visible console window showing model load
      // progress (SoVITS prints to stdout and this is the simplest way to keep
      // the existing UX). Closing the console window is a user-understood "stop".
      const pythonExe = path.join(sovitsDir, 'runtime', 'python.exe');
      const batPath = path.join(app.getPath('temp'), 'kumiko-sovits-server.bat');
      fs.writeFileSync(batPath, [
        '@echo off',
        'title GPT-SoVITS Server [Kumiko Amadeus]',
        `"${pythonExe}" -u "${apiScript}" -a 127.0.0.1 -p ${serverPort} -c "${configYaml}"`,
      ].join('\r\n'));

      genieProcess = spawn('cmd.exe', ['/c', batPath], {
        cwd: sovitsDir,
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
        env: { ...process.env, PATH: path.join(sovitsDir, 'runtime') + path.delimiter + (process.env.PATH || '') },
      });
    } else if (IS_LINUX) {
      // Linux BYO Python path: no bundled runtime, no .bat wrapper. Spawn the
      // user-supplied python interpreter directly. detached:true + a separate
      // session lets us later kill the whole process group (python plus any
      // child torch workers) via a negative PID SIGTERM/SIGKILL in terminateGenieProcess.
      if (!rawPython) {
        return {
          success: false,
          error: 'Python interpreter path not configured. Pick one via Settings → TTS → GPT-SoVITS → Browse (Python).'
        };
      }
      const pythonExe = path.resolve(rawPython);
      if (!isAuthorizedSovitsPython(pythonExe)) {
        return {
          success: false,
          error: 'Python interpreter has not been authorized. Please re-pick it via the Browse dialog.'
        };
      }
      if (!isValidSovitsPython(pythonExe)) {
        return { success: false, error: 'Python interpreter is missing or not executable at the configured path.' };
      }

      genieProcess = spawn(
        pythonExe,
        ['-u', apiScript, '-a', '127.0.0.1', '-p', String(serverPort), '-c', configYaml],
        {
          cwd: sovitsDir,
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            PATH: [path.join(sovitsDir, 'runtime'), process.env.PATH || ''].filter(Boolean).join(path.delimiter),
          },
        }
      );
    } else {
      return { success: false, error: `GPT-SoVITS is not supported on platform "${process.platform}".` };
    }

    genieProcess.on('exit', (code) => {
      genieProcess = null;
      if (genieWindow && !genieWindow.isDestroyed()) {
        genieWindow.webContents.send('genie:status-changed', { running: false, code });
      }
    });
    genieProcess.on('error', (err) => {
      console.error('[GPT-SoVITS] Process error:', err.message);
      genieProcess = null;
      if (genieWindow && !genieWindow.isDestroyed()) {
        genieWindow.webContents.send('genie:status-changed', { running: false, error: err.message });
      }
    });
    for (let i = 0; i < 180; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (!genieProcess) return { success: false, error: 'Process exited during startup' };
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/tts`, { method: 'GET', signal: AbortSignal.timeout(2000) });
        if (res.status) {
          if (resolvedGptWeights) {
            try { await fetch(`http://127.0.0.1:${serverPort}/set_gpt_weights?weights_path=${encodeURIComponent(resolvedGptWeights)}`); } catch {}
          }
          if (resolvedVitsWeights) {
            try { await fetch(`http://127.0.0.1:${serverPort}/set_sovits_weights?weights_path=${encodeURIComponent(resolvedVitsWeights)}`); } catch {}
          }
          return { success: true, pid: genieProcess.pid };
        }
      } catch {}
    }
    if (genieProcess) {
      return { success: true, pid: genieProcess.pid };
    }
    return { success: false, error: 'Server startup timeout' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function handleStop() {
  terminateGenieProcess();
  return { success: true };
}

function handleStatus() {
  return {
    running: genieProcess !== null,
    pid: genieProcess?.pid || null,
  };
}

module.exports = {
  setGenieDialogParent,
  terminateGenieProcess,
  isGenieRunning,
  handlePickSovitsDir,
  handlePickSovitsPython,
  handleTestSovitsPython,
  handleStart,
  handleStop,
  handleStatus,
};
