'use strict';

// Feature: admin-user-device-management
//
// Property 11: Status koneksi efektif = is_connected=1 AND last_seen_at dalam
//              90 detik
// Validates: Requirements 5.2, 5.3
//
// `computeConnectionStatus(isConnected, lastSeenAt, now)` is a pure helper:
// it MUST return 'Connected' if and only if all of the following hold:
//   - isConnected == 1
//   - lastSeenAt is non-null AND parses to a valid Date
//   - (now - lastSeenAt) <= 90_000 ms
// Otherwise it MUST return 'Disconnected'.
//
// This file does not touch the database. It still requires `../src/services/devices`,
// which transitively loads `../src/config/db` and creates a connection pool —
// but the pool is lazy and no query is ever issued here. To make pool creation
// succeed even outside Docker we default DB env vars to a local config below.
// We deliberately do NOT call `pool.end()`: the schema test owns the pool
// lifecycle, and `node --test` runs each test file in a separate process anyway.

process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'user_app';
process.env.DB_PASS = process.env.DB_PASS || 'password_app';
process.env.DB_NAME = process.env.DB_NAME || 'unimq';
process.env.DB_PORT = process.env.DB_PORT || '3306';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { computeConnectionStatus } = require('../src/services/devices');

// ---------------------------------------------------------------------------
// Property 11 (fast-check)
// ---------------------------------------------------------------------------
test('Property 11: computeConnectionStatus matches is_connected=1 AND age<=90s', async () => {
  await fc.assert(
    fc.asyncProperty(
      // is_connected ∈ {0, 1}
      fc.constantFrom(0, 1),
      // ageSeconds: null → use null lastSeenAt; integer → use Date that many seconds in the past.
      // Range 0..200 spans both sides of the 90-second boundary.
      fc.option(fc.integer({ min: 0, max: 200 }), { nil: null, freq: 4 }),
      async (isConnected, ageSeconds) => {
        const now = new Date();
        const lastSeenAt = ageSeconds === null
          ? null
          : new Date(now.getTime() - ageSeconds * 1000);

        const expected = (
          isConnected === 1 &&
          lastSeenAt !== null &&
          ageSeconds <= 90
        ) ? 'Connected' : 'Disconnected';

        const actual = computeConnectionStatus(isConnected, lastSeenAt, now);
        assert.equal(
          actual,
          expected,
          `isConnected=${isConnected}, ageSeconds=${ageSeconds}, ` +
          `lastSeenAt=${lastSeenAt && lastSeenAt.toISOString()}`
        );
      }
    ),
    { numRuns: 100 }
  );
});

// ---------------------------------------------------------------------------
// Hand-rolled boundary / edge cases
// ---------------------------------------------------------------------------
test('boundary: isConnected=1 but lastSeenAt=null → Disconnected', () => {
  const now = new Date();
  assert.equal(computeConnectionStatus(1, null, now), 'Disconnected');
});

test('boundary: isConnected=0 with fresh lastSeenAt → Disconnected', () => {
  const now = new Date();
  const lastSeenAt = new Date(now.getTime() - 1000); // 1s ago
  assert.equal(computeConnectionStatus(0, lastSeenAt, now), 'Disconnected');
});

test('boundary: isConnected=1 ageSeconds=89.9 → Connected', () => {
  const now = new Date();
  const lastSeenAt = new Date(now.getTime() - 89_900); // 89.9s ago
  assert.equal(computeConnectionStatus(1, lastSeenAt, now), 'Connected');
});

test('boundary: isConnected=1 ageSeconds=90.0 exact → Connected', () => {
  const now = new Date();
  const lastSeenAt = new Date(now.getTime() - 90_000); // exactly 90s ago
  assert.equal(computeConnectionStatus(1, lastSeenAt, now), 'Connected');
});

test('boundary: isConnected=1 ageSeconds=90.1 → Disconnected', () => {
  const now = new Date();
  const lastSeenAt = new Date(now.getTime() - 90_100); // 90.1s ago
  assert.equal(computeConnectionStatus(1, lastSeenAt, now), 'Disconnected');
});

test('boundary: lastSeenAt as ISO string at current time → Connected', () => {
  const now = new Date();
  const isoString = now.toISOString();
  assert.equal(computeConnectionStatus(1, isoString, now), 'Connected');
});

test('boundary: lastSeenAt as garbage string → Disconnected', () => {
  const now = new Date();
  assert.equal(computeConnectionStatus(1, 'not-a-date', now), 'Disconnected');
});
