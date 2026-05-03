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

if (!isset($_SESSION['username']) || !isset($_POST['redeem'])) {
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

$token_code = strtoupper(trim($_POST['token_code'] ?? ''));
if (!$user_id || $token_code === '') {
    $_SESSION['toast'] = ['type' => 'error', 'message' => 'Invalid device code.'];
    header("Location: ../dashboard.php");
    exit;
}

$safe_token_code = mysqli_real_escape_string($koneksi, $token_code);
$safe_user_id = mysqli_real_escape_string($koneksi, $user_id);

mysqli_begin_transaction($koneksi);
try {
    $sql_token = "SELECT * FROM device_access_tokens WHERE token_code = '$safe_token_code' LIMIT 1 FOR UPDATE";
    $result_token = mysqli_query($koneksi, $sql_token);
    if (!$result_token) {
        throw new Exception(mysqli_error($koneksi));
    }

    $token = mysqli_fetch_assoc($result_token);
    if (!$token || (int)$token['is_active'] !== 1) {
        throw new Exception('Invalid or inactive device code.');
    }

    if ($token['expires_at'] && strtotime($token['expires_at']) < time()) {
        $deactivate = mysqli_query($koneksi, "UPDATE device_access_tokens SET is_active = 0 WHERE token_id = '{$token['token_id']}'");
        if (!$deactivate) {
            throw new Exception(mysqli_error($koneksi));
        }
        mysqli_commit($koneksi);
        $_SESSION['toast'] = ['type' => 'error', 'message' => 'Device code has expired.'];
        header("Location: ../dashboard.php");
        exit;
    }

    if ($token['max_uses'] !== null && (int)$token['current_uses'] >= (int)$token['max_uses']) {
        $deactivate = mysqli_query($koneksi, "UPDATE device_access_tokens SET is_active = 0 WHERE token_id = '{$token['token_id']}'");
        if (!$deactivate) {
            throw new Exception(mysqli_error($koneksi));
        }
        mysqli_commit($koneksi);
        $_SESSION['toast'] = ['type' => 'error', 'message' => 'Device code has reached maximum usage limit.'];
        header("Location: ../dashboard.php");
        exit;
    }

    $device_id = mysqli_real_escape_string($koneksi, $token['device_id']);
    $sql_owner = "SELECT user_id FROM device WHERE device_id = '$device_id' LIMIT 1";
    $result_owner = mysqli_query($koneksi, $sql_owner);
    if (!$result_owner) {
        throw new Exception(mysqli_error($koneksi));
    }

    $owner = mysqli_fetch_assoc($result_owner);
    if (!$owner) {
        throw new Exception('Device linked to this code no longer exists.');
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

    $token_id = mysqli_real_escape_string($koneksi, $token['token_id']);
    $insert_access = mysqli_query($koneksi, "INSERT INTO user_device_access (user_id, device_id, access_type, redeemed_via_token_id)
                                             VALUES ('$safe_user_id', '$device_id', 'viewer', '$token_id')");
    if (!$insert_access) {
        throw new Exception(mysqli_error($koneksi));
    }

    $update_token = mysqli_query($koneksi, "UPDATE device_access_tokens SET current_uses = current_uses + 1 WHERE token_id = '$token_id'");
    if (!$update_token) {
        throw new Exception(mysqli_error($koneksi));
    }

    if ($token['max_uses'] !== null && ((int)$token['current_uses'] + 1) >= (int)$token['max_uses']) {
        $deactivate = mysqli_query($koneksi, "UPDATE device_access_tokens SET is_active = 0 WHERE token_id = '$token_id'");
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
