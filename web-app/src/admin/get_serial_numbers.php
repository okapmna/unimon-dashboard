<?php
include "auth_check.php";
include "../config/koneksi.php";

header('Content-Type: application/json');

if (!isset($_GET['device_id'])) {
    echo json_encode(['error' => 'Missing device_id']);
    exit;
}

$device_id = mysqli_real_escape_string($koneksi, $_GET['device_id']);
$serial_column_result = mysqli_query($koneksi, "SHOW COLUMNS FROM device_access_tokens LIKE 'serial_number'");
$serial_select = ($serial_column_result && mysqli_num_rows($serial_column_result) > 0)
    ? "COALESCE(serial_number, token_code)"
    : "token_code";

$sql = "SELECT token_id, device_id, $serial_select as serial_number, created_by, max_uses, current_uses, expires_at, is_active, created_at
        FROM device_access_tokens
        WHERE device_id = '$device_id'
        ORDER BY created_at DESC";
$result = mysqli_query($koneksi, $sql);

$serial_numbers = [];
while ($row = mysqli_fetch_assoc($result)) {
    $serial_numbers[] = $row;
}

echo json_encode($serial_numbers);
?>
