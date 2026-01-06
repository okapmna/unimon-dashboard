<?php
session_start();
if (!isset($_SESSION['username'])) {
    header("Location: login.php");
    exit;
}

include "koneksi.php";
$username = $_SESSION['username'];

// Logika simpan data
if (isset($_POST['add_device'])) {
    $broker = mysqli_real_escape_string($koneksi, $_POST['broker_url']);
    $user   = mysqli_real_escape_string($koneksi, $_POST['mq_user']);
    $pass   = mysqli_real_escape_string($koneksi, $_POST['mq_pass']);
    $type   = mysqli_real_escape_string($koneksi, $_POST['device_type']);

    $query = "INSERT INTO device (broker_url, mq_user, mq_pass, device_type) 
              VALUES ('$broker', '$user', '$pass', '$type')";
    
    if (mysqli_query($koneksi, $query)) {
        echo "<script>alert('Device Berhasil Ditambahkan!'); window.location='dashboard.php';</script>";
        exit;
    }
}
?>

<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <title>Dashboard Device</title>
    <style>
        body {
            font-family: 'Segoe UI', sans-serif;
            background: #f4f6f8;
            margin: 0;
            overflow: hidden; /* Mencegah scroll yang tidak perlu */
        }

        /* Navigasi Pojok Kiri Atas */
        .top-left {
            position: absolute;
            top: 20px;
            left: 20px;
        }

        /* Navigasi Pojok Kanan Atas */
        .top-right {
            position: absolute;
            top: 25px;
            right: 20px;
        }

        .btn-new {
            background: #28a745;
            color: white;
            border: none;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 4px 10px rgba(0,0,0,0.1);
            transition: 0.3s;
        }
        .btn-new:hover { background: #218838; transform: translateY(-2px); }

        .logout {
            color: #ff4d4d;
            text-decoration: none;
            font-size: 14px;
            font-weight: 600;
        }
        .logout:hover { text-decoration: underline; }

        /* Modal Pop-up */
        .modal {
            display: none;
            position: fixed;
            z-index: 999;
            left: 0; top: 0;
            width: 100%; height: 100%;
            background: rgba(0,0,0,0.5);
        }
        .modal-content {
            background: white;
            margin: 10% auto;
            padding: 25px;
            width: 320px;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        input {
            width: 100%;
            padding: 10px;
            margin: 8px 0;
            border: 1px solid #ddd;
            border-radius: 6px;
            box-sizing: border-box;
        }
        .btn-save {
            width: 100%;
            padding: 12px;
            background: #66a6ff;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-weight: bold;
            margin-top: 10px;
        }
    </style>
</head>
<body>

<div class="top-left">
    <button class="btn-new" onclick="openModal()">+ New Device</button>
</div>

<div class="top-right">
    <span style="margin-right: 15px; color: #555;">Halo, <b><?= $username ?></b></span>
    <a href="logout.php" class="logout">Logout</a>
</div>

<div id="deviceModal" class="modal">
    <div class="modal-content">
        <h3 style="margin-top:0; color: #333;">Add New Device</h3>
        <form method="post">
            <label style="font-size: 13px; color: gray;">Pilih Tipe Device:</label>
            <select name="device_type" required style="width: 100%; padding: 10px; margin: 8px 0; border: 1px solid #ddd; border-radius: 6px; background: white;">
                <option value="" disabled selected>-- Pilih Tipe --</option>
                <option value="esp32-inkubator">esp32-inkubator</option>
                <option value="esp32-smartlamp">esp32-smartlamp </option>
                <option value="coming-soon">coming-soon</option>
            </select>

            <input type="text" name="broker_url" placeholder="Broker URL" required>
            
            <input type="text" name="mq_user" placeholder="MQ User ">
            <input type="password" name="mq_pass" placeholder="MQ Password ">
            
            <button type="submit" name="add_device" class="btn-save">Simpan Device</button>
            <button type="button" onclick="closeModal()" style="width:100%; background:none; border:none; color:gray; cursor:pointer; margin-top:10px;">Batal</button>
        </form>
    </div>
</div>
<script>
    function openModal() { document.getElementById('deviceModal').style.display = 'block'; }
    function closeModal() { document.getElementById('deviceModal').style.display = 'none'; }
</script>

</body>
</html>