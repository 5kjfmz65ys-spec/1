const secretPattern = /(token|secret|password|api[_-]?key|authorization|credential|session|qr)/i;

function sanitize(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = secretPattern.test(key) ? '[redacted]' : sanitize(item, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level, message, meta) {
  const entry = { time: new Date().toISOString(), level, message };
  if (meta !== undefined) entry.meta = sanitize(meta);
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const logger = {
  info(message, meta) { write('info', message, meta); },
  warn(message, meta) { write('warn', message, meta); },
  error(message, meta) { write('error', message, meta); }
};
