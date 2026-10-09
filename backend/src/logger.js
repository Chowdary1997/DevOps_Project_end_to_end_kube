'use strict';

// Structured JSON logs. Never log email addresses or tokens.
const write = (level, msg, meta = {}) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...meta });
  (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
};

module.exports = {
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
};
