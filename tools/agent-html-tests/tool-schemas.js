// Shared by the browser suites: an init script that checks every
// NativeKit.agent.invokeTool call agent.html makes against the engine's real
// tool schemas (tests/fixtures/native-tool-schemas.json, kept equal to
// tool_runner.rs by a Rust test) with a copy of the engine's validator. A call
// that breaks a schema is recorded in window.__schemaViolations and rejected
// with the engine's own message, exactly as the native app would.
// The violation is also logged with console.error, so every suite's
// "no console errors" check fails on it. Add it with
// ctx.addInitScript(schemaGuard) AFTER the mocks.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const schemas = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/native-tool-schemas.json'), 'utf8'));
const { validateNativeToolArgs } = require(path.join(ROOT, 'tests/fixtures/validate-native-tool-args.cjs'));

const schemaGuard = `(() => {
  const schemas = ${JSON.stringify(schemas)};
  const validate = ${validateNativeToolArgs.toString()};
  window.__schemaViolations = [];
  window.__toolCallsChecked = 0;
  const wrap = () => {
    const a = window.NativeKit && window.NativeKit.agent;
    if (!a || a.__schemaGuarded || typeof a.invokeTool !== 'function') return;
    const inner = a.invokeTool;
    a.invokeTool = async (name, args) => {
      const parsed = typeof args === 'string' ? JSON.parse(args) : args;
      const error = validate(schemas, name, JSON.parse(JSON.stringify(parsed ?? {})));
      window.__toolCallsChecked++;
      if (error) { window.__schemaViolations.push({ name, args: parsed, error }); console.error('[schema] ' + name + ': ' + error); throw new Error('invokeTool failed: msg=' + error); }
      return inner.call(a, name, args);
    };
    a.__schemaGuarded = true;
  };
  wrap();
  document.addEventListener('DOMContentLoaded', wrap);
})();`;

module.exports = { schemaGuard, schemas, validateNativeToolArgs };
