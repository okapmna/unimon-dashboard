# UNIMQ Web (Express.js)

Migrasi dari aplikasi PHP native (`web-app/`) ke Node.js + Express + EJS.

## Stack
- Express 4
- EJS templating
- mysql2 (promise pool)
- express-session + express-mysql-session (sesi disimpan di MariaDB)
- bcryptjs untuk hashing password (kompatibel dengan hash bcrypt yang sudah ada di tabel `user`)

## Routing
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET    | /                          | Login page (auto-redirect jika sudah login) |
| POST   | /                          | Login |
| GET    | /register                  | Form registrasi |
| POST   | /register                  | Daftar user baru |
| GET    | /logout                    | Logout & hapus remember-me token |
| GET    | /dashboard                 | Dashboard user (device owned + shared) |
| GET    | /profile                   | Profil user |
| POST   | /profile                   | Ubah password |
| POST   | /actions/redeem_serial_number | Tambah device shared via serial number |
| POST   | /actions/remove_shared     | Hapus akses device shared |
| GET    | /admin/users               | Manajemen user (search, sort, paginate) |
| POST   | /admin/users               | Ubah role / hapus user |
| GET    | /admin/devices             | Manajemen device |
| POST   | /admin/devices             | Tambah / edit / hapus device |
| GET    | /iot/incubator/:deviceId   | Dashboard IoT inkubator (MQTT + chart) |
| GET    | /iot/smartlamp/:deviceId   | Dashboard IoT smart lamp |

## Database
Skema database tidak berubah, lihat `database/unimq.sql` dan `database/migrations/001_admin_sharing_spike.sql` di root project.

Tabel tambahan otomatis dibuat oleh `express-mysql-session`: `web_sessions`.

## Setup lokal (tanpa Docker)
```bash
cp .env.example .env
npm install
npm start
```
Akses: http://localhost:8080

## Docker
Service `web` di `docker-compose.yml` sudah diarahkan ke folder ini. Jalankan:
```bash
docker compose up -d --build
```
