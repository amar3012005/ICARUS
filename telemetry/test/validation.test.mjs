import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEvents } from '../src/validation.js';

const event = {
  schema: 'icarus.telemetry.v1', installation_id: 'b92fd9cb-6e28-4e75-8b51-f8dfbc3c2c58',
  event: 'harness_initialized', version: '0.3.90', os: 'darwin', arch: 'arm64', agent: 'codex',
};

test('accepts the bounded metadata contract', () => {
  assert.deepEqual(parseEvents({ schema: 'icarus.telemetry.v1', events: [event] })[0].agent, 'codex');
});

test('rejects unknown event names and oversized batches', () => {
  assert.equal(parseEvents({ schema: 'icarus.telemetry.v1', events: [{ ...event, event: 'memory_contents' }] }), null);
  assert.equal(parseEvents({ schema: 'icarus.telemetry.v1', events: Array.from({ length: 21 }, () => event) }), null);
});
