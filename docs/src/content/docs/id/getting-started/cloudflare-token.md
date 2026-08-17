---
title: API token Cloudflare
description: Scope yang dibutuhkan MailRiz, alasan tiap scope diperlukan, dan cara membuat tokennya.
---

Wizard setup butuh API token untuk membangun tumpukan di akun Anda. Ia membuka
halaman pembuatan token dengan nama yang sudah terisi, tapi Anda juga bisa
membuatnya lebih dulu.

Buka **My Profile → API Tokens → Create Token → Create Custom Token** di
dashboard Cloudflare.

## Scope wajib

Ada tujuh, dan masing-masing dipakai untuk tepat satu hal:

| # | Scope | Dipakai untuk |
|---|---|---|
| 1 | Account → Workers Scripts → Edit | men-deploy Worker |
| 2 | Account → D1 → Edit | membuat database dan menerapkan migrasi |
| 3 | Account → Workers R2 Storage → Edit | membuat tiga bucket |
| 4 | Zone → Workers Routes → Edit | memasang custom domain dashboard |
| 5 | Zone → Email Routing Rules → Edit | mengaktifkan routing dan catch-all |
| 6 | Zone → DNS → Edit | record MX dan SPF yang dibutuhkan Email Routing |
| 7 | Zone → Zone Settings → Edit | membaca dan menyesuaikan konfigurasi zone |

## Scope opsional

| Scope | Dipakai untuk |
|---|---|
| Account → Access: Apps and Policies → Edit | membuat aplikasi Cloudflare Access |

Tanpa scope ini, setup mendeteksi bahwa Access tidak tersedia **sebelum
men-deploy apa pun** dan menawarkan autentikasi password sebagai gantinya. Anda
tidak akan terdampar dengan instalasi setengah jadi — pilihannya ditentukan di
awal.

## Zone resources

Batasi token pada zone tempat email akan tiba. Perizinan tingkat akun berlaku
untuk akun yang Anda pilih saat setup.

## Setelah setup

Token hanya dibutuhkan lagi untuk `update` dan `destroy`. Di akhir setup Anda
ditanya apakah ingin menyimpannya; bawaannya tidak, karena token itu bisa
menghapus Worker, database, dan email tersimpan Anda.

Kalau menolak, ekspor saat dibutuhkan:

```sh
export CLOUDFLARE_API_TOKEN=...
mailriz-cli update
```

Periksa apakah ada token tersimpan dengan:

```sh
mailriz-cli status
```

Perintah itu melaporkan ada atau tidaknya token di disk — tidak pernah isinya.

## Merotasi token

Buat token baru, lalu ekspor sebagai `$CLOUDFLARE_API_TOKEN` atau tempelkan di
prompt saat sebuah perintah menanyakannya. `update`, `reconfigure`, dan
`destroy` selalu mengutamakan yang Anda ketik daripada yang tersimpan, jadi
rotasi token tidak butuh langkah lain.

Kalau token yang sudah dicabut tersimpan di `~/.mailriz/config.json`, perintah
akan gagal dengan galat autentikasi. Jalankan `reconfigure` dan tempelkan token
baru untuk menggantinya.

:::caution
Jangan menghapus `~/.mailriz/config.json` hanya untuk membuang token basi. File
itu satu-satunya catatan tentang Worker, database, dan bucket mana yang milik
instalasi Anda, dan `setup` menolak berjalan selama ada deployment yang tidak
terlihat olehnya — menghapus file itu meninggalkan deployment tetap berjalan
tanpa apa pun yang menunjuk ke sana.
:::
