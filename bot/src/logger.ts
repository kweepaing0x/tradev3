import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');

// Ensure log dir exists
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function timestamp(): string {
  return new Date().toISOString();
}

function write(level: string, msg: string) {
  const line = `[${timestamp()}] [${level}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

export const logger = {
  info:  (msg: string) => write('INFO ', msg),
  warn:  (msg: string) => write('WARN ', msg),
  error: (msg: string) => write('ERROR', msg),
  debug: (msg: string) => {
    if (process.env.LOG_LEVEL === 'debug') write('DEBUG', msg);
  },
};
