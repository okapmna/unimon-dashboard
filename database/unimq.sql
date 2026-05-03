CREATE DATABASE IF NOT EXISTS `unimq`;
USE `unimq`;
SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

-- Table structure for `user`
CREATE TABLE `user` (
  `user_id` int(10) NOT NULL,
  `user_name` varchar(20) NOT NULL,
  `password` varchar(225) NOT NULL,
  `role` enum('admin','user') NOT NULL DEFAULT 'user'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `user` (`user_id`, `user_name`, `password`, `role`) VALUES
(11, 'rusdingawi', '$2y$10$mAlEsUu84Iio1NRM8RmRnuc/SWCe1Yy5aNimQ28JKrUKeYTHAmiL.', 'admin');

-- Table structure for `device`
CREATE TABLE `device` (
  `device_id` int(10) NOT NULL,
  `broker_url` varchar(500) NOT NULL,
  `mq_pass` varchar(20) DEFAULT NULL,
  `mq_user` varchar(20) DEFAULT NULL,
  `device_type` varchar(50) NOT NULL,
  `user_id` int(10) NOT NULL,
  `device_name` varchar(50) NOT NULL,
  `broker_port` varchar(5) NOT NULL,
  `last_logged_values` json DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `device` (`device_id`, `broker_url`, `mq_pass`, `mq_user`, `device_type`, `user_id`, `device_name`, `broker_port`) VALUES
(14, 'test.mosquitto.org', '', '', 'esp32-inkubator', 11, 'Inkubator Ternak 1', '8080'),
(19, '0000000000000000.s1.eu.hivemq.cloud', '54321JJJ', 'itsabirds', 'esp32-inkubator', 11, 'Inkubator burung', '8884');

-- Table structure for `user_tokens`
CREATE TABLE `user_tokens` (
  `id` int(11) NOT NULL,
  `user_id` int(10) NOT NULL,
  `selector` char(12) NOT NULL,
  `hashed_validator` char(64) NOT NULL,
  `expiry` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Indexes and Constraints

-- Indexes for `user`
ALTER TABLE `user`
  ADD PRIMARY KEY (`user_id`);

-- Indexes for `device`
ALTER TABLE `device`
  ADD PRIMARY KEY (`device_id`),
  ADD KEY `user_id` (`user_id`);

-- Indexes for `user_tokens`
ALTER TABLE `user_tokens`
  ADD PRIMARY KEY (`id`),
  ADD KEY `user_id` (`user_id`);

-- AUTO_INCREMENT for `user`
ALTER TABLE `user`
  MODIFY `user_id` int(10) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=12;

-- AUTO_INCREMENT for `device`
ALTER TABLE `device`
  MODIFY `device_id` int(10) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=20;

-- AUTO_INCREMENT for `user_tokens`
ALTER TABLE `user_tokens`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

-- Foreign Key Relationship
ALTER TABLE `device`
  ADD CONSTRAINT `device_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `user` (`user_id`);

ALTER TABLE `user_tokens`
  ADD CONSTRAINT `user_tokens_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `user` (`user_id`) ON DELETE CASCADE;

CREATE TABLE `device_logs` (
  `log_id` bigint(20) NOT NULL AUTO_INCREMENT,
  `device_id` int(10) NOT NULL,
  `data` json NOT NULL,
  `log_type` enum('aggregation','change_event') DEFAULT 'aggregation',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`log_id`),
  CONSTRAINT `device_logs_ibfk_1` FOREIGN KEY (`device_id`) REFERENCES `device` (`device_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `device_access_tokens` (
  `token_id` int(11) NOT NULL AUTO_INCREMENT,
  `device_id` int(10) NOT NULL,
  `token_code` varchar(50) NOT NULL,
  `created_by` int(10) NOT NULL,
  `max_uses` int(11) DEFAULT NULL,
  `current_uses` int(11) DEFAULT 0,
  `expires_at` datetime DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`token_id`),
  UNIQUE KEY `token_code` (`token_code`),
  KEY `device_id` (`device_id`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `device_access_tokens_ibfk_1` FOREIGN KEY (`device_id`) REFERENCES `device` (`device_id`) ON DELETE CASCADE,
  CONSTRAINT `device_access_tokens_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `user_device_access` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `user_id` int(10) NOT NULL,
  `device_id` int(10) NOT NULL,
  `access_type` enum('owner','viewer') NOT NULL,
  `redeemed_via_token_id` int(11) DEFAULT NULL,
  `granted_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `user_device` (`user_id`, `device_id`),
  KEY `user_id` (`user_id`),
  KEY `device_id` (`device_id`),
  KEY `redeemed_via_token_id` (`redeemed_via_token_id`),
  CONSTRAINT `user_device_access_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `user` (`user_id`) ON DELETE CASCADE,
  CONSTRAINT `user_device_access_ibfk_2` FOREIGN KEY (`device_id`) REFERENCES `device` (`device_id`) ON DELETE CASCADE,
  CONSTRAINT `user_device_access_ibfk_3` FOREIGN KEY (`redeemed_via_token_id`) REFERENCES `device_access_tokens` (`token_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `admin_audit_log` (
  `log_id` int(11) NOT NULL AUTO_INCREMENT,
  `admin_id` int(10) NOT NULL,
  `action` varchar(255) NOT NULL,
  `target_type` varchar(50) NOT NULL,
  `target_id` int(11) DEFAULT NULL,
  `details` json DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`log_id`),
  KEY `admin_id` (`admin_id`),
  CONSTRAINT `admin_audit_log_ibfk_1` FOREIGN KEY (`admin_id`) REFERENCES `user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
