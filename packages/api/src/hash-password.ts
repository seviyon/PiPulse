/**
 * Prints a PiPulse password hash for PIPULSE_ADMIN_PASSWORD_HASH_FILE:
 *
 *   node packages/api/dist/hash-password.js > /etc/pipulse/admin.hash
 *
 * Asks twice without echoing. Piped input (two lines) works for scripts.
 */
import { checkNewPassword, hashPassword } from './auth.js';

async function readHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let text = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(text);
          return;
        }
        if (char === '\u0003') {
          process.stderr.write('\n');
          process.exit(130);
        }
        text = char === '\u007f' || char === '\b' ? text.slice(0, -1) : text + char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPiped(): Promise<[string, string]> {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  const [first = '', second = ''] = input.split(/\r?\n/);
  return [first, second];
}

const [first, second] = process.stdin.isTTY
  ? [await readHidden('New PiPulse password: '), await readHidden('Again: ')]
  : await readPiped();
const problem = checkNewPassword(first, second);
if (problem) {
  console.error(problem);
  process.exit(1);
}
// The hash goes to stdout alone, so `> file` captures exactly one line.
console.log(await hashPassword(first));
