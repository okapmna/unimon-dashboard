<?php
$host = "localhost";
$user = "root";
$pass = ""; // default XAMPP kosong
$db   = "unimq";

$koneksi = mysqli_connect($host, $user, $pass, $db);

if (!$koneksi) {
    die("Koneksi database gagal: " . mysqli_connect_error());
}
?>
