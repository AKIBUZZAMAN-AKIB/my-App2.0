#!/usr/bin/env node
import { validateConfig } from './config-lib.mjs';

try {
  const result = await validateConfig();
  console.log('✓ app.config.json schema ও cross-field validation সফল');
  for (const warning of result.warnings) console.warn(`⚠ ${warning}`);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
}
