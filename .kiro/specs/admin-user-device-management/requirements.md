# Requirements Document

## Introduction

Fitur "admin-user-device-management" memperluas kemampuan manajemen perangkat IoT pada UNIMONMQ.
Admin diberi kontrol penuh terhadap CRUD perangkat, perpindahan owner, inspeksi user yang memiliki akses ke perangkat, serta visibilitas status operasional perangkat (versi firmware dan status koneksi broker MQTT). User pemilik (owner) diberi kemampuan untuk membagikan akses (sharing) maupun memindahkan kepemilikan (transfer ownership) ke user lain. Selain itu, alur navigasi pasca-login admin diubah agar admin dapat melihat halaman dashboard utama seperti user biasa, sementara halaman administratif tetap eksklusif berada di bawah path `/admin/*`.

Fitur ini juga menyiapkan mekanisme komunikasi data status (connected/last_seen/firmware) dari `MQTT_Worker` ke `Web_App` melalui MariaDB, sesuai pola repo yang sudah ada (tabel/kolom di-ensure runtime di `services/devices.js` dan/atau migration baru).

## Glossary

- **Web_App**: Layanan Express di `web-app-express/` yang merender dashboard dan halaman admin.
- **MQTT_Worker**: Proses Node.js di `mqtt-worker/` yang membuka koneksi MQTT per perangkat dan menulis ke MariaDB.
- **Device_Manager**: Singleton di `mqtt-worker/src/services/DeviceManager.js` yang mengelola siklus hidup koneksi MQTT.
- **Admin_Panel**: Kumpulan halaman administratif di bawah path `/admin/*`.
- **User_Dashboard**: Halaman `/dashboard` yang menampilkan daftar perangkat milik atau dibagikan ke user.
- **Device_Page**: Halaman kontrol per-perangkat di `/iot/incubator/:deviceId` atau `/iot/smartlamp/:deviceId`.
- **Owner**: User yang nilai `device.user_id` menunjuk ke `user_id`-nya, atau yang memiliki baris di `user_device_access` dengan `access_type = 'owner'`.
- **Viewer**: User yang memiliki baris di `user_device_access` dengan `access_type = 'viewer'` untuk perangkat tertentu.
- **Audit_Logger**: Helper `insertAdminAuditLog(adminId, action, targetType, targetId, details)` di `src/services/audit.js`.
- **Serial_Number**: String 8 karakter heksadesimal huruf besar pada `device.serial_number` yang berperan sebagai identitas publik perangkat.
- **Firmware_Version**: String versi firmware perangkat (mis. `"1.2.3"`) yang dikirim perangkat dalam payload MQTT.
- **Broker_Connection_Status**: Status apakah `Device_Manager` saat ini memiliki sesi MQTT yang terhubung untuk perangkat tertentu, direpresentasikan oleh `device.is_connected` (BOOLEAN) dan `device.last_seen_at` (TIMESTAMP).
- **Connection_Freshness_Window**: Rentang waktu maksimum sejak `last_seen_at` agar perangkat masih dianggap "Connected" oleh `Web_App`. Nilai: 90 detik.
- **Heartbeat_Interval**: Interval `Device_Manager` menulis ulang `last_seen_at` ke database untuk perangkat yang client MQTT-nya tersambung. Nilai: 30 detik.
- **Audit_Action**: String konstan yang dicatat ke `admin_audit_log.action` (mis. `add_device`, `delete_device`, `edit_device`, `transfer_ownership`).

## Requirements

### Requirement 1: Admin CRUD Perangkat

**User Story:** Sebagai admin, saya ingin menambah, mengedit, dan menghapus perangkat dari `Admin_Panel`, agar saya dapat menjaga inventaris perangkat tetap akurat.

#### Acceptance Criteria

1. WHEN admin mengirim form `add_device` dengan `device_name`, `device_type ∈ {'esp32-inkubator', 'esp32-smartlamp'}`, `broker_url`, `broker_port`, dan `owner_id` valid, THE Web_App SHALL membuat baris baru di `device` dengan `Serial_Number` unik 8 karakter heksadesimal huruf besar dan baris pasangan di `device_access_tokens` (`max_uses = 1`).
2. WHEN admin mengirim form `edit_device` dengan `device_id` valid, THE Web_App SHALL memperbarui kolom `device_name`, `device_type`, `broker_url`, `broker_port`, `mq_user`, `mq_pass`, dan `user_id` (owner) sesuai input.
3. WHEN admin mengirim form `delete_device` dengan `device_id` valid, THE Web_App SHALL menghapus baris perangkat tersebut beserta seluruh baris `user_device_access`, `device_access_tokens`, dan `device_logs` yang terkait melalui `ON DELETE CASCADE`.
4. IF input form CRUD perangkat gagal validasi (mis. `device_type` tidak dikenal atau `owner_id` tidak menunjuk ke user yang ada), THEN THE Web_App SHALL membatalkan operasi, tidak melakukan perubahan ke database, dan menampilkan toast bertipe `error` berisi pesan validasi.
5. WHEN operasi CRUD perangkat oleh admin selesai sukses, THE Web_App SHALL memanggil `Audit_Logger` dengan `action ∈ {'add_device', 'edit_device', 'delete_device'}`, `targetType = 'device'`, `targetId = device_id`, dan `details` berisi field-field yang diubah.
6. IF user yang melakukan request CRUD perangkat tidak memiliki `role = 'admin'`, THEN THE Web_App SHALL menolak request dan mengembalikan redirect ke `/dashboard` dengan toast bertipe `error`.

### Requirement 2: Admin Mengubah Owner Perangkat

**User Story:** Sebagai admin, saya ingin mengubah owner sebuah perangkat ke user lain, agar saya dapat memperbaiki kesalahan kepemilikan atau memindahkan perangkat antar user.

#### Acceptance Criteria

1. WHEN admin mengirim aksi ubah owner dengan `device_id` valid dan `new_owner_id` menunjuk ke user yang ada dan berbeda dari owner saat ini, THE Web_App SHALL memperbarui `device.user_id` menjadi `new_owner_id` dalam satu transaksi.
2. WHEN admin mengubah owner perangkat, THE Web_App SHALL menghapus baris `user_device_access` untuk pasangan `(new_owner_id, device_id)` dalam transaksi yang sama, sehingga owner baru tidak ganda muncul sebagai viewer.
3. WHEN ubah owner berhasil, THE Web_App SHALL memanggil `Audit_Logger` dengan `action = 'change_owner'`, `targetType = 'device'`, `targetId = device_id`, dan `details = { old_owner_id, new_owner_id }`.
4. IF `new_owner_id` tidak ditemukan di tabel `user`, THEN THE Web_App SHALL membatalkan operasi dan menampilkan toast bertipe `error`.
5. IF `new_owner_id` sama dengan owner saat ini, THEN THE Web_App SHALL menolak operasi dan menampilkan toast bertipe `error` berisi pesan bahwa owner tidak berubah.

### Requirement 3: Admin Melihat User dengan Akses ke Perangkat

**User Story:** Sebagai admin, saya ingin melihat semua user yang memiliki akses ke sebuah perangkat (owner dan viewer), agar saya dapat mengaudit pembagian akses.

#### Acceptance Criteria

1. WHEN admin membuka halaman detail akses perangkat untuk `device_id` valid, THE Web_App SHALL menampilkan owner saat ini (dari `device.user_id`) dan seluruh user dengan baris di `user_device_access` untuk `device_id` tersebut.
2. THE Web_App SHALL menampilkan untuk setiap baris akses: `user_id`, `user_name`, `access_type ∈ {'owner','viewer'}`, dan `granted_at`.
3. WHERE perangkat tidak memiliki akses tambahan selain owner, THE Web_App SHALL menampilkan owner saja dan label "Tidak ada user lain yang memiliki akses".
4. IF user yang membuka halaman tersebut tidak memiliki `role = 'admin'`, THEN THE Web_App SHALL mengembalikan redirect ke `/dashboard` dengan toast bertipe `error`.
5. WHEN admin menghapus akses viewer melalui halaman ini, THE Web_App SHALL menghapus baris `user_device_access` yang sesuai dan memanggil `Audit_Logger` dengan `action = 'revoke_access'`, `targetType = 'device'`, `targetId = device_id`, dan `details = { revoked_user_id }`.

### Requirement 4: Admin Tetap Bisa Mengakses Dashboard Utama

**User Story:** Sebagai admin, saya ingin diarahkan ke `/dashboard` setelah login (bukan ke `Admin_Panel`), agar saya dapat melihat dashboard utama seperti user biasa, namun tetap dapat mengakses halaman administratif lewat URL `/admin/`.

#### Acceptance Criteria

1. WHEN seorang admin berhasil login melalui form `/`, THE Web_App SHALL membuat sesi dan melakukan redirect ke `/dashboard`.
2. WHEN seorang admin yang sudah memiliki sesi mengirim request ke `/`, THE Web_App SHALL melakukan redirect ke `/dashboard`.
3. WHEN seorang admin yang sudah memiliki sesi mengirim request ke `/dashboard`, THE Web_App SHALL merender halaman dashboard yang sama dengan halaman dashboard user (daftar perangkat user `User_Dashboard`).
4. WHEN seorang admin yang sudah memiliki sesi mengirim request ke `/admin/users` atau path lain di bawah `/admin/*`, THE Web_App SHALL merender halaman administratif yang sesuai.
5. WHILE pengguna memiliki sesi dengan `role = 'admin'` dan berada di `/dashboard`, THE Web_App SHALL menampilkan tautan menuju `/admin/users` (atau `Admin_Panel`).
6. IF user dengan `role = 'user'` mengirim request ke path `/admin/*`, THEN THE Web_App SHALL melakukan redirect ke `/dashboard` dengan toast bertipe `error`.

### Requirement 5: Admin Melihat Status Firmware dan Broker Perangkat

**User Story:** Sebagai admin, saya ingin melihat versi firmware dan status koneksi broker setiap perangkat di `Admin_Panel`, agar saya dapat memantau kesehatan armada perangkat.

#### Acceptance Criteria

1. THE Web_App SHALL menampilkan untuk setiap perangkat di halaman `/admin/devices` kolom `Firmware_Version` (string atau `"unknown"` jika `device.firmware_version IS NULL`).
2. THE Web_App SHALL menampilkan untuk setiap perangkat status `Broker_Connection_Status` dengan nilai `"Connected"` atau `"Disconnected"`.
3. WHEN `Web_App` menentukan `Broker_Connection_Status`, THE Web_App SHALL mengembalikan `"Connected"` jika `device.is_connected = 1` DAN `device.last_seen_at` berada dalam `Connection_Freshness_Window` (90 detik) dari waktu sekarang database, dan `"Disconnected"` selain itu.
4. THE Web_App SHALL menampilkan timestamp `last_seen_at` dalam format yang dapat dibaca manusia, atau `"Belum pernah terhubung"` jika `last_seen_at IS NULL`.
5. WHEN halaman `/admin/devices` dimuat ulang setelah perangkat menjadi terhubung atau terputus di sisi `MQTT_Worker`, THE Web_App SHALL merefleksikan perubahan tersebut tanpa restart proses.

### Requirement 6: User Sharing Akses Perangkat ke User Lain

**User Story:** Sebagai owner perangkat, saya ingin membagikan akses perangkat saya ke user lain melalui menu titik tiga pada kartu perangkat, agar user tersebut dapat melihat data perangkat saya.

#### Acceptance Criteria

1. THE User_Dashboard SHALL menampilkan ikon menu titik tiga pada setiap kartu perangkat dengan `access_type = 'owner'`.
2. WHEN owner membuka menu titik tiga dan memilih "Share", THE Web_App SHALL menampilkan form berisi input `target_username` dan dropdown `access_type ∈ {'viewer'}`.
3. WHEN owner mengirim form share dengan `target_username` yang ada di tabel `user` dan berbeda dari owner, THE Web_App SHALL membuat baris baru di `user_device_access` dengan `(target_user_id, device_id, 'viewer')`.
4. IF `target_username` tidak ditemukan di tabel `user`, THEN THE Web_App SHALL membatalkan operasi dan menampilkan toast bertipe `error` berisi pesan bahwa user tidak ditemukan.
5. IF target user sudah memiliki baris di `user_device_access` untuk `device_id` tersebut, THEN THE Web_App SHALL menolak operasi dan menampilkan toast bertipe `error` berisi pesan bahwa user sudah memiliki akses.
6. IF user yang mengirim request share bukan owner perangkat tersebut (`device.user_id` ≠ `req.session.user.user_id`), THEN THE Web_App SHALL menolak request dengan status 403 dan tidak mengubah database.
7. THE User_Dashboard SHALL menampilkan dalam menu titik tiga daftar viewer aktif untuk perangkat tersebut beserta tombol "Cabut Akses".
8. WHEN owner memilih "Cabut Akses" pada seorang viewer, THE Web_App SHALL menghapus baris `user_device_access` untuk `(viewer_user_id, device_id)`.

### Requirement 7: User Transfer Ownership Perangkat

**User Story:** Sebagai owner perangkat, saya ingin memindahkan kepemilikan perangkat saya ke user lain, agar user tersebut menjadi owner penuh dan saya kehilangan akses owner.

#### Acceptance Criteria

1. WHEN owner mengirim aksi `transfer_ownership` dengan `device_id` yang ia miliki dan `target_username` yang ada di tabel `user` serta berbeda dari owner saat ini, THE Web_App SHALL menjalankan transaksi yang: memperbarui `device.user_id` menjadi `target_user_id`; menghapus baris `user_device_access` untuk `(target_user_id, device_id)` jika ada; dan menyisipkan baris `user_device_access` `(old_owner_id, device_id, 'viewer')` HANYA JIKA owner lama meminta tetap memiliki akses sebagai viewer melalui flag `keep_as_viewer = true`.
2. IF user yang mengirim request transfer bukan owner perangkat tersebut, THEN THE Web_App SHALL menolak request dengan status 403 dan tidak mengubah database.
3. IF `target_username` tidak ditemukan, THEN THE Web_App SHALL membatalkan transaksi dan menampilkan toast bertipe `error`.
4. IF `target_user_id` sama dengan owner saat ini, THEN THE Web_App SHALL menolak operasi dan menampilkan toast bertipe `error` berisi pesan bahwa target sama dengan owner.
5. WHEN transfer ownership berhasil dengan `keep_as_viewer = false`, THE Web_App SHALL memastikan owner lama tidak lagi memiliki baris di `user_device_access` untuk `device_id` tersebut.
6. WHEN transfer ownership berhasil, THE Web_App SHALL menambahkan baris di `admin_audit_log` HANYA JIKA pemicu adalah admin (lihat Requirement 2). Untuk transfer yang dipicu user owner sendiri, THE Web_App SHALL TIDAK menulis ke `admin_audit_log` karena tabel tersebut khusus aksi admin, melainkan mengandalkan integritas transaksi sebagai jejak operasi.
7. WHEN transfer ownership berhasil, THE Web_App SHALL menampilkan toast bertipe `success` kepada owner lama dan melakukan redirect ke `/dashboard`.

### Requirement 8: Pelacakan Status Koneksi Broker oleh MQTT_Worker

**User Story:** Sebagai sistem, saya ingin `MQTT_Worker` melaporkan status koneksi broker setiap perangkat ke MariaDB, agar `Web_App` dapat menampilkan status real-time tanpa membuka koneksi MQTT sendiri.

#### Acceptance Criteria

1. WHEN client MQTT untuk sebuah perangkat memicu event `connect`, THE Device_Manager SHALL menjalankan `UPDATE device SET is_connected = 1, last_seen_at = NOW() WHERE device_id = ?`.
2. WHEN client MQTT untuk sebuah perangkat memicu event `close`, `error`, atau `offline`, THE Device_Manager SHALL menjalankan `UPDATE device SET is_connected = 0 WHERE device_id = ?` tanpa mengubah `last_seen_at`.
3. WHILE client MQTT untuk sebuah perangkat tersambung, THE Device_Manager SHALL memperbarui `last_seen_at = NOW()` setiap `Heartbeat_Interval` (30 detik) untuk perangkat tersebut.
4. WHEN sebuah perangkat dihapus oleh `Device_Manager.syncDevices()` karena tidak lagi ada di tabel `device`, THE Device_Manager SHALL mengakhiri koneksi MQTT-nya tanpa menulis ke `device.is_connected` (karena baris perangkat sudah tidak ada).
5. IF eksekusi UPDATE status gagal karena error database, THEN THE Device_Manager SHALL mencatat pesan error ke `console.error` dan melanjutkan proses tanpa terminasi.

### Requirement 9: Pelacakan Versi Firmware oleh MQTT_Worker

**User Story:** Sebagai sistem, saya ingin `MQTT_Worker` mengekstrak `Firmware_Version` dari payload MQTT dan menyimpannya ke `device.firmware_version`, agar admin dapat melihat versi firmware terkini setiap perangkat.

#### Acceptance Criteria

1. WHEN `MQTT_Worker` menerima pesan pada topik `incubator/{device_id}/data` atau `smartlamp/{device_id}/status` yang berisi field JSON `firmware_version` (string non-kosong), THE Device_Manager SHALL memperbarui `device.firmware_version` dengan nilai tersebut jika berbeda dari nilai saat ini.
2. WHEN `device.firmware_version` diperbarui, THE Device_Manager SHALL menulis baris ke `device_logs` dengan `log_type = 'change_event'` dan `data = { "type": "firmware_version", "old": <nilai_lama>, "new": <nilai_baru> }`.
3. IF payload MQTT bukan JSON yang valid, THEN THE Device_Manager SHALL mencatat error ke `console.error` dan tidak melakukan perubahan pada `device.firmware_version`.
4. IF payload MQTT adalah JSON valid namun tidak mengandung field `firmware_version`, THEN THE Device_Manager SHALL TIDAK mengubah nilai `device.firmware_version` saat ini.
5. WHERE field `firmware_version` dalam payload bertipe non-string atau string kosong, THE Device_Manager SHALL memperlakukannya sebagai field tidak ada (lihat kriteria 4).

### Requirement 10: Skema Database Pendukung dan Auto-Ensure Runtime

**User Story:** Sebagai pengembang, saya ingin perubahan skema database dijalankan secara otomatis dan didokumentasikan sebagai migration, agar fitur ini bekerja konsisten antara lingkungan lokal dan Docker tanpa langkah manual tambahan.

#### Acceptance Criteria

1. THE database SHALL memiliki kolom `device.firmware_version VARCHAR(50) DEFAULT NULL`.
2. THE database SHALL memiliki kolom `device.is_connected TINYINT(1) NOT NULL DEFAULT 0`.
3. THE database SHALL memiliki kolom `device.last_seen_at DATETIME DEFAULT NULL`.
4. WHEN `Web_App` memuat untuk pertama kali setelah deployment, THE Web_App SHALL memanggil `ensureAdminDeviceTables()` di `src/services/devices.js` yang menambahkan kolom-kolom pada kriteria 1–3 jika belum ada (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` atau cek via `columnExists`).
5. THE repository SHALL memiliki file migration baru di `database/migrations/` (mis. `002_device_status_firmware.sql`) yang menerapkan kolom-kolom pada kriteria 1–3 dan idempoten ketika dijalankan ulang.
6. THE migration SHALL menambahkan indeks `KEY device_is_connected (is_connected)` pada tabel `device` untuk mempercepat query daftar perangkat berdasarkan status koneksi.
7. IF `ensureAdminDeviceTables()` gagal mengeksekusi salah satu pernyataan ALTER, THEN THE Web_App SHALL mencatat error ke `console.error` dan melanjutkan startup tanpa crash, mengikuti pola yang sudah ada untuk pernyataan ALTER lainnya.

### Requirement 11: Audit Log untuk Mutasi Admin

**User Story:** Sebagai admin/auditor, saya ingin setiap aksi administratif yang mengubah data tercatat di `admin_audit_log`, agar saya memiliki jejak audit yang dapat ditelusuri.

#### Acceptance Criteria

1. WHEN admin berhasil melakukan aksi `add_device`, `edit_device`, `delete_device`, `change_owner`, atau `revoke_access` pada `Admin_Panel`, THE Web_App SHALL memanggil `Audit_Logger` dengan `admin_id = req.session.user.user_id`, `action` sesuai daftar tersebut, `targetType = 'device'`, `targetId = device_id`, dan `details` berbentuk objek JSON yang merangkum perubahan (mis. field-yang-diubah, nilai lama dan baru).
2. WHEN admin berhasil melakukan aksi `change_role` atau `delete_user` pada user, THE Web_App SHALL memanggil `Audit_Logger` dengan `targetType = 'user'`, `targetId = user_id`, dan `details` yang merangkum perubahan (perilaku eksisting yang harus dipertahankan).
3. IF panggilan ke `Audit_Logger` gagal karena error database, THEN THE Audit_Logger SHALL mencatat error ke `console.error` dan tidak melempar exception ke pemanggil, mengikuti pola yang sudah ada di `src/services/audit.js`.
4. THE admin_audit_log SHALL TIDAK dituliskan oleh aksi yang dipicu user non-admin (sharing dan transfer ownership di Requirement 6 dan 7).
