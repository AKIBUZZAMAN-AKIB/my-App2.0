// Finds playwright-core without a machine-specific path: PLAYWRIGHT_CORE, then a normal
// require (node_modules here or above, NODE_PATH, a global install), then the old /tmp/pw.
const tries = [process.env.PLAYWRIGHT_CORE, 'playwright-core', 'playwright', '/tmp/pw/node_modules/playwright-core'].filter(Boolean);
let mod = null, last = null;
for (const t of tries) { try { mod = require(t); break; } catch (e) { last = e; } }
if (!mod) { console.error(`playwright-core not found (tried ${tries.join(', ')}). Run: npm i --prefix tools/agent-html-tests playwright-core && npx playwright-core install chromium-headless-shell`); throw last; }
module.exports = mod;
