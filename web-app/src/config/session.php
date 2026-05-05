<?php
/**
 * Centralized Session Configuration
 * Ensures consistent session cookie settings across all pages.
 * Resolves ERR_TOO_MANY_REDIRECTS in PWA contexts by using SameSite=Lax.
 */

if (session_status() === PHP_SESSION_NONE) {
    $isSecure = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') || 
                (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https');

    session_start([
        'cookie_httponly' => true,
        'cookie_secure'   => $isSecure,
        'cookie_samesite' => 'Lax',
        'cookie_lifetime' => 60 * 60 * 24 * 30, // 30 days
        'use_strict_mode' => true,
    ]);
}
?>
