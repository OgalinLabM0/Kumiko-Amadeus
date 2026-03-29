const fs = require('fs');
const path = require('path');
const express = require('express');
const webpush = require('web-push');
const cors = require('cors');

function loadLocalEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return acc;

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) return acc;

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      acc[key] = value;
      return acc;
    }, {});
}

const localEnv = loadLocalEnvFile(path.join(__dirname, '.env.local'));
const readConfigValue = (name) => {
  const envValue = process.env[name];
  if (typeof envValue === 'string' && envValue.trim()) return envValue.trim();

  const localValue = localEnv[name];
  if (typeof localValue === 'string' && localValue.trim()) return localValue.trim();

  return '';
};

const publicVapidKey = readConfigValue('VAPID_PUBLIC_KEY');
const privateVapidKey = readConfigValue('VAPID_PRIVATE_KEY');
const vapidSubject = readConfigValue('VAPID_SUBJECT') || 'mailto:kumiko-amadeus@local.invalid';

if (!publicVapidKey || !privateVapidKey) {
  console.error('[PING SERVER] Missing VAPID keys.');
  console.error('[PING SERVER] Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY via environment variables or ping-server/.env.local.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

// Identify yourself to push services
webpush.setVapidDetails(
  vapidSubject,
  publicVapidKey,
  privateVapidKey
);

// In-memory store for subscriptions (For production, use a Database like Redis or MongoDB)
let subscriptions = [];

// 1. Endpoint to Receive Push Subscription from Frontend
app.post('/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }

  // Check if we already have it
  const exists = subscriptions.find(sub => sub.endpoint === subscription.endpoint);
  if (!exists) {
    subscriptions.push({ sub: subscription, addedAt: new Date() });
    console.log("New device subscribed! Total devices:", subscriptions.length);
  }

  res.status(201).json({ message: 'Subscribed successfully.' });
});

// 2. Endpoint to manually trigger the "Wake up Ping" to all devices
// In a real app, you would use `setInterval` or `node-cron` here to run automatically
app.post('/trigger-ping', (req, res) => {
  console.log(`Sending ping to ${subscriptions.length} devices...`);

  const payload = JSON.stringify({ 
    directive: 'WAKE_UP',
    timestamp: Date.now() 
  });

  const promises = subscriptions.map(record => {
    return webpush.sendNotification(record.sub, payload)
      .catch(err => {
        console.error("Error sending to a device (Maybe unsubscribed):", err);
        // Optional: Remove invalid subscription from array
        if (err.statusCode === 404 || err.statusCode === 410) {
          subscriptions = subscriptions.filter(s => s.endpoint !== record.sub.endpoint);
        }
      });
  });

  Promise.all(promises).then(() => {
    res.status(200).json({ message: 'Ping sent to all devices.' });
  });
});

// Start the mini server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Kumiko Ping Server is running on port ${PORT}`);
  console.log('VAPID keys loaded successfully.');
  console.log(`Send POST to /subscribe to register a device.`);
  console.log(`Send POST to /trigger-ping to wake them up.`);
});
