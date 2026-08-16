---
title: Mulai cepat
description: Deploy MailRiz ke akun Cloudflare Anda sendiri dengan satu perintah.
---

Satu perintah men-deploy seluruh tumpukan — Worker, database, penyimpanan, DNS,
dan perutean email — ke akun Cloudflare Anda sendiri.

```sh
bunx mailriz-cli@latest setup
```

## Sebelum mulai

Anda perlu:

- **Akun Cloudflare** dengan domain yang sudah terdaftar sebagai zone. Email
  akan tiba di domain itu, jadi harus domain yang Anda kendalikan.
- **API token Cloudflare.** Wizard akan membuka halaman yang tepat dan
  menyebutkan scope mana yang harus dicentang — lihat
  [Token Cloudflare](/mailriz/id/getting-started/cloudflare-token/) kalau ingin
  menyiapkannya lebih dulu.
- **Bun** ≥ 1.1, atau Node ≥ 18 kalau CLI dijalankan lewat `npx`.

## Yang dikerjakan wizard

1. **Pre-flight** — memeriksa wrangler, koneksi, dan versi Bun Anda.
2. **Token** — Anda tempel; token diverifikasi sebelum apa pun dibuat.
3. **Akun dan domain** — pilih zone tempat email akan tiba.
4. **Konfigurasi** — hostname dashboard (bawaan `inbox.domainanda.com`) dan
   alamat email admin Anda.
5. **Autentikasi** — Cloudflare Access kalau token Anda mengizinkan, kalau tidak
   sebuah password yang Anda tentukan di sini. Lihat
   [Autentikasi](/mailriz/en/internals/auth/).
6. **Provisioning**, ditampilkan sebagai daftar tugas langsung:

   | Tugas | Yang dibuat |
   |---|---|
   | `release` | mengunduh bundle Worker dari GitHub Releases |
   | `d1` | database `mailriz` |
   | `migrations` | skemanya |
   | `r2` | tiga bucket — email mentah, lampiran, HTML tersanitasi |
   | `access` | aplikasi Access, kalau Anda memilihnya |
   | `worker` | men-deploy Worker dan memasang custom domain |
   | `email routing` | mengaktifkan routing dan mengarahkan catch-all ke Worker |
   | `health` | mem-polling `/healthz` sampai domainnya menjawab |

Langkah terakhir menunggu DNS dan sertifikat, dan itu perlu waktu sejenak. Itu
wajar, bukan macet.

## Menyimpan token

Di akhir Anda ditanya apakah token ingin disimpan:

```
? Save this token so `update` and `destroy` don't ask again?  › No / Yes
```

Bawaannya **No**. Token ini bisa menghapus Worker, database, dan seluruh email
tersimpan milik Anda, jadi ia tidak pernah ditulis ke disk kecuali Anda
menyetujuinya. Kalau disimpan, ia masuk ke `~/.mailriz/config.json` dengan mode
`600`.

Kalau menolak, perintah berikutnya membaca `$CLOUDFLARE_API_TOKEN` atau meminta
Anda menempelkannya lagi.

## Setelah itu

Buka dashboard di hostname yang Anda pilih, lalu kirimi diri Anda sendiri email
ke alamat **apa pun** di domain Anda — alias tidak perlu dibuat lebih dulu.

```sh
# semuanya langsung berfungsi
echo "hai" | mail -s "tes" apasaja@domainanda.com
```

Email seharusnya muncul di kotak masuk dalam beberapa detik, tanpa refresh.

Kalau tidak ada yang masuk, lihat
[Pemecahan masalah](/mailriz/en/operations/troubleshooting/).
