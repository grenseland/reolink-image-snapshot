#!/usr/bin/env node
/**
 * Quick HTTPS connectivity test for a Reolink hub (uses REOLINK_* from environment).
 * Usage: REOLINK_HOST=192.168.1.100 REOLINK_USERNAME=admin REOLINK_PASSWORD=secret node test-connect.js
 */
'use strict';

const https = require('https');

const host = process.env.REOLINK_HOST;
const username = process.env.REOLINK_USERNAME || 'admin';
const password = process.env.REOLINK_PASSWORD;
const port = parseInt(process.env.REOLINK_PORT || '443', 10);

if (!host || !password) {
  console.error('Set REOLINK_HOST and REOLINK_PASSWORD (and optionally REOLINK_USERNAME).');
  process.exit(1);
}

const agent = new https.Agent({ rejectUnauthorized: false });

const req = https.request({
  hostname: host,
  port,
  path: '/api.cgi?cmd=Login',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  agent,
}, res => {
  console.log('Status:', res.statusCode);
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    try {
      const json = JSON.parse(body);
      const redacted = JSON.stringify(json).replace(/"password"\s*:\s*"[^"]*"/g, '"password":"***"');
      console.log('Body:', redacted);
    } catch {
      console.log('Body:', body.slice(0, 500));
    }
  });
});

req.on('error', e => console.error('Error:', e.message, 'Code:', e.code));
req.write(JSON.stringify([{
  cmd: 'Login',
  action: 0,
  param: { User: { userName: username, password } },
}]));
req.end();
