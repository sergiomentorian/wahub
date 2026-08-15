'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const updater = fs.readFileSync(path.join(root, 'ops/update-waha.sh'), 'utf8');
const installer = fs.readFileSync(path.join(root, 'ops/install-waha-auto-update.sh'), 'utf8');
const timer = fs.readFileSync(path.join(root, 'ops/mentorian-waha-auto-update.timer'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/publish-waha-stable.yml'), 'utf8');

test('WAHA updater accepts only an official stable release', () => {
  assert.match(updater, /releases\/latest/);
  assert.match(updater, /not r\.get\("draft"\) and not r\.get\("prerelease"\)/);
  assert.match(workflow, /not r\.get\("draft"\) and not r\.get\("prerelease"\)/);
  assert.doesNotMatch(workflow, /devlikeapro\/waha:latest(?:\s|$)/);
});

test('WAHA updater protects credentials and restores the exact prior session state', () => {
  assert.match(updater, /WAHA_BACKUP_ENCRYPTION_KEY/);
  assert.match(updater, /openssl enc -aes-256-cbc -pbkdf2 -salt/);
  assert.match(updater, /before_state/);
  assert.match(updater, /json\.loads\(sys\.argv\[1\]\)==json\.loads\(sys\.argv\[2\]\)/);
  assert.match(updater, /rollback automático/);
  assert.match(updater, /waha-rollback\.override\.yml/);
  assert.doesNotMatch(updater, /\/logout|SCAN_QR_CODE|auth\/qr/);
});

test('WAHA updater is installed as a persistent daily timer', () => {
  assert.match(installer, /systemctl enable --now mentorian-waha-auto-update\.timer/);
  assert.match(timer, /OnCalendar=\*-\*-\* 04:30:00 America\/Sao_Paulo/);
  assert.match(timer, /Persistent=true/);
});
