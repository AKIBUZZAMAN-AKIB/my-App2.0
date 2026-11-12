import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cap = path.join(root, 'node_modules/@capacitor/cli/bin/capacitor');
const mode = process.argv[2] ?? 'sync';

if (!['init', 'sync'].includes(mode)) {
  console.error('ব্যবহার: node scripts/native-projects.mjs init|sync');
  process.exit(2);
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ['scripts/validate-config.mjs']);
run(process.execPath, ['scripts/prepare-web.mjs', '--target', 'native']);

if (!existsSync(path.join(root, 'android'))) {
  if (mode !== 'init') {
    console.error('android/ নেই—npm run native:init চালান।');
    process.exit(1);
  }
  run(process.execPath, [cap, 'add', 'android']);
}
if (!existsSync(path.join(root, 'ios'))) {
  if (mode !== 'init') {
    console.error('ios/ নেই—npm run native:init চালান।');
    process.exit(1);
  }
  run(process.execPath, [cap, 'add', 'ios']);
}

run(process.execPath, [cap, 'sync']);
run(process.execPath, ['scripts/configure-native.mjs']);
console.log(`✓ Native project ${mode === 'init' ? 'initialize' : 'sync'} সম্পন্ন`);
