---
title: Apa itu MailRiz?
description: Alias email permanen dan self-hosted di Cloudflare — apa fungsinya dan untuk siapa.
---

MailRiz memberi Anda alamat email tanpa batas di domain milik Anda sendiri, dan
satu kotak masuk untuk membaca semuanya. Semuanya berjalan di akun Cloudflare
Anda: email tersimpan di database D1 dan bucket R2 Anda, dan tidak ada pihak
lain yang mengoperasikan bagian mana pun darinya.

## Idenya

Berhenti memberikan alamat asli Anda ke setiap layanan. Karang saja saat
mendaftar:

```
netflix@domainanda.com
tagihan-listrik@domainanda.com
toko-yang-cuma-sekali@domainanda.com
```

Semuanya masuk ke dashboard yang sama. Ketika satu alamat mulai menerima spam,
Anda tahu persis siapa yang membocorkannya — dan bisa mematikan alamat itu saja
tanpa menyentuh yang lain.

Alamatnya **permanen**. Ia berfungsi sampai Anda menonaktifkannya, tidak seperti
kotak masuk sekali pakai yang kedaluwarsa dalam sepuluh menit.

## Yang Anda dapat

- **Catch-all sejak awal.** Alamat apa pun di domain Anda langsung berfungsi;
  aliasnya muncul di dashboard saat email pertama tiba.
- **Kotak masuk sungguhan** — folder, bintang, label, pencarian, dan panel baca.
- **Email dirender apa adanya**, dengan gambar eksternal ditahan sampai Anda
  memintanya.
- **Pembaruan langsung.** Email baru muncul sendiri, tanpa refresh.
- **Data tetap milik Anda.** Berkas `.eml` asli dan setiap lampiran tersimpan di
  bucket R2 Anda sendiri.

## Yang bukan

- **Bukan pengirim email.** MailRiz menerima; ia tidak mengirim atau membalas.
  Itu ada di rencana, belum ada di produk.
- **Bukan multi-pengguna.** Satu orang, satu kotak masuk. Seluruh model
  autentikasinya mengasumsikan satu pemilik.
- **Bukan layanan hosted.** Tidak ada server MailRiz untuk didaftari. Anda
  men-deploy-nya ke akun sendiri dan Anda yang mengoperasikannya.

## Biayanya

Paket gratis Cloudflare cukup untuk kotak masuk pribadi — D1 memberi 500 MB per
database, R2 memberi 10 GB tanpa biaya egress.

Satu hal yang perlu diketahui sebelum mulai: pada paket **Workers Free**, setiap
request hanya mendapat 10 ms CPU, dan mengurai email HTML berukuran besar bisa
melewatinya. Akibatnya email masuk bisa gagal sesekali. **Workers Paid ($5/bln)
disarankan** agar pengiriman andal. Lihat
[Batas platform](/mailriz/en/reference/limits/).

## Selanjutnya

[Mulai cepat](/mailriz/id/getting-started/quick-start/) — satu perintah, sekitar
lima menit.
