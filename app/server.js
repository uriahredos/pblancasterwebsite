'use strict';
const config = require('./config');
const db = require('./db');
const app = require('./app');
const auth = require('./auth');
const mail = require('./mail');

// First start on a new host: create the first admin from environment variables.
const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
if (n === 0 && process.env.BOOTSTRAP_ADMIN_USERNAME && process.env.BOOTSTRAP_ADMIN_PASSWORD) {
  auth.createUser({
    username: process.env.BOOTSTRAP_ADMIN_USERNAME.trim(),
    displayName: process.env.BOOTSTRAP_ADMIN_USERNAME.trim(),
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    profile: 'Admin',
    master: true,
  });
  console.log(`Created the master account "${process.env.BOOTSTRAP_ADMIN_USERNAME.trim()}". They must change the password at first sign-in.`);
} else if (n === 0) {
  console.log('No users yet. Run "npm run create-admin -- <username>" to create the first admin.');
}

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set: everyone is signed out whenever the server restarts.');
}

mail.startComplaintDigest();
require('./backup').startNightlyBackups();
app.listen(config.port, () => console.log(`Pye-Barker Lancaster Branch portal listening on port ${config.port}`));
