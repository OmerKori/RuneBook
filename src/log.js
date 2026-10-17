// A small log file for bug reports: %APPDATA%\runebook\runebook.log (the previous one is kept as .old).
const fs = require('fs');
const path = require('path');

const MAX = 1024 * 1024;
let file = null;

function init(dir) {
  file = path.join(dir, 'runebook.log');
  try {
    if (fs.statSync(file).size > MAX) fs.renameSync(file, `${file}.old`);
  } catch {}
  // Errors and warnings anywhere in the main process end up in the file too.
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { orig(...args); write(level, ...args); };
  }
  process.on('uncaughtException', (err) => write('crash', err && err.stack ? err.stack : String(err)));
  process.on('unhandledRejection', (err) => write('error', 'Unhandled:', err && err.stack ? err.stack : String(err)));
}

function write(level, ...args) {
  if (!file) return;
  const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  try { fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${text}\n`); } catch {}
}

// The last lines of the log, for a bug report.
function tail(lines = 150) {
  try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

module.exports = { init, info: (...a) => write('info', ...a), error: (...a) => write('error', ...a), tail, file: () => file };
