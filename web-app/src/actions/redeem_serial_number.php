<?php
$isSecure = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') ||
            (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https');
session_start([
    'cookie_httponly' => true,
    'cookie_secure' => $isSecure,
    'cookie_samesite' => 'Strict',
    'cookie_lifetime' => 60 * 60 * 24 * 30,
    'use_strict_mode' => true,
]);

if (!isset($_SESSION['username']) || !isset($_POST['add_serial_device'])) {
    header("Location: ../dashboard.php");
    exit;
}

include "../config/koneksi.php";

function columnExists($koneksi, $table, $column) {
    $safe_table = mysqli_real_escape_string($koneksi, $table);
    $safe_column = mysqli_real_escape_string($koneksi, $column);
    $result = mysqli_query($koneksi, "SHOW COLUMNS FROM `$safe_table` LIKE '$safe_column'");
    return $result && mysqli_num_rows($result) > 0;
}

function indexExists($koneksi, $table, $index) {
    $safe_table = mysqli_real_escape_string($koneksi, $table);
    $safe_index = mysqli_real_escape_string($koneksi, $index);
    $result = mysqli_query($koneksi, "SHOW INDEX FROM `$safe_table` WHERE Key_name = '$safe_index'");
    return $result && mysqli_num_rows($result) > 0;
}

function generateUniqueDeviceSerialNumber($koneksi) {
    do {
        $serial_number = strtoupper(bin2hex(random_bytes(4)));
        $safe_serial_number = mysqli_real_escape_string($koneksi, $serial_number);
        $existing = mysqli_query($koneksi, "SELECT device_id FROM device WHERE serial_number = '$safe_serial_number' LIMIT 1");
    } while ($existing && mysqli_num_rows($existing) > 0);

    return $serial_number;
}

function ensureDeviceSerialNumbers($koneksi) {
    if (!columnExists($koneksi, 'device', 'serial_number')) {
        mysqli_query($koneksi, "ALTER TABLE `device` ADD COLUMN `serial_number` varchar(50) DEFAULT NULL AFTER `device_name`");
    }

    $missing = mysqli_query($koneksi, "SELECT device_id FROM device WHERE serial_number IS NULL OR serial_number = ''");
    if ($missing) {
        while ($device = mysqli_fetch_assoc($missing)) {
            $safe_device_id = mysqli_real_escape_string($koneksi, $device['device_id']);
            $serial_number = generateUniqueDeviceSerialNumber($koneksi);
            $safe_serial_number = mysqli_real_escape_string($koneksi, $serial_number);
            mysqli_query($koneksi, "UPDATE device SET serial_number = '$safe_serial_number' WHERE device_id = '$safe_device_id'");
        }
    }

    if (!indexExists($koneksi, 'device', 'device_serial_number')) {
        mysqli_query($koneksi, "ALTER TABLE `device` ADD UNIQUE KEY `device_serial_number` (`serial_number`)");
    }
}

ensureDeviceSerialNumbers($koneksi);

$user_id = $_SESSION['user_id'] ?? null;
if (!$user_id) {
    $username = mysqli_real_escape_string($koneksi, $_SESSION['username']);
    $user_result = mysqli_query($koneksi, "SELECT user_id FROM user WHERE user_name = '$username' LIMIT 1");
    $user = $user_result ? mysqli_fetch_assoc($user_result) : null;
    $user_id = $user['user_id'] ?? null;
    if ($user_id) {
        $_SESSION['user_id'] = $user_id;
    }
}

$serial_number = strtoupper(trim($_POST['serial_number'] ?? ''));
if (!$user_id || $serial_number === '') {
    $_SESSION['toast'] = ['type' => 'error', 'message' => 'Invalid serial number.'];
    header("Location: ../dashboard.php");
    exit;
}

$safe_serial_number = mysqli_real_escape_string($koneksi, $serial_number);
$safe_user_id = mysqli_real_escape_string($koneksi, $user_id);

mysqli_begin_transaction($koneksi);
try {
    $sql_device = "SELECT device_id, user_id FROM device WHERE serial_number = '$safe_serial_number' LIMIT 1 FOR UPDATE";
    $result_device = mysqli_query($koneksi, $sql_device);
    if (!$result_device) {
        throw new Exception(mysqli_error($koneksi));
    }

    $device = mysqli_fetch_assoc($result_device);
    if (!$device) {
        throw new Exception('Invalid serial number.');
    }

    if ((int)$device['user_id'] === (int)$safe_user_id) {
        throw new Exception('You already own this device.');
    }

    $device_id = mysqli_real_escape_string($koneksi, $device['device_id']);
    $sql_access = "SELECT id FROM user_device_access WHERE user_id = '$safe_user_id' AND device_id = '$device_id' LIMIT 1";
    $result_access = mysqli_query($koneksi, $sql_access);
    if (!$result_access) {
        throw new Exception(mysqli_error($koneksi));
    }

    if (mysqli_num_rows($result_access) > 0) {
        throw new Exception('You already have access to this device.');
    }

    $insert_access = mysqli_query($koneksi, "INSERT INTO user_device_access (user_id, device_id, access_type, redeemed_via_token_id)
                                             VALUES ('$safe_user_id', '$device_id', 'viewer', NULL)");
    if (!$insert_access) {
        throw new Exception(mysqli_error($koneksi));
    }

    mysqli_commit($koneksi);
    $_SESSION['toast'] = ['type' => 'success', 'message' => 'Device successfully added to your dashboard!'];
} catch (Exception $e) {
    mysqli_rollback($koneksi);
    $_SESSION['toast'] = ['type' => 'error', 'message' => $e->getMessage()];
}

header("Location: ../dashboard.php");
exit;
?>
