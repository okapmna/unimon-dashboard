<?php
$base_url = $base_url ?? '';
$page_title = $page_title ?? 'Unimon Dashboard';
$body_class = $body_class ?? 'font-sans min-h-screen flex items-center justify-center p-6';
?>
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= htmlspecialchars($page_title) ?></title>
    <link rel="icon" type="image/png" href="<?= $base_url ?>assets/images/unimon-logo.png">
    
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    
    <script src="<?= $base_url ?>assets/js/tailwind.config.js"></script>
    <link rel="stylesheet" href="<?= $base_url ?>assets/css/style.css">

    <?php if (isset($extra_head)) echo $extra_head; ?>
</head>
<body class="<?= htmlspecialchars($body_class) ?>">
