-- Migration 002: Add device status and firmware tracking columns
--
-- Adds columns and indexes to support:
--   - Firmware version tracking (Requirement 10.1)
--   - Broker connection status tracking (Requirements 10.2, 10.3)
--   - Fast lookup of connected devices (Requirement 10.6)
--
-- All statements use IF NOT EXISTS so this file is idempotent and safe to
-- re-run against an already-migrated database (Requirement 10.5).

ALTER TABLE `device` ADD COLUMN IF NOT EXISTS `firmware_version` varchar(50) DEFAULT NULL;
ALTER TABLE `device` ADD COLUMN IF NOT EXISTS `is_connected` tinyint(1) NOT NULL DEFAULT 0;
ALTER TABLE `device` ADD COLUMN IF NOT EXISTS `last_seen_at` datetime DEFAULT NULL;

CREATE INDEX IF NOT EXISTS `device_is_connected` ON `device` (`is_connected`);
