'use strict';
// rc.8 test helpers: REAL PostgreSQL and MariaDB servers started on loopback ports in temp directories (no mocks).
// startPostgres() / startMysql() resolve to null when the server binaries are not installed (tests then skip and say so).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitPort(port, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise(r => { const c = net.connect(port, '127.0.0.1', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); });
    if (ok) return true;
    await sleep(150);
  }
  return false;
}
const have = cmd => spawnSync('sh', ['-c', 'command -v ' + cmd], { encoding: 'utf8' }).status === 0;

function pgBin() {
  try { const d = fs.readdirSync('/usr/lib/postgresql').sort().pop(); const b = path.join('/usr/lib/postgresql', d, 'bin'); if (fs.existsSync(path.join(b, 'initdb'))) return b; } catch (_) {}
  return null;
}

const asRoot = process.getuid && process.getuid() === 0;
function runAs(user, cmd, args, opts = {}) {
  return asRoot ? spawnSync('runuser', ['-u', user, '--', cmd, ...args], { encoding: 'utf8', ...opts }) : spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

/** @returns {Promise<null | {host, port, user, password, database, stop():Promise<void>, kind:'postgres'}>} */
async function startPostgres({ password = 'pg-pass-Zk39xQ' } = {}) {
  const bin = pgBin(); if (!bin) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'estratto-pg-'));
  fs.chmodSync(root, 0o755);
  if (asRoot) { spawnSync('chown', ['postgres', root]); }
  const pw = path.join(root, 'pw'); fs.writeFileSync(pw, password); if (asRoot) spawnSync('chown', ['postgres', pw]);
  const data = path.join(root, 'data');
  let r = runAs('postgres', path.join(bin, 'initdb'), ['-D', data, '-A', 'scram-sha-256', '--pwfile=' + pw, '-U', 'estuser', '-E', 'UTF8', '--locale=C.UTF-8']);
  if (r.status !== 0) { r = runAs('postgres', path.join(bin, 'initdb'), ['-D', data, '-A', 'scram-sha-256', '--pwfile=' + pw, '-U', 'estuser', '-E', 'UTF8']); }
  if (r.status !== 0) throw new Error('initdb failed: ' + (r.stderr || r.stdout));
  const port = await freePort();
  r = runAs('postgres', path.join(bin, 'pg_ctl'), ['-D', data, '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${root} -c fsync=off`, '-l', path.join(root, 'log'), '-w', 'start']);
  if (r.status !== 0) throw new Error('pg_ctl start failed: ' + (r.stderr || r.stdout) + fs.readFileSync(path.join(root, 'log'), 'utf8'));
  const srv = {
    kind: 'postgres', host: '127.0.0.1', port, user: 'estuser', password, database: 'postgres', root,
    async stop() { runAs('postgres', path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']); try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} },
  };
  return srv;
}

/** MariaDB (speaks the MySQL protocol) */
async function startMysql({ password = 'my-pass-Qv82LpT' } = {}) {
  const daemon = have('mariadbd') ? 'mariadbd' : (have('mysqld') ? 'mysqld' : null);
  const install = have('mariadb-install-db') ? 'mariadb-install-db' : null;
  if (!daemon || !install) return null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'estratto-my-'));
  const data = path.join(root, 'data');
  const sock = path.join(root, 'my.sock');
  let r = spawnSync(install, ['--no-defaults', '--datadir=' + data, '--user=' + (asRoot ? 'root' : os.userInfo().username), '--auth-root-authentication-method=normal', '--skip-test-db'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('mariadb-install-db failed: ' + (r.stderr || r.stdout));
  const port = await freePort();
  const child = spawn(daemon, ['--no-defaults', '--datadir=' + data, '--socket=' + sock, '--port=' + port, '--bind-address=127.0.0.1', '--skip-networking=0', '--pid-file=' + path.join(root, 'pid'), '--user=' + (asRoot ? 'root' : os.userInfo().username), '--innodb-flush-log-at-trx-commit=0', '--skip-log-bin'], { stdio: 'ignore', detached: false });
  if (!await waitPort(port)) { child.kill(); throw new Error('mariadb did not start'); }
  await sleep(400);
  const cli = have('mariadb') ? 'mariadb' : 'mysql';
  const sql = `CREATE DATABASE IF NOT EXISTS testdb CHARACTER SET utf8mb4; CREATE USER 'estuser'@'%' IDENTIFIED BY '${password}'; CREATE USER 'estuser'@'localhost' IDENTIFIED BY '${password}'; GRANT ALL ON *.* TO 'estuser'@'%'; GRANT ALL ON *.* TO 'estuser'@'localhost'; FLUSH PRIVILEGES;`;
  r = spawnSync(cli, ['--no-defaults', '-uroot', '--socket=' + sock, '-e', sql], { encoding: 'utf8' });
  if (r.status !== 0) { child.kill(); throw new Error('mariadb user setup failed: ' + (r.stderr || r.stdout)); }
  return {
    kind: 'mysql', host: '127.0.0.1', port, user: 'estuser', password, database: 'testdb', root,
    async stop() { child.kill('SIGTERM'); await new Promise(res => { child.once('exit', res); setTimeout(res, 5000); }); try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} },
  };
}

module.exports = { startPostgres, startMysql, freePort, sleep };
