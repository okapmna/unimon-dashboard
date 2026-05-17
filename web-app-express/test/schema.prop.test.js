'use strict';

// Feature: admin-user-device-management
//
// This file implements three property-based tests against `ensureAdminDeviceTables`:
//
//   - Property 24: schema device punya kolom dan index yang dispesifikasi
//                  (Validates Requirements 10.1, 10.2, 10.3, 10.6)
//   - Property 25: ensure/migration idempoten
//                  (Validates Requirements 10.4, 10.5)
//   - Property 26: ensure tidak men-crash startup pada error ALTER
//                  (Validates Requirements 10.7)
//
// fast-check is used for protocol consistency with the rest of the test suite,
// but these particular properties have no varied input parameters: the schema
// is deterministic and re-running the assertion 100 times against the real DB
// would be slow and pointless. We therefore wrap each property in
// `fc.assert(fc.asyncProperty(fc.constant(0), ...), { numRuns: 1 })`.

// Default the local test runner to the host-mapped MariaDB container.
// MUST be set BEFORE requiring `../src/config/db` (which reads env vars at
// module load time).
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_USER = process.env.DB_USER || 'user_app';
process.env.DB_PASS = process.env.DB_PASS || 'password_app';
process.env.DB_NAME = process.env.DB_NAME || 'unimq';
process.env.DB_PORT = process.env.DB_PORT || '3306';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { pool } = require('../src/config/db');
const { ensureAdminDeviceTables } = require('../src/services/devices');

after(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function showColumn(field) {
  const [rows] = await pool.query('SHOW COLUMNS FROM `device` LIKE ?', [field]);
  return rows[0] || null;
}

async function showAllColumns() {
  const [rows] = await pool.query('SHOW COLUMNS FROM `device`');
  return rows;
}

async function showIndex(keyName) {
  const [rows] = await pool.query(
    'SHOW INDEX FROM `device` WHERE Key_name = ?',
    [keyName]
  );
  return rows;
}

async function showAllIndexes() {
  const [rows] = await pool.query('SHOW INDEX FROM `device`');
  return rows;
}

// `SHOW INDEX` returns volatile statistics (e.g. `Cardinality`) that can drift
// between two consecutive runs even when the schema is identical. Strip the
// fields we don't care about so the idempotence comparison stays meaningful.
function normalizeIndexRow(row) {
  return {
    Table: row.Table,
    Non_unique: row.Non_unique,
    Key_name: row.Key_name,
    Seq_in_index: row.Seq_in_index,
    Column_name: row.Column_name,
    Collation: row.Collation,
    Sub_part: row.Sub_part,
    Packed: row.Packed,
    Null: row.Null,
    Index_type: row.Index_type
  };
}

function normalizeIndexes(rows) {
  return rows.map(normalizeIndexRow);
}

// ---------------------------------------------------------------------------
// Property 24: Schema device punya kolom dan index yang dispesifikasi
// Validates: Requirements 10.1, 10.2, 10.3, 10.6
// ---------------------------------------------------------------------------
test('Property 24: schema device kolom & index sesuai spesifikasi', async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(0), async () => {
      await ensureAdminDeviceTables();

      const fw = await showColumn('firmware_version');
      assert.ok(fw, 'device.firmware_version column must exist');
      assert.match(
        String(fw.Type).toLowerCase(),
        /^varchar\(50\)$/,
        'firmware_version must be VARCHAR(50)'
      );
      assert.equal(fw.Null, 'YES', 'firmware_version must be nullable');
      assert.equal(fw.Default, null, 'firmware_version default must be NULL');

      const ic = await showColumn('is_connected');
      assert.ok(ic, 'device.is_connected column must exist');
      assert.match(
        String(ic.Type).toLowerCase(),
        /^tinyint\(1\)$/,
        'is_connected must be TINYINT(1)'
      );
      assert.equal(ic.Null, 'NO', 'is_connected must be NOT NULL');
      assert.equal(String(ic.Default), '0', 'is_connected default must be 0');

      const ls = await showColumn('last_seen_at');
      assert.ok(ls, 'device.last_seen_at column must exist');
      assert.equal(
        String(ls.Type).toLowerCase(),
        'datetime',
        'last_seen_at must be DATETIME'
      );
      assert.equal(ls.Null, 'YES', 'last_seen_at must be nullable');
      assert.equal(ls.Default, null, 'last_seen_at default must be NULL');

      const indexRows = await showIndex('device_is_connected');
      assert.ok(
        indexRows.length > 0,
        'index `device_is_connected` must exist on `device`'
      );
      assert.equal(
        indexRows[0].Column_name,
        'is_connected',
        'index `device_is_connected` first column must be `is_connected`'
      );
    }),
    { numRuns: 1 }
  );
});

// ---------------------------------------------------------------------------
// Property 25: ensure/migration idempoten
// Validates: Requirements 10.4, 10.5
// ---------------------------------------------------------------------------
test('Property 25: ensureAdminDeviceTables idempoten', async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(0), async () => {
      // Run once to settle state.
      await ensureAdminDeviceTables();

      const columnsBefore = await showAllColumns();
      const indexesBefore = normalizeIndexes(await showAllIndexes());

      // Run a second time; nothing should change.
      await ensureAdminDeviceTables();

      const columnsAfter = await showAllColumns();
      const indexesAfter = normalizeIndexes(await showAllIndexes());

      assert.deepEqual(
        columnsAfter,
        columnsBefore,
        'SHOW COLUMNS FROM device must be unchanged across two ensure runs'
      );
      assert.deepEqual(
        indexesAfter,
        indexesBefore,
        'SHOW INDEX FROM device must be unchanged across two ensure runs'
      );
    }),
    { numRuns: 1 }
  );
});

// ---------------------------------------------------------------------------
// Property 26: ensure tidak men-crash startup pada error ALTER
// Validates: Requirements 10.7
// ---------------------------------------------------------------------------
test('Property 26: ensureAdminDeviceTables no-crash on ALTER failure', async () => {
  await fc.assert(
    fc.asyncProperty(fc.constant(0), async () => {
      const originalQuery = pool.query;
      const originalConsoleError = console.error;

      const errorCalls = [];
      console.error = (...args) => { errorCalls.push(args); };

      // Stub pool.query so the function never makes real DB calls.
      // - SHOW TABLES / SHOW COLUMNS / SHOW INDEX / SELECT → empty result set
      //   (forces ensure to take the "doesn't exist yet" branch and attempt
      //   each ALTER).
      // - The specific ALTER for `firmware_version` rejects with an Error.
      // - Every other DDL/DML query resolves successfully.
      pool.query = async function stubQuery(sql /* , params */) {
        const text = typeof sql === 'string' ? sql : (sql && sql.sql) || '';

        if (
          /ALTER\s+TABLE\s+`?device`?\s+ADD\s+COLUMN\s+`?firmware_version`?/i
            .test(text)
        ) {
          throw new Error('Simulated ALTER failure for firmware_version');
        }

        if (/^\s*(SHOW\s+(TABLES|COLUMNS|INDEX)|SELECT)/i.test(text)) {
          return [[], []];
        }

        return [{ affectedRows: 0, insertId: 0, warningStatus: 0 }, undefined];
      };

      try {
        // Must not throw.
        await assert.doesNotReject(
          () => ensureAdminDeviceTables(),
          'ensureAdminDeviceTables must resolve even when an ALTER fails'
        );

        assert.ok(
          errorCalls.length >= 1,
          'console.error must be called at least once on ALTER failure'
        );
      } finally {
        pool.query = originalQuery;
        console.error = originalConsoleError;
      }
    }),
    { numRuns: 1 }
  );
});
