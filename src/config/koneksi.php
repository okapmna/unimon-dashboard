<?php
$host = "db";
$user = "user_app";
$pass = "password_app"; // default XAMPP kosong
$db   = "unimq";

$koneksi = mysqli_connect($host, $user, $pass, $db);

if (!$koneksi) {
    die("Koneksi database gagal: " . mysqli_connect_error());
}
?>
