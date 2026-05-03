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
$serial_column_result = mysqli_query($koneksi, "SHOW COLUMNS FROM device_access_tokens LIKE 'serial_number'");
$has_serial_column = $serial_column_result && mysqli_num_rows($serial_column_result) > 0;
$serial_lookup_clause = $has_serial_column
    ? "serial_number = '$safe_serial_number' OR token_code = '$safe_serial_number'"
    : "token_code = '$safe_serial_number'";

mysqli_begin_transaction($koneksi);
try {
    $sql_serial = "SELECT * FROM device_access_tokens WHERE $serial_lookup_clause LIMIT 1 FOR UPDATE";
    $result_serial = mysqli_query($koneksi, $sql_serial);
    if (!$result_serial) {
        throw new Exception(mysqli_error($koneksi));
    }

    $serial = mysqli_fetch_assoc($result_serial);
    if (!$serial || (int)$serial['is_active'] !== 1) {
        throw new Exception('Invalid or inactive serial number.');
    }

    if ($serial['expires_at'] && strtotime($serial['expires_at']) < time()) {
        $deactivate = mysqli_query($koneksi, "UPDATE device_access_tokens SET is_active = 0 WHERE token_id = '{$serial['token_id']}'");
        if (!$deactivate) {
            throw new Exception(mysqli_error($koneksi));
        }
        mysqli_commit($koneksi);
        $_SESSION['toast'] = ['type' => 'error', 'message' => 'Serial number has expired.'];
        header("Location: ../dashboard.php");
        exit;
    }

    if ($serial['max_uses'] !== null && (int)$serial['current_uses'] >= (int)$serial['max_uses']) {
        $deactivate = mysqli_query($koneksi, "UPDATE device_access_tokens SET is_active = 0 WHERE token_id = '{$serial['token_id']}'");
        if (!$deactivate) {
            throw new Exception(mysqli_error($koneksi));
        }
        mysqli_commit($koneksi);
        $_SESSION['toast'] = ['type' => 'error', 'message' => 'Serial number has reached maximum usage limit.'];
        header("Location: ../dashboard.php");
        exit;
    }

    $device_id = mysqli_real_escape_string($koneksi, $serial['device_id']);
    $sql_owner = "SELECT user_id FROM device WHERE device_id = '$device_id' LIMIT 1";
    $result_owner = mysqli_query($koneksi, $sql_owner);
    if (!$result_owner) {
        throw new Exception(mysqli_error($koneksi));
    }

    $owner = mysqli_fetch_assoc($result_owner);
    if (!$owner) {
        throw new Exception('Device linked to this serial number no longer exists.');
    }

    if ((int)$owner['user_id'] === (int)$safe_user_id) {
        throw new Exception('You already own this device.');
    }

    $sql_access = "SELECT id FROM user_device_access WHERE user_id = '$safe_user_id' AND device_id = '$device_id' LIMIT 1";
    $result_access = mysqli_query($koneksi, $sql_access);
    if (!$result_access) {
        throw new Exception(mysqli_error($koneksi));
    }

    if (mysqli_num_rows($result_access) > 0) {
        throw new Exception('You already have access to this device.');
    }

    $serial_id = mysqli_real_escape_string($koneksi, $serial['token_id']);
    $insert_access = mysqli_query($koneksi, "INSERT INTO user_device_access (user_id, device_id, access_type, redeemed_via_token_id)
                                             VALUES ('$safe_user_id', '$device_id', 'viewer', '$serial_id')");
    if (!$insert_access) {
        throw new Exception(mysqli_error($koneksi));
    }

    $update_serial = mysqli_query($koneksi, "UPDATE device_access_tokens SET current_uses = current_uses + 1 WHERE token_id = '$serial_id'");
    if (!$update_serial) {
        throw new Exception(mysqli_error($koneksi));
    }

    if ($serial['max_uses'] !== null && ((int)$serial['current_uses'] + 1) >= (int)$serial['max_uses']) {
        $deactivate = mysqli_query($koneksi, "UPDATE device_access_tokens SET is_active = 0 WHERE token_id = '$serial_id'");
        if (!$deactivate) {
            throw new Exception(mysqli_error($koneksi));
        }
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
