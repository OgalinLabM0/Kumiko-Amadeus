const path = require('path');
try {
  const modulePath = 'D:/MAINSPACE/DOWNLOADS/Broswer/HB/TTTPPP/NEW/测试-03-23/Kumiko-Amadeus/resources/app.asar.unpacked/node_modules/onnxruntime-node';
  const resolved = require.resolve(modulePath);
  console.log('resolved=' + resolved);
  const mod = require(modulePath);
  console.log('node-installed-ok');
} catch (error) {
  console.log('node-installed-fail: ' + error.message);
}
