/*
 * A JavaScript copy of the native engine's argument checks for built-in tools:
 * validate_schema_value and validate_memory_tool_sizes in
 * plugins/native-agent/rust/native-agent-ffi/src/tool_runner.rs, with the same
 * error messages. The schemas come from tests/fixtures/native-tool-schemas.json,
 * which a Rust test keeps equal to the real definitions.
 *
 * Used by the unit suite (every UI-side invokeTool call site) and injected into
 * the browser suites (every invokeTool call agent.html makes at runtime).
 * Values marked as dynamic (isDynamic) are skipped: the static scan cannot know
 * them, and the browser suites check them for real.
 *
 * Plain script on purpose: it runs in Node (module.exports) and, through
 * Function.prototype.toString, inside a page.
 */
function validateNativeToolArgs(schemas, toolName, args, isDynamic) {
  const dyn = typeof isDynamic === 'function' ? isDynamic : () => false;
  const schema = schemas[toolName];
  if (!schema) return `Unknown tool: ${toolName}`;
  const MEMORY_BYTES = {
    memory_recall: [['query', 8192]],
    memory_search: [['query', 8192]],
    memory_store: [['text', 20000], ['key', 512]],
    memory_forget: [['query', 8192], ['key', 512]],
    memory_list: [['prefix', 512]],
  };
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const utf8Length = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf8'));
  // What serde_json sees: JSON.stringify drops undefined members and functions.
  const isAbsent = (v) => v === undefined || typeof v === 'function' && !dyn(v);

  function check(path, value, s) {
    if (dyn(value)) return null;
    const kind = typeof s.type === 'string' ? s.type : null;
    if (kind) {
      const ok = kind === 'string' ? typeof value === 'string'
        : kind === 'integer' ? typeof value === 'number' && Number.isInteger(value) && !/e/i.test(JSON.stringify(value))
        : kind === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : kind === 'boolean' ? typeof value === 'boolean'
        : kind === 'object' ? isPlainObject(value)
        : kind === 'array' ? Array.isArray(value)
        : true;
      if (!ok) return `Argument '${path}' for '${toolName}' must be ${kind}`;
    }
    if (typeof value === 'string') {
      const chars = [...value].length;
      if ((typeof s.minLength === 'number' && chars < s.minLength) || (typeof s.maxLength === 'number' && chars > s.maxLength)) {
        return `Argument '${path}' for '${toolName}' has an invalid string length`;
      }
    }
    if (Array.isArray(s.enum) && !s.enum.some((c) => sameJson(c, value))) {
      return `Argument '${path}' for '${toolName}' has an unsupported value`;
    }
    if (typeof s.minimum === 'number' || typeof s.maximum === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `Argument '${path}' for '${toolName}' must be numeric`;
      if ((typeof s.minimum === 'number' && value < s.minimum) || (typeof s.maximum === 'number' && value > s.maximum)) {
        return `Argument '${path}' for '${toolName}' is outside its allowed range`;
      }
    }
    if (Array.isArray(value)) {
      if ((typeof s.minItems === 'number' && value.length < s.minItems) || (typeof s.maxItems === 'number' && value.length > s.maxItems)) {
        return `Argument '${path}' for '${toolName}' has an invalid array length`;
      }
      if (s.items) {
        for (let i = 0; i < value.length; i++) {
          const e = check(`${path}[${i}]`, value[i], s.items);
          if (e) return e;
        }
      }
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value).filter((k) => !isAbsent(value[k]));
      if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) return `Argument '${path}' for '${toolName}' has too many properties`;
      const props = isPlainObject(s.properties) ? s.properties : {};
      for (const field of Array.isArray(s.required) ? s.required : []) {
        if (isAbsent(value[field]) || value[field] === null) return `Missing required argument '${path}.${field}' for '${toolName}'`;
      }
      for (const field of keys) {
        const childPath = `${path}.${field}`;
        if (Object.prototype.hasOwnProperty.call(props, field)) {
          const e = check(childPath, value[field], props[field]);
          if (e) return e;
          continue;
        }
        if (s.additionalProperties === false) return `Unexpected argument '${childPath}' for '${toolName}'`;
        if (isPlainObject(s.additionalProperties)) {
          const e = check(childPath, value[field], s.additionalProperties);
          if (e) return e;
        }
      }
    }
    return null;
  }

  const error = check('$', args, schema);
  if (error) return error;
  for (const [field, limit] of MEMORY_BYTES[toolName] || []) {
    const v = args && args[field];
    if (typeof v === 'string' && !dyn(v) && utf8Length(v) > limit) return `Argument '${field}' for '${toolName}' exceeds the ${limit} UTF-8 byte limit`;
  }
  if (args && args.metadata !== undefined && !dyn(args.metadata) && toolName.startsWith('memory_')) {
    const json = JSON.stringify(args.metadata);
    if (json && utf8Length(json) > 16384) return `Argument 'metadata' for '${toolName}' exceeds the 16384 byte limit`;
  }
  return null;
}

if (typeof module !== 'undefined') module.exports = { validateNativeToolArgs };
