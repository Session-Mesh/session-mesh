// Stands in for macOS plutil in the installer tests, for the two forms the installer uses:
//   plutil -lint -s FILE                        status 0 when FILE is a valid plist (tests/plist-lib.ts)
//   plutil -extract KEY.PATH raw -o - FILE      prints a string, integer or boolean; status 1 otherwise
//                                               (an array element is addressed by its index: ProgramArguments.0)
import fs from 'node:fs';
import {parsePlist, type PlistValue} from '../plist-lib.ts';

function read(file: string): PlistValue | undefined {
  try { return parsePlist(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

const args = process.argv.slice(2);
if (args.length === 3 && args[0] === '-lint' && args[1] === '-s') {
  process.exit(read(args[2]) === undefined ? 1 : 0);
}
if (args.length === 6 && args[0] === '-extract' && args[2] === 'raw' && args[3] === '-o' && args[4] === '-') {
  let value: PlistValue | undefined = read(args[5]);
  for (const key of args[1].split('.')) {
    if (Array.isArray(value)) value = /^[0-9]+$/.test(key) ? value[Number(key)] : undefined;
    else value = value && typeof value === 'object' ? value[key] : undefined;
  }
  if (value === undefined || typeof value === 'object') process.exit(1);
  process.stdout.write(`${String(value)}\n`);
  process.exit(0);
}
process.exit(97);
