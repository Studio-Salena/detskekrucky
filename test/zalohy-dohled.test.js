// Dohled automatických záloh (deploy/zalohy): simulace selhání v dočasné složce s podvrženými
// příkazy docker/rclone/curl – na skutečné zálohy, server ani e-mail nesahá. Potřebuje bash
// (Linux, Git Bash), jinak se přeskočí.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
const preskocit = bash.error || bash.status !== 0 ? 'bash není k dispozici' : false;

test('dohled záloh: selhání, omezení opakování, obnovení, nezávislá kontrola stáří a kopie mimo server', { skip: preskocit, timeout: 240000 }, () => {
  const r = spawnSync('bash', [path.join(__dirname, '..', 'deploy', 'zalohy', 'test', 'test-zalohy.sh')], { encoding: 'utf8', timeout: 230000 });
  const vystup = (r.stdout || '') + (r.stderr || '');
  assert.equal(r.status, 0, vystup.split('\n').filter(l => l.includes('✖') || l.startsWith('Testu')).join('\n') || vystup.slice(-2000));
  assert.match(vystup, /Testu: \d+, selhalo: 0/);
});
