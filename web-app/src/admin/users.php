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

function insertAdminAuditLog($koneksi, $admin_id, $action, $target_type, $target_id, $details = null) {
    if (!$admin_id) return;

    $safe_admin_id = mysqli_real_escape_string($koneksi, $admin_id);
    $safe_action = mysqli_real_escape_string($koneksi, $action);
    $safe_target_type = mysqli_real_escape_string($koneksi, $target_type);
    $safe_target_id = mysqli_real_escape_string($koneksi, $target_id);
    $details_sql = $details === null ? 'NULL' : "'" . mysqli_real_escape_string($koneksi, json_encode($details)) . "'";

    mysqli_query($koneksi, "INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, details) VALUES ('$safe_admin_id', '$safe_action', '$safe_target_type', '$safe_target_id', $details_sql)");
}

function runOrThrow($koneksi, $query) {
    if (!mysqli_query($koneksi, $query)) {
        throw new Exception(mysqli_error($koneksi));
    }
}

// Handle Role Change
if (isset($_POST['change_role'])) {
    $target_user_id = mysqli_real_escape_string($koneksi, $_POST['user_id']);
    $new_role = mysqli_real_escape_string($koneksi, $_POST['role']);

    if (!in_array($new_role, ['admin', 'user'], true)) {
        $_SESSION['toast'] = ['type' => 'error', 'message' => 'Invalid role selected.'];
        header("Location: users.php");
        exit;
    }

    $current_role_check = mysqli_query($koneksi, "SELECT role FROM user WHERE user_id = '$target_user_id' LIMIT 1");
    $current_user = $current_role_check ? mysqli_fetch_assoc($current_role_check) : null;
    if (!$current_user) {
        $_SESSION['toast'] = ['type' => 'error', 'message' => 'User not found.'];
        header("Location: users.php");
        exit;
    }
    $current_role = $current_user['role'];

    // Prevent last admin demotion
    if ($new_role === 'user') {
        $admin_check = mysqli_query($koneksi, "SELECT COUNT(*) as count FROM user WHERE role = 'admin'");
        $admin_count = mysqli_fetch_assoc($admin_check)['count'];

        if ($admin_count <= 1 && $current_role === 'admin') {
            $_SESSION['toast'] = ['type' => 'error', 'message' => 'Cannot demote the last admin!'];
            header("Location: users.php");
            exit;
        }
    }

    $query = "UPDATE user SET role = '$new_role' WHERE user_id = '$target_user_id'";
    if (mysqli_query($koneksi, $query)) {
        // Audit Log
        insertAdminAuditLog($koneksi, $admin_id, 'change_role', 'user', $target_user_id, ['old_role' => $current_role, 'new_role' => $new_role]);

        $_SESSION['toast'] = ['type' => 'success', 'message' => 'Role updated successfully!'];
    } else {
        $_SESSION['toast'] = ['type' => 'error', 'message' => 'Failed to update role.'];
    }
    header("Location: users.php");
    exit;
}

// Handle User Deletion
if (isset($_POST['delete_user'])) {
    $target_user_id = mysqli_real_escape_string($koneksi, $_POST['user_id']);

    // Prevent self deletion
    if ($target_user_id == $admin_id) {
        $_SESSION['toast'] = ['type' => 'error', 'message' => 'You cannot delete yourself!'];
    } else {
        mysqli_begin_transaction($koneksi);
        try {
            runOrThrow($koneksi, "DELETE FROM admin_audit_log WHERE admin_id = '$target_user_id'");
            runOrThrow($koneksi, "DELETE FROM device_access_tokens WHERE created_by = '$target_user_id'");
            runOrThrow($koneksi, "DELETE FROM user_device_access WHERE user_id = '$target_user_id'");
            runOrThrow($koneksi, "DELETE FROM device WHERE user_id = '$target_user_id'");
            runOrThrow($koneksi, "DELETE FROM user_tokens WHERE user_id = '$target_user_id'");
            runOrThrow($koneksi, "DELETE FROM user WHERE user_id = '$target_user_id'");

            insertAdminAuditLog($koneksi, $admin_id, 'delete_user', 'user', $target_user_id);
            mysqli_commit($koneksi);
            $_SESSION['toast'] = ['type' => 'success', 'message' => 'User deleted successfully!'];
        } catch (Exception $e) {
            mysqli_rollback($koneksi);
            $_SESSION['toast'] = ['type' => 'error', 'message' => 'Failed to delete user: ' . $e->getMessage()];
        }
    }
    header("Location: users.php");
    exit;
}

// Fetch Users with Device Count, Sorting, and Pagination
$search = isset($_GET['search']) ? mysqli_real_escape_string($koneksi, $_GET['search']) : '';
$sort_col = isset($_GET['sort']) ? mysqli_real_escape_string($koneksi, $_GET['sort']) : 'user_id';
$sort_dir = isset($_GET['dir']) && $_GET['dir'] === 'asc' ? 'ASC' : 'DESC';

// Pagination
$limit = 25;
$page = isset($_GET['page']) ? (int)$_GET['page'] : 1;
$offset = ($page - 1) * $limit;

$allowed_sort = ['user_id', 'user_name', 'role', 'owned_count', 'shared_count'];
if (!in_array($sort_col, $allowed_sort)) $sort_col = 'user_id';

$where_clause = $search ? "WHERE user_name LIKE '%$search%' OR role LIKE '%$search%'" : "";

$count_sql = "SELECT COUNT(*) as total FROM user $where_clause";
$total_rows = mysqli_fetch_assoc(mysqli_query($koneksi, $count_sql))['total'];
$total_pages = ceil($total_rows / $limit);

$sql_users = "SELECT u.user_id, u.user_name, u.role, 
              (SELECT COUNT(*) FROM device d WHERE d.user_id = u.user_id) as owned_count,
              (SELECT COUNT(*) FROM user_device_access uda WHERE uda.user_id = u.user_id) as shared_count
              FROM user u
              $where_clause
              ORDER BY $sort_col $sort_dir
              LIMIT $limit OFFSET $offset";
$users_result = mysqli_query($koneksi, $sql_users);

function sortLink($col, $label) {
    global $sort_col, $sort_dir, $search;
    $new_dir = ($sort_col === $col && $sort_dir === 'ASC') ? 'desc' : 'asc';
    $icon = '';
    if ($sort_col === $col) {
        $icon = $sort_dir === 'ASC' ? ' ^' : ' v';
    }
    return "<a href=\"?search=$search&sort=$col&dir=$new_dir\" class=\"hover:text-accent-green transition\">$label$icon</a>";
}

$page_title = 'Admin - User Management';
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
            <h1 class="text-4xl font-extrabold tracking-tight">User Management</h1>
        </div>
        
        <div class="flex gap-4">
            <a href="users.php" class="bg-accent-green text-white px-6 py-2.5 rounded-xl font-bold shadow-lg shadow-green-900/10 transition">Users</a>
            <a href="devices.php" class="bg-white text-gray-600 hover:text-accent-green px-6 py-2.5 rounded-xl font-bold border border-gray-200 transition">Devices</a>
        </div>
    </div>

    <div class="bg-white rounded-3xl shadow-xl shadow-gray-200/50 border border-gray-100 overflow-hidden">
        <div class="p-6 border-b border-gray-100 flex flex-col md:flex-row justify-between items-center gap-4">
            <form method="GET" class="relative w-full md:w-96">
                <input type="hidden" name="sort" value="<?= $sort_col ?>">
                <input type="hidden" name="dir" value="<?= strtolower($sort_dir) ?>">
                <input type="text" name="search" value="<?= htmlspecialchars($search) ?>" placeholder="Search users or roles..."
                    class="w-full pl-12 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-accent-green/20 focus:border-accent-green outline-none transition">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
            </form>
            <div class="text-sm text-gray-500 font-medium">
                Showing <?= mysqli_num_rows($users_result) ?> of <?= $total_rows ?> users
            </div>
        </div>

        <div class="overflow-x-auto">
            <table class="w-full text-left">
                <thead>
                    <tr class="bg-gray-50/50">
                        <th class="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider"><?= sortLink('user_id', 'User ID') ?></th>
                        <th class="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider"><?= sortLink('user_name', 'Username') ?></th>
                        <th class="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider"><?= sortLink('role', 'Role') ?></th>
                        <th class="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider text-center"><?= sortLink('owned_count', 'Devices (Owned/Shared)') ?></th>
                        <th class="px-6 py-4 text-xs font-bold text-gray-500 uppercase tracking-wider text-right">Actions</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-gray-100">
                    <?php while ($user = mysqli_fetch_assoc($users_result)): ?>
                        <tr class="hover:bg-gray-50/50 transition-colors">
                            <td class="px-6 py-4 text-sm font-mono text-gray-400">#<?= $user['user_id'] ?></td>
                            <td class="px-6 py-4">
                                <span class="text-sm font-bold text-gray-900"><?= htmlspecialchars($user['user_name']) ?></span>
                            </td>
                            <td class="px-6 py-4">
                                <span class="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider <?= $user['role'] === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700' ?>">
                                    <?= $user['role'] ?>
                                </span>
                            </td>
                            <td class="px-6 py-4 text-center">
                                <span class="text-sm font-semibold text-gray-700"><?= $user['owned_count'] ?></span>
                                <span class="text-gray-300 mx-1">/</span>
                                <span class="text-sm font-semibold text-gray-500"><?= $user['shared_count'] ?></span>
                            </td>
                            <td class="px-6 py-4 text-right space-x-2">
                                <button type="button" data-user-id="<?= $user['user_id'] ?>" data-user-name="<?= htmlspecialchars($user['user_name'], ENT_QUOTES, 'UTF-8') ?>" data-role="<?= htmlspecialchars($user['role'], ENT_QUOTES, 'UTF-8') ?>" onclick="openRoleModal(this)"
                                    class="text-xs font-bold text-accent-green hover:underline">Edit Role</button>
                                <?php if ($user['user_id'] != $admin_id): ?>
                                    <button type="button" data-user-id="<?= $user['user_id'] ?>" data-user-name="<?= htmlspecialchars($user['user_name'], ENT_QUOTES, 'UTF-8') ?>" onclick="confirmDelete(this)"
                                        class="text-xs font-bold text-red-500 hover:underline">Delete</button>
                                <?php endif; ?>
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

<!-- Role Edit Modal -->
<div id="roleModal" class="hidden fixed inset-0 z-50 overflow-y-auto">
    <div class="fixed inset-0 bg-gray-900/40 backdrop-blur-sm" onclick="closeRoleModal()"></div>
    <div class="flex min-h-full items-center justify-center p-4">
        <div class="relative bg-white rounded-3xl shadow-2xl w-full max-w-md p-8">
            <h3 class="text-2xl font-bold mb-2">Change User Role</h3>
            <p id="roleModalUser" class="text-gray-500 text-sm mb-6"></p>
            <form method="POST">
                <input type="hidden" name="user_id" id="roleModalUserId">
                <div class="space-y-4">
                    <label class="flex items-center p-4 border-2 rounded-2xl cursor-pointer transition has-[:checked]:border-accent-green has-[:checked]:bg-green-50">
                        <input type="radio" name="role" value="user" id="roleUser" class="hidden">
                        <div class="flex-1">
                            <p class="font-bold">Regular User</p>
                            <p class="text-xs text-gray-500">Can only manage their own or shared devices.</p>
                        </div>
                        <div class="w-5 h-5 rounded-full border-2 border-gray-300 flex items-center justify-center peer-checked:border-accent-green">
                            <div class="w-2.5 h-2.5 rounded-full bg-accent-green opacity-0 check-indicator"></div>
                        </div>
                    </label>
                    <label class="flex items-center p-4 border-2 rounded-2xl cursor-pointer transition has-[:checked]:border-purple-600 has-[:checked]:bg-purple-50">
                        <input type="radio" name="role" value="admin" id="roleAdmin" class="hidden">
                        <div class="flex-1">
                            <p class="font-bold text-purple-700">Administrator</p>
                            <p class="text-xs text-gray-500">Full system access, manage all users and devices.</p>
                        </div>
                        <div class="w-5 h-5 rounded-full border-2 border-gray-300 flex items-center justify-center peer-checked:border-purple-600">
                            <div class="w-2.5 h-2.5 rounded-full bg-purple-600 opacity-0 check-indicator"></div>
                        </div>
                    </label>
                </div>
                <div class="mt-8 flex gap-3">
                    <button type="submit" name="change_role" class="flex-1 bg-accent-green text-white font-bold py-3 rounded-xl hover:bg-green-700 transition">Save Changes</button>
                    <button type="button" onclick="closeRoleModal()" class="flex-1 bg-gray-100 text-gray-600 font-bold py-3 rounded-xl hover:bg-gray-200 transition">Cancel</button>
                </div>
            </form>
        </div>
    </div>
</div>

<!-- Delete Confirmation Form (Hidden) -->
<form id="deleteForm" method="POST" class="hidden">
    <input type="hidden" name="user_id" id="deleteUserId">
    <input type="hidden" name="delete_user" value="1">
</form>

<script>
    function openRoleModal(button) {
        const id = button.dataset.userId;
        const name = button.dataset.userName;
        const role = button.dataset.role;
        document.getElementById('roleModalUserId').value = id;
        document.getElementById('roleModalUser').innerText = "Updating role for user: " + name;
        document.getElementById('role' + role.charAt(0).toUpperCase() + role.slice(1)).checked = true;
        document.getElementById('roleModal').classList.remove('hidden');
    }

    function closeRoleModal() {
        document.getElementById('roleModal').classList.add('hidden');
    }

    function confirmDelete(button) {
        const id = button.dataset.userId;
        const name = button.dataset.userName;
        if (confirm("Are you sure you want to delete user '" + name + "'? This action cannot be undone and will delete all their owned devices.")) {
            document.getElementById('deleteUserId').value = id;
            document.getElementById('deleteForm').submit();
        }
    }
</script>

<?php include "../components/footer.php"; ?>
