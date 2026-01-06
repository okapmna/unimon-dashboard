<?php
ob_start(); 
session_start();
include "config/koneksi.php";

$error = "";

if (isset($_POST['login'])) {
    $username = mysqli_real_escape_string($koneksi, $_POST['username']);
    $password = $_POST['password'];

    $query = mysqli_query($koneksi,
        "SELECT * FROM user WHERE user_name='$username' LIMIT 1"
    );

    if ($query && mysqli_num_rows($query) === 1) {
        $data = mysqli_fetch_assoc($query);

        if (password_verify($password, $data['password'])) {
            $_SESSION['username'] = $data['user_name'];

            header("Location: dashboard.php");
            exit;
        } else {
            $error = "Password salah";
        }
    } else {
        $error = "Username tidak ditemukan";
    }
}
?>


<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <title>Login</title>
    <style>
        * { box-sizing: border-box; font-family: 'Segoe UI', sans-serif; }
        body {
            background: linear-gradient(120deg, #89f7fe, #66a6ff);
            height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0;
        }
        .login-box {
            background: white;
            padding: 30px;
            width: 350px;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.2);
        }
        .login-box h2 { text-align: center; margin-bottom: 25px; }
        .login-box input {
            width: 100%;
            padding: 10px;
            margin-bottom: 15px;
            border: 1px solid #ccc;
            border-radius: 8px;
        }
        .login-box button {
            width: 100%;
            padding: 10px;
            background: #66a6ff;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
        }
        .btn-daftar {
            margin-top: 10px;
            background: #eee;
            color: #333;
        }
        .msg {
            text-align: center;
            margin-top: 10px;
            color: red;
            font-weight: bold;
        }
    </style>
</head>
<body>

<div class="login-box">
    <h2>Form Login</h2>

    <form method="post">
        <input type="text" name="username" placeholder="Username" required>
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit" name="login">Login</button>
    </form>

    <form action="register.php" method="get">
        <button type="submit" class="btn-daftar">Daftar</button>
    </form>

    <?php if ($error != "") { ?>
        <div class="msg"><?= $error ?></div>
    <?php } ?>
</div>

</body>
</html>
