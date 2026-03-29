try {
  require('onnxruntime-node');
  console.log('electron-workspace-ok');
} catch (error) {
  console.log(`electron-workspace-fail: ${error.message}`);
}

try {
  require('../release/win-unpacked/resources/app.asar.unpacked/node_modules/onnxruntime-node');
  console.log('electron-packaged-module-ok');
} catch (error) {
  console.log(`electron-packaged-module-fail: ${error.message}`);
}

const { app } = require('electron');
app.whenReady().then(() => app.exit(0));
