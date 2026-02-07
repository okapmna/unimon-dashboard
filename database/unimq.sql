-- Hapus database jika sudah ada dan buat baru
CREATE DATABASE IF NOT EXISTS `unimq`;
USE `unimq`;

-- Pengaturan Awal
SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

-- --------------------------------------------------------
-- Struktur Tabel `user`
-- (Dibuat lebih dulu karena menjadi referensi Foreign Key)
-- --------------------------------------------------------

CREATE TABLE `user` (
  `user_id` int(10) NOT NULL,
  `user_name` varchar(20) NOT NULL,
  `password` varchar(225) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `user` (`user_id`, `user_name`, `password`) VALUES
(11, 'rusdingawi', '$2y$10$mAlEsUu84Iio1NRM8RmRnuc/SWCe1Yy5aNimQ28JKrUKeYTHAmiL.');

-- --------------------------------------------------------
-- Struktur Tabel `device`
-- --------------------------------------------------------

CREATE TABLE `device` (
  `device_id` int(10) NOT NULL,
  `broker_url` varchar(500) NOT NULL,
  `mq_pass` varchar(20) DEFAULT NULL,
  `mq_user` varchar(20) DEFAULT NULL,
  `device_type` varchar(50) NOT NULL,
  `user_id` int(10) NOT NULL,
  `device_name` varchar(50) NOT NULL,
  `broker_port` varchar(5) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `device` (`device_id`, `broker_url`, `mq_pass`, `mq_user`, `device_type`, `user_id`, `device_name`, `broker_port`) VALUES
(14, 'test.mosquitto.org', '', '', 'esp32-inkubator', 11, 'Inkubator Ternak 1', '8080'),
(19, '000000000000000.s1.eu.hivemq.cloud', '54321JJJ', 'cihuyyy', 'esp32-inkubator', 11, 'Inkubator burung', '8884');

-- --------------------------------------------------------
-- Indeks dan Constraints
-- --------------------------------------------------------

-- Indeks untuk tabel `user`
ALTER TABLE `user`
  ADD PRIMARY KEY (`user_id`);

-- Indeks untuk tabel `device`
ALTER TABLE `device`
  ADD PRIMARY KEY (`device_id`),
  ADD KEY `user_id` (`user_id`);

-- AUTO_INCREMENT untuk tabel `user`
ALTER TABLE `user`
  MODIFY `user_id` int(10) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=12;

-- AUTO_INCREMENT untuk tabel `device`
ALTER TABLE `device`
  MODIFY `device_id` int(10) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=20;

-- Relasi Foreign Key
ALTER TABLE `device`
  ADD CONSTRAINT `device_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `user` (`user_id`);

COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;