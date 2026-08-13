'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const updater = fs.readFileSync(path.join(root, 'ops/update-evolution.sh'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/publish-evolution-stable.yml'), 'utf8');
const installer = fs.readFileSync(path.join(root, 'ops/install-evolution-auto-update.sh'), 'utf8');

test('Evolution updater accepts only an official stable release', () => {
  assert.match(updater, /evolution-foundation\/evolution-api\/releases\/latest/);
  assert.match(updater, /not r\.get\("draft"\) and not r\.get\("prerelease"\)/);
  assert.match(workflow, /not r\.get\("draft"\) and not r\.get\("prerelease"\)/);
  assert.doesNotMatch(updater, /evolution-api:latest/);
});

test('Evolution updater protects the isolated database and connected instances', () => {
  assert.match(updater, /pg_dump -Fc -U postgres evolution_db/);
  assert.match(updater, /aes-256-cbc -pbkdf2/);
  assert.match(updater, /pg_restore --clean --if-exists/);
  assert.match(updater, /json\.loads\(sys\.argv\[1\]\)==json\.loads\(sys\.argv\[2\]\)/);
  assert.match(updater, /state\.providers\.evolution=/);
});

test('Evolution updater is installed as a persistent daily timer', () => {
  assert.match(installer, /systemctl enable --now mentorian-evolution-auto-update\.timer/);
  assert.match(fs.readFileSync(path.join(root, 'ops/mentorian-evolution-auto-update.timer'), 'utf8'), /Persistent=true/);
});
