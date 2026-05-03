<?php
include "auth_check.php";
include "../config/koneksi.php";

$username = $_SESSION['username'];
$admin_id = $_SESSION['user_id'] ?? null;
if (!$admin_id) {
    $safe_username = mysqli_real_escape_string($koneksi, $username);
    $admin_result = mysqli_query($koneksi, "SELECT user_id FROM user WHERE user_name = '$safe_username' LIMIT 1");
    $admin = $admin_result ? mysqli_fetch_assoc($admin_result) : null;
    $admin_id = $admin['user_id'] ?? null;
    if ($admin_id) {
        $_SESSION['user_id'] = $admin_id;
    }
}
if (!$admin_id && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $_SESSION['toast'] = ['type' => 'error', 'message' => 'Admin session is incomplete. Please log in again.'];
    header("Location: ../logout.php");
    exit;
}

function ensureAdminDeviceTables($koneksi) {
    $schema_queries = [
        "CREATE TABLE IF NOT EXISTS `device_access_tokens` (
          `token_id` int(11) NOT NULL AUTO_INCREMENT,
          `device_id` int(10) NOT NULL,
          `token_code` varchar(50) NOT NULL,
          `serial_number` varchar(50) DEFAULT NULL,
          `created_by` int(10) NOT NULL,
          `max_uses` int(11) DEFAULT NULL,
          `current_uses` int(11) DEFAULT 0,
          `expires_at` datetime DEFAULT NULL,
          `is_active` tinyint(1) DEFAULT 1,
          `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (`token_id`),
          UNIQUE KEY `token_code` (`token_code`),
          UNIQUE KEY `serial_number` (`serial_number`),
          KEY `device_id` (`device_id`),
          KEY `created_by` (`created_by`),
          CONSTRAINT `device_access_tokens_ibfk_1` FOREIGN KEY (`device_id`) REFERENCES `device` (`device_id`) ON DELETE CASCADE,
          CONSTRAINT `device_access_tokens_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `user` (`user_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci",
        "CREATE TABLE IF NOT EXISTS `user_device_access` (
          `id` int(11) NOT NULL AUTO_INCREMENT,
          `user_id` int(10) NOT NULL,
          `device_id` int(10) NOT NULL,
          `access_type` ENUM('owner', 'viewer') NOT NULL,
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci",
        "CREATE TABLE IF NOT EXISTS `admin_audit_log` (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci"
    ];

    foreach ($schema_queries as $query) {
        if (!mysqli_query($koneksi, $query)) {
            error_log('Admin device schema check failed: ' . mysqli_error($koneksi));
            return false;
        }
    }

    if (!columnExists($koneksi, 'device', 'serial_number')) {
        if (!mysqli_query($koneksi, "ALTER TABLE `device` ADD COLUMN `serial_number` varchar(50) DEFAULT NULL AFTER `device_name`")) {
            error_log('Admin device schema check failed: ' . mysqli_error($koneksi));
            return false;
        }
    }

    if (!columnExists($koneksi, 'device_access_tokens', 'serial_number')) {
        if (!mysqli_query($koneksi, "ALTER TABLE `device_access_tokens` ADD COLUMN `serial_number` varchar(50) DEFAULT NULL AFTER `token_code`")) {
            error_log('Admin device schema check failed: ' . mysqli_error($koneksi));
            return false;
        }
    }

    mysqli_query($koneksi, "UPDATE `device_access_tokens` SET `serial_number` = `token_code` WHERE `serial_number` IS NULL OR `serial_number` = ''");

    if (!indexExists($koneksi, 'device_access_tokens', 'serial_number')) {
        if (!mysqli_query($koneksi, "ALTER TABLE `device_access_tokens` ADD UNIQUE KEY `serial_number` (`serial_number`)")) {
            error_log('Admin device schema check failed: ' . mysqli_error($koneksi));
            return false;
        }
    }

    backfillMissingDeviceSerialNumbers($koneksi);

    if (!indexExists($koneksi, 'device', 'device_serial_number')) {
        if (!mysqli_query($koneksi, "ALTER TABLE `device` ADD UNIQUE KEY `device_serial_number` (`serial_number`)")) {
            error_log('Admin device schema check failed: ' . mysqli_error($koneksi));
            return false;
        }
    }

    return true;
}

function tableExists($koneksi, $table) {
    $safe_table = mysqli_real_escape_string($koneksi, $table);
    $result = mysqli_query($koneksi, "SHOW TABLES LIKE '$safe_table'");
    return $result && mysqli_num_rows($result) > 0;
}

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
        $escaped_serial_number = mysqli_real_escape_string($koneksi, $serial_number);
        $existing_device = mysqli_query($koneksi, "SELECT device_id FROM device WHERE serial_number = '$escaped_serial_number' LIMIT 1");
        $exists_in_device = $existing_device && mysqli_num_rows($existing_device) > 0;
        $exists_in_legacy_tokens = false;

        if (tableExists($koneksi, 'device_access_tokens')) {
            $existing_token = mysqli_query($koneksi, "SELECT token_id FROM device_access_tokens WHERE token_code = '$escaped_serial_number' OR serial_number = '$escaped_serial_number' LIMIT 1");
            $exists_in_legacy_tokens = $existing_token && mysqli_num_rows($existing_token) > 0;
        }
    } while ($exists_in_device || $exists_in_legacy_tokens);

    return $serial_number;
}

function getLegacySerialNumberForDevice($koneksi, $device_id) {
    if (!tableExists($koneksi, 'device_access_tokens')) {
        return null;
    }

    $safe_device_id = mysqli_real_escape_string($koneksi, $device_id);
    $serial_select = columnExists($koneksi, 'device_access_tokens', 'serial_number')
        ? "COALESCE(serial_number, token_code)"
        : "token_code";
    $result = mysqli_query($koneksi, "SELECT $serial_select as serial_number FROM device_access_tokens WHERE device_id = '$safe_device_id' ORDER BY created_at ASC LIMIT 1");
    $row = $result ? mysqli_fetch_assoc($result) : null;

    return $row['serial_number'] ?? null;
}

function backfillMissingDeviceSerialNumbers($koneksi) {
    if (!columnExists($koneksi, 'device', 'serial_number')) {
        return;
    }

    $result = mysqli_query($koneksi, "SELECT device_id FROM device WHERE serial_number IS NULL OR serial_number = ''");
    if (!$result) {
        return;
    }

    while ($device = mysqli_fetch_assoc($result)) {
        $device_id = $device['device_id'];
        $serial_number = getLegacySerialNumberForDevice($koneksi, $device_id);
        if (!$serial_number) {
            $serial_number = generateUniqueDeviceSerialNumber($koneksi);
        }
        $safe_serial_number = mysqli_real_escape_string($koneksi, $serial_number);
        $safe_device_id = mysqli_real_escape_string($koneksi, $device_id);
        mysqli_query($koneksi, "UPDATE device SET serial_number = '$safe_serial_number' WHERE device_id = '$safe_device_id'");
    }
}

function insertAdminAuditLog($koneksi, $admin_id, $action, $target_type, $target_id, $details) {
    $safe_admin_id = mysqli_real_escape_string($koneksi, $admin_id);
    $safe_action = mysqli_real_escape_string($koneksi, $action);
    $safe_target_type = mysqli_real_escape_string($koneksi, $target_type);
    $safe_target_id = mysqli_real_escape_string($koneksi, $target_id);
    $safe_details = mysqli_real_escape_string($koneksi, json_encode($details));

    return mysqli_query($koneksi, "INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details) VALUES ('$safe_admin_id', '$safe_action', '$safe_target_type', '$safe_target_id', '$safe_details')");
}

function htmlAttr($value) {
    return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}

ensureAdminDeviceTables($koneksi);

// Handle Add Device
if (isset($_POST['add_device'])) {
    $id_pemilik = (int) ($_POST['owner_id'] ?? 0);
    $dev_name = mysqli_real_escape_string($koneksi, $_POST['device_name']);
    $dev_type = mysqli_real_escape_string($koneksi, $_POST['device_type']);
    $broker   = mysqli_real_escape_string($koneksi, $_POST['broker_url']);
    $user_mq  = mysqli_real_escape_string($koneksi, $_POST['mq_user']);
    $pass_mq  = mysqli_real_escape_string($koneksi, $_POST['mq_pass']);
    $broker_port = mysqli_real_escape_string($koneksi, $_POST['broker_port']);

    if ($id_pemilik <= 0 || !in_array($dev_type, ['esp32-inkubator', 'esp32-smartlamp'], true)) {
        $_SESSION['toast'] = ['type' => 'error', 'message' => 'Invalid device data.'];
        header("Location: devices.php");
        exit;
    }

    $serial_number = generateUniqueDeviceSerialNumber($koneksi);
    $safe_serial_number = mysqli_real_escape_string($koneksi, $serial_number);

    $query = "INSERT INTO device (user_id, device_name, serial_number, broker_url, mq_user, mq_pass, device_type, broker_port)
              VALUES ('$id_pemilik', '$dev_name', '$safe_serial_number', '$broker', '$user_mq', '$pass_mq', '$dev_type', '$broker_port')";

    mysqli_begin_transaction($koneksi);
    if (mysqli_query($koneksi, $query)) {
        $new_id = mysqli_insert_id($koneksi);

        // Mirror serial number into the legacy access table for existing RBAC data paths.
        mysqli_query($koneksi, "INSERT INTO device_access_tokens (device_id, token_code, serial_number, created_by, max_uses)
                                VALUES ('$new_id', '$serial_number', '$serial_number', '$admin_id', 1)");

        insertAdminAuditLog($koneksi, $admin_id, 'add_device', 'device', $new_id, ['name' => $dev_name, 'serial_number' => $serial_number]);
        mysqli_commit($koneksi);
        $_SESSION['toast'] = ['type' => 'success', 'message' => "Device added. Serial number: $serial_number"];
    } else {
        mysqli_rollback($koneksi);
        $_SESSION['toast'] = ['type' => 'error', 'message' => 'Failed to add device: ' . mysqli_error($koneksi)];
    }
    header("Location: devices.php");
    exit;
}

// Handle Edit Device
if (isset($_POST['edit_device'])) {
    $id_device = (int) ($_POST['edit_device_id'] ?? 0);
    $id_pemilik = (int) ($_POST['edit_owner_id'] ?? 0);
    $dev_name  = mysqli_real_escape_string($koneksi, $_POST['edit_device_name']);
    $dev_type  = mysqli_real_escape_string($koneksi, $_POST['edit_device_type']);
    $broker    = mysqli_real_escape_string($koneksi, $_POST['edit_broker_url']);
    $broker_port = mysqli_real_escape_string($koneksi, $_POST['edit_broker_port']);
    $user_mq   = mysqli_real_escape_string($koneksi, $_POST['edit_mq_user']);
    $pass_mq   = mysqli_real_escape_string($koneksi, $_POST['edit_mq_pass']);

    if ($id_device <= 0 || $id_pemilik <= 0 || !in_array($dev_type, ['esp32-inkubator', 'esp32-smartlamp'], true)) {
        $_SESSION['toast'] = ['type' => 'error', 'message' => 'Invalid device data.'];
        header("Location: devices.php");
        exit;
    }

    $query_update = "UPDATE device SET
                     user_id     = '$id_pemilik',
                     device_name = '$dev_name',
                     device_type = '$dev_type',
                     broker_url  = '$broker',
                     broker_port = '$broker_port',
                     mq_user     = '$user_mq',
                     mq_pass     = '$pass_mq'
                     WHERE device_id = '$id_device'";

    if (mysqli_query($koneksi, $query_update)) {
        if (tableExists($koneksi, 'user_device_access')) {
            mysqli_query($koneksi, "DELETE FROM user_device_access WHERE user_id = '$id_pemilik' AND device_id = '$id_device'");
        }
        insertAdminAuditLog($koneksi, $admin_id, 'edit_device', 'device', $id_device, ['name' => $dev_name]);
        $_SESSION['toast'] = ['type' => 'success', 'message' => 'Device successfully updated!'];
    } else {
        $_SESSION['toast'] = ['type' => 'error', 'message' => 'Failed to update: ' . mysqli_error($koneksi)];
    }
    header("Location: devices.php");
    exit;
}

// Handle Delete Device
if (isset($_POST['delete_device'])) {
    $id_target = mysqli_real_escape_string($koneksi, $_POST['device_id']);

    // Get info for audit log before deleting
    $res = mysqli_query($koneksi, "SELECT device_name FROM device WHERE device_id = '$id_target'");
    $dev = mysqli_fetch_assoc($res);
    $dev_name = $dev['device_name'] ?? 'Unknown';

    if (mysqli_query($koneksi, "DELETE FROM device WHERE device_id = '$id_target'")) {
        insertAdminAuditLog($koneksi, $admin_id, 'delete_device', 'device', $id_target, ['name' => $dev_name]);
        $_SESSION['toast'] = ['type' => 'success', 'message' => 'Device deleted successfully.'];
    } else {
        $_SESSION['toast'] = ['type' => 'error', 'message' => 'Failed to delete device.'];
    }
    header("Location: devices.php");
    exit;
}

// Fetch Devices with Owner and Access Count, Sorting, and Pagination
$search = isset($_GET['search']) ? mysqli_real_escape_string($koneksi, $_GET['search']) : '';
$sort_col = isset($_GET['sort']) ? mysqli_real_escape_string($koneksi, $_GET['sort']) : 'device_id';
$sort_dir = isset($_GET['dir']) && $_GET['dir'] === 'asc' ? 'ASC' : 'DESC';

// Pagination
$limit = 25;
$page = isset($_GET['page']) ? (int)$_GET['page'] : 1;
$offset = ($page - 1) * $limit;

$allowed_sort = ['device_id', 'device_name', 'serial_number', 'device_type', 'owner_name', 'shared_users'];
if (!in_array($sort_col, $allowed_sort)) $sort_col = 'device_id';

$where_clause = $search ? "WHERE d.device_name LIKE '%$search%' OR d.serial_number LIKE '%$search%' OR u.user_name LIKE '%$search%' OR d.device_type LIKE '%$search%'" : "";

$count_sql = "SELECT COUNT(*) as total FROM device d JOIN user u ON d.user_id = u.user_id $where_clause";
$total_rows = mysqli_fetch_assoc(mysqli_query($koneksi, $count_sql))['total'];
$total_pages = ceil($total_rows / $limit);

$has_user_device_access = tableExists($koneksi, 'user_device_access');
$shared_users_select = $has_user_device_access
    ? "(SELECT COUNT(*) FROM user_device_access uda WHERE uda.device_id = d.device_id AND uda.access_type = 'viewer')"
    : "0";

$sql_devices = "SELECT d.*, u.user_name as owner_name,
                $shared_users_select as shared_users
                FROM device d
                JOIN user u ON d.user_id = u.user_id
                $where_clause
                ORDER BY $sort_col $sort_dir
                LIMIT $limit OFFSET $offset";
$devices_result = mysqli_query($koneksi, $sql_devices);

// Fetch all users for owner selection
$users_result = mysqli_query($koneksi, "SELECT user_id, user_name FROM user ORDER BY user_name ASC");
$users_list = [];
while($u = mysqli_fetch_assoc($users_result)) $users_list[] = $u;

function sortLink($col, $label) {
    global $sort_col, $sort_dir, $search;
    $new_dir = ($sort_col === $col && $sort_dir === 'ASC') ? 'desc' : 'asc';
    $icon = '';
    if ($sort_col === $col) {
        $icon = $sort_dir === 'ASC' ? ' ^' : ' v';
    }
    return "<a href=\"?search=$search&sort=$col&dir=$new_dir\" class=\"hover:text-accent-green transition\">$label$icon</a>";
}

$page_title = 'Admin - Device Management';
$body_class = 'bg-gray-50 text-gray-900 min-h-screen font-sans pb-20';
$base_url = '../';
include "../components/header.php";
?>

<div class="max-w-7xl mx-auto px-6 py-10">
    <div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-6">
        <div>
            <nav class="flex text-sm text-gray-500 mb-2 gap-2 font-semibold">
                <a href="../dashboard.php" class="hover:text-accent-green">Dashboard</a>
                <span>/</span>
                <span class="text-gray-900">Admin Panel</span>
            </nav>
            <h1 class="text-4xl font-extrabold tracking-tight">Device Management</h1>
        </div>

        <div class="flex gap-4">
            <button type="button" onclick="openAddDeviceModal()" class="bg-blue-600 text-white px-6 py-2.5 rounded-xl font-bold shadow-lg shadow-blue-900/10 transition hover:bg-blue-700">Add Device</button>
            <a href="users.php" class="bg-white text-gray-600 hover:text-accent-green px-6 py-2.5 rounded-xl font-bold border border-gray-200 transition">Users</a>
            <a href="devices.php" class="bg-accent-green text-white px-6 py-2.5 rounded-xl font-bold shadow-lg shadow-green-900/10 transition">Devices</a>
        </div>
    </div>

    <div class="bg-white rounded-3xl shadow-xl shadow-gray-200/50 border border-gray-100 overflow-hidden">
        <div class="p-6 border-b border-gray-100 flex flex-col md:flex-row justify-between items-center gap-4">
            <form method="GET" class="relative w-full md:w-96">
                <input type="hidden" name="sort" value="<?= $sort_col ?>">
                <input type="hidden" name="dir" value="<?= strtolower($sort_dir) ?>">
                <input type="text" name="search" value="<?= htmlspecialchars($search) ?>" placeholder="Search devices, owners..."
                    class="w-full pl-12 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-accent-green/20 focus:border-accent-green outline-none transition">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
            </form>
            <div class="text-sm text-gray-500 font-medium">
                Showing <?= mysqli_num_rows($devices_result) ?> of <?= $total_rows ?> devices
            </div>
        </div>

        <div class="overflow-x-auto">
            <table class="w-full text-left">
                <thead>
                    <tr class="bg-gray-50/50">
                        <th class="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider"><?= sortLink('device_id', 'Device ID') ?></th>
                        <th class="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider"><?= sortLink('device_name', 'Device Name') ?></th>
                        <th class="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider"><?= sortLink('serial_number', 'Serial Number') ?></th>
                        <th class="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider"><?= sortLink('device_type', 'Type') ?></th>
                        <th class="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider"><?= sortLink('owner_name', 'Owner') ?></th>
                        <th class="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider text-center"><?= sortLink('shared_users', 'Shared To') ?></th>
                        <th class="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider text-right">Actions</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-gray-100">
                    <?php while ($device = mysqli_fetch_assoc($devices_result)): ?>
                        <tr class="hover:bg-gray-50/50 transition-colors">
                            <td class="px-6 py-4 text-sm font-mono text-gray-400">#<?= $device['device_id'] ?></td>
                            <td class="px-6 py-4">
                                <span class="text-sm font-bold text-gray-900"><?= htmlspecialchars($device['device_name']) ?></span>
                            </td>
                            <td class="px-6 py-4 text-sm font-mono font-bold text-accent-green"><?= htmlspecialchars($device['serial_number']) ?></td>
                            <td class="px-6 py-4">
                                <span class="px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-gray-100 text-gray-600">
                                    <?= str_replace('esp32-', '', $device['device_type']) ?>
                                </span>
                            </td>
                            <td class="px-6 py-4 text-sm font-medium text-gray-700"><?= htmlspecialchars($device['owner_name']) ?></td>
                            <td class="px-6 py-4 text-center">
                                <span class="text-sm font-bold text-accent-green"><?= $device['shared_users'] ?> users</span>
                            </td>
                            <td class="px-6 py-4 text-right space-x-1">
                                <div class="flex justify-end gap-1">
                                    <button type="button"
                                        data-device-id="<?= htmlAttr($device['device_id']) ?>"
                                        data-owner-id="<?= htmlAttr($device['user_id']) ?>"
                                        data-device-name="<?= htmlAttr($device['device_name']) ?>"
                                        data-device-type="<?= htmlAttr($device['device_type']) ?>"
                                        data-broker-url="<?= htmlAttr($device['broker_url']) ?>"
                                        data-broker-port="<?= htmlAttr($device['broker_port']) ?>"
                                        data-mq-user="<?= htmlAttr($device['mq_user'] ?? '') ?>"
                                        data-mq-pass="<?= htmlAttr($device['mq_pass'] ?? '') ?>"
                                        onclick="openEditDeviceModal(this)"
                                        class="bg-blue-600/10 text-blue-600 hover:bg-blue-600 hover:text-white px-2 py-1 rounded-lg text-[10px] font-bold transition">Edit</button>
                                    <form method="POST" action="devices.php" onsubmit="return confirm('Delete this device permanently?');" class="inline">
                                        <input type="hidden" name="device_id" value="<?= $device['device_id'] ?>">
                                        <button type="submit" name="delete_device" class="bg-red-600/10 text-red-600 hover:bg-red-600 hover:text-white px-2 py-1 rounded-lg text-[10px] font-bold transition">Del</button>
                                    </form>
                                </div>
                            </td>
                        </tr>
                    <?php endwhile; ?>
                </tbody>
            </table>
        </div>

        <?php if ($total_pages > 1): ?>
        <div class="p-6 border-t border-gray-100 flex justify-center gap-2">
            <?php for ($i = 1; $i <= $total_pages; $i++): ?>
                <a href="?search=<?= $search ?>&sort=<?= $sort_col ?>&dir=<?= strtolower($sort_dir) ?>&page=<?= $i ?>"
                    class="px-4 py-2 rounded-xl text-sm font-bold <?= $page === $i ? 'bg-accent-green text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200' ?> transition">
                    <?= $i ?>
                </a>
            <?php endfor; ?>
        </div>
        <?php endif; ?>
    </div>
</div>

<!-- Add Device Modal -->
<div id="addDeviceModal" class="hidden fixed inset-0 z-50 overflow-y-auto">
    <div class="fixed inset-0 bg-gray-900/40 backdrop-blur-sm" onclick="closeAddDeviceModal()"></div>
    <div class="flex min-h-full items-center justify-center p-4">
        <div class="relative bg-white rounded-3xl shadow-2xl w-full max-w-md p-8">
            <h3 class="text-2xl font-bold mb-6">Add New Device</h3>
            <form method="POST" action="devices.php" class="space-y-4">
                <div>
                    <label class="block text-xs font-bold text-gray-700 uppercase mb-2">Device Name</label>
                    <input type="text" name="device_name" required class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                </div>
                <div>
                    <label class="block text-xs font-bold text-gray-700 uppercase mb-2">Device Type</label>
                    <select name="device_type" required class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                        <option value="esp32-inkubator">esp32-inkubator</option>
                        <option value="esp32-smartlamp">esp32-smartlamp</option>
                    </select>
                </div>
                <div>
                    <label class="block text-xs font-bold text-gray-700 uppercase mb-2">Owner</label>
                    <select name="owner_id" required class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                        <?php foreach($users_list as $u): ?>
                            <option value="<?= $u['user_id'] ?>" <?= $u['user_id'] == $admin_id ? 'selected' : '' ?>><?= htmlspecialchars($u['user_name']) ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div>
                    <label class="block text-xs font-bold text-gray-700 uppercase mb-2">Broker URL</label>
                    <input type="text" name="broker_url" required placeholder="broker.hivemq.com" class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                </div>
                <div>
                    <label class="block text-xs font-bold text-gray-700 uppercase mb-2">Port</label>
                    <input type="text" name="broker_port" required placeholder="8080" class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                </div>
                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <label class="block text-xs font-bold text-gray-700 uppercase mb-2">MQ User</label>
                        <input type="text" name="mq_user" class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-gray-700 uppercase mb-2">MQ Pass</label>
                        <input type="password" name="mq_pass" class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                    </div>
                </div>
                <div class="mt-8 flex gap-3">
                    <button type="submit" name="add_device" class="flex-1 bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700 transition">Save Device</button>
                    <button type="button" onclick="closeAddDeviceModal()" class="flex-1 bg-gray-100 text-gray-600 font-bold py-3 rounded-xl hover:bg-gray-200 transition">Cancel</button>
                </div>
            </form>
        </div>
    </div>
</div>

<!-- Edit Device Modal -->
<div id="editDeviceModal" class="hidden fixed inset-0 z-50 overflow-y-auto">
    <div class="fixed inset-0 bg-gray-900/40 backdrop-blur-sm" onclick="closeEditDeviceModal()"></div>
    <div class="flex min-h-full items-center justify-center p-4">
        <div class="relative bg-white rounded-3xl shadow-2xl w-full max-w-md p-8">
            <h3 class="text-2xl font-bold mb-6">Edit Device</h3>
            <form method="POST" action="devices.php" class="space-y-4">
                <input type="hidden" name="edit_device_id" id="edit_device_id">
                <div>
                    <label class="block text-xs font-bold text-gray-700 uppercase mb-2">Device Name</label>
                    <input type="text" name="edit_device_name" id="edit_device_name" required class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                </div>
                <div>
                    <label class="block text-xs font-bold text-gray-700 uppercase mb-2">Device Type</label>
                    <select name="edit_device_type" id="edit_device_type" required class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                        <option value="esp32-inkubator">esp32-inkubator</option>
                        <option value="esp32-smartlamp">esp32-smartlamp</option>
                    </select>
                </div>
                <div>
                    <label class="block text-xs font-bold text-gray-700 uppercase mb-2">Owner</label>
                    <select name="edit_owner_id" id="edit_owner_id" required class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                        <?php foreach($users_list as $u): ?>
                            <option value="<?= $u['user_id'] ?>"><?= htmlspecialchars($u['user_name']) ?></option>
                        <?php endforeach; ?>
                    </select>
                </div>
                <div>
                    <label class="block text-xs font-bold text-gray-700 uppercase mb-2">Broker URL</label>
                    <input type="text" name="edit_broker_url" id="edit_broker_url" required class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                </div>
                <div>
                    <label class="block text-xs font-bold text-gray-700 uppercase mb-2">Port</label>
                    <input type="text" name="edit_broker_port" id="edit_broker_port" required class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                </div>
                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <label class="block text-xs font-bold text-gray-700 uppercase mb-2">MQ User</label>
                        <input type="text" name="edit_mq_user" id="edit_mq_user" class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-gray-700 uppercase mb-2">MQ Pass</label>
                        <input type="password" name="edit_mq_pass" id="edit_mq_pass" class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-accent-green/20">
                    </div>
                </div>
                <div class="mt-8 flex gap-3">
                    <button type="submit" name="edit_device" class="flex-1 bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700 transition">Update Device</button>
                    <button type="button" onclick="closeEditDeviceModal()" class="flex-1 bg-gray-100 text-gray-600 font-bold py-3 rounded-xl hover:bg-gray-200 transition">Cancel</button>
                </div>
            </form>
        </div>
    </div>
</div>

<script>
    function openAddDeviceModal() {
        document.getElementById('addDeviceModal').classList.remove('hidden');
    }
    function closeAddDeviceModal() {
        document.getElementById('addDeviceModal').classList.add('hidden');
    }

    function openEditDeviceModal(button) {
        const d = button.dataset;
        document.getElementById('edit_device_id').value = d.deviceId || '';
        document.getElementById('edit_device_name').value = d.deviceName || '';
        document.getElementById('edit_device_type').value = d.deviceType || '';
        document.getElementById('edit_owner_id').value = d.ownerId || '';
        document.getElementById('edit_broker_url').value = d.brokerUrl || '';
        document.getElementById('edit_broker_port').value = d.brokerPort || '';
        document.getElementById('edit_mq_user').value = d.mqUser || '';
        document.getElementById('edit_mq_pass').value = d.mqPass || '';
        document.getElementById('editDeviceModal').classList.remove('hidden');
    }
    function closeEditDeviceModal() {
        document.getElementById('editDeviceModal').classList.add('hidden');
    }

</script>

<?php include "../components/footer.php"; ?>
