try {
  require('D:/MAINSPACE/DOWNLOADS/Broswer/HB/TTTPPP/NEW/测试-03-23/Kumiko-Amadeus/resources/app.asar.unpacked/node_modules/onnxruntime-node');
  console.log('electron-installed-ok');
} catch (error) {
  console.log('electron-installed-fail: ' + error.message);
}
const { app } = require('electron');
app.whenReady().then(() => app.exit(0));
