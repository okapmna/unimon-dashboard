-- Migration: Device Sharing M:N
-- Membuat junction table device_user untuk many-to-many relationship
-- antara device dan user, menggantikan FK device.user_id

-- 1. Buat junction table
CREATE TABLE IF NOT EXISTS `device_user` (
  `device_id` int(10) NOT NULL,
  `user_id` int(10) NOT NULL,
  `role` enum('owner', 'viewer', 'operator') NOT NULL DEFAULT 'viewer',
  `shared_by` int(10) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`device_id`, `user_id`),
  KEY `user_id` (`user_id`),
  KEY `shared_by` (`shared_by`),
  FOREIGN KEY (`device_id`) REFERENCES `device` (`device_id`) ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `user` (`user_id`) ON DELETE CASCADE,
  FOREIGN KEY (`shared_by`) REFERENCES `user` (`user_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 2. Migrasi data owner existing
INSERT INTO `device_user` (`device_id`, `user_id`, `role`, `shared_by`, `created_at`)
SELECT `device_id`, `user_id`, 'owner', NULL, NOW() FROM `device`;

-- 3. Hapus foreign key dan kolom user_id dari device
ALTER TABLE `device` DROP FOREIGN KEY `device_ibfk_1`;
ALTER TABLE `device` DROP COLUMN `user_id`;
