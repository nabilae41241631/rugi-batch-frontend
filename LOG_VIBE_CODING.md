# LOG VIBE CODING - RUGI-BATCH AI

- Proyek: Rugi-Batch AI (Sistem Pemantauan Susut Produksi UMKM Bawang Goreng)
- Tim Pengembang: Nabila dan Elsa
- Komponen Sistem: Frontend Web (SPA Offline-First) dan Backend API (Python Flask)
- Pembaruan Terakhir: November 2026

---

## 1. Gambaran Arsitektur dan Struktur Berkas

Aplikasi Rugi-Batch AI memisahkan layanan antarmuka pengguna dan pemrosesan data agar ringan dijalankan pada perangkat seluler maupun komputer di area produksi.

    rugi-batch-frontend/
    ├── index.html          # Kerangka utama SPA (halaman masuk, navigasi, dan registrasi SW)
    ├── style.css           # Gaya transisi halaman, tombol stepper timbangan, kartu, dan badge
    ├── app.js              # Logika aplikasi, integrasi API, cache lokal, dan antrean offline
    ├── sw.js               # Service Worker untuk penyimpanan aset statis saat tanpa sinyal
    ├── LOG_VIBE_CODING.md  # Dokumentasi pengembangan dan audit kode tim
    └── stitch_rugi_batch_umkm_monitor/
        └── stitch_rugi_batch_umkm_monitor/
            ├── koperasi_bawang_hangat/DESIGN.md
            ├── layar_1_halaman_masuk_desktop_1440px/
            ├── layar_2_beranda/
            ├── layar_3_catat_batch_baru/
            ├── layar_4_riwayat_dan_hasil_pemeriksaan/
            └── hasil_analisis_batch/

Alur kerja sistem berjalan dalam empat tahap utama:
1. Pengguna masuk melalui halaman login memakai akun terdaftar atau tombol akun demo untuk mendapatkan token sesi.
2. Sistem memuat ringkasan produksi, grafik rendemen, dan peringatan kerugian mingguan pada halaman Beranda.
3. Operator mengisi berat bahan pada empat tahap produksi (kupas, iris, goreng, dan kemas) di halaman Catat Batch untuk dianalisis oleh model AI di server.
4. Jika koneksi internet terputus, aplikasi menyimpan input ke antrean lokal browser dan mengirimkannya secara otomatis saat jaringan kembali aktif.

---

## 2. Daftar Prompt Utama (Vibe Coding)

Pengembangan prototipe dilakukan secara bertahap menggunakan AI coding assistant melalui lima instruksi inti berikut:

1. Perancangan Arsitektur Backend dan Model Prediksi:
   Menyusun layanan REST API menggunakan Python Flask untuk menangani autentikasi pengguna, penyimpanan riwayat produksi, serta perhitungan prediksi rendemen dan estimasi kerugian finansial tiap batch.
2. Pembuatan Kerangka Antarmuka Berdasarkan Desain Stitch:
   Menerjemahkan token warna dan tata letak dari panduan desain Koperasi Bawang Hangat ke dalam struktur Single-Page Application responsif dengan ukuran huruf besar dan tombol stepper yang mudah ditekan.
3. Integrasi Frontend dengan Endpoint REST API:
   Menghubungkan formulir login, ringkasan dasbor, formulir pencatatan batch, grafik rendemen SVG, dan halaman riwayat pemeriksaan ke server backend di https://abiliya.pythonanywhere.com.
4. Penyelarasan Tampilan dan Perbaikan Pemetaan Data:
   Menyesuaikan komponen kartu status, daftar periksa rekomendasi, dan pembacaan properti JSON agar selaras dengan rancangan layar pada folder stitch_rugi_batch_umkm_monitor.
5. Penerapan Ketahanan Jaringan (Offline-First):
   Menambahkan Service Worker (sw.js), cache localStorage, batas waktu tunggu jaringan 8 detik, serta antrean sinkronisasi otomatis agar aplikasi tetap berfungsi di lokasi minim sinyal.

---

## 3. Catatan Intervensi Manusia (Human-in-the-Loop)

Tim melakukan pengujian langsung terhadap respons API dan perilaku aplikasi di browser, lalu melakukan perbaikan secara manual pada bagian kode berikut:

- Perbaikan Tampilan Objek Peringatan Mingguan (alert_mingguan):
  Server mengirimkan data alert_mingguan dalam bentuk objek JSON berisi properti batch_bocor_7_hari dan total_kerugian_7_hari, sehingga sempat muncul tulisan [object Object] di layar. Tim membuat fungsi alertTeks() di app.js untuk mengekstrak kedua nilai angka tersebut menjadi kalimat informasi yang mudah dibaca.
- Penyesuaian Field dan Skala Grafik Rendemen:
  Grafik garis sempat gagal menggambar titik data karena membaca field rendemen_persen. Tim mengubah pembacaan kode ke field asli backend yaitu rendemen_aktual_persen serta mengatur skala sumbu Y secara dinamis mengikuti nilai minimum dan maksimum data.
- Normalisasi Status Anomali dan Perbaikan Filter Riwayat:
  Backend mengembalikan status Anomali untuk batch dengan penyusutan tinggi, sedangkan filter awal hanya mengenali label Bocor. Tim menyelaraskan pemetaan status dan memisahkan array sumber data (_sumberRiwayat) agar perpindahan tab filter tidak menimpa data asli.
- Penyesuaian Nilai Default dan Pilihan Kode Perlakuan (kode_perlakuan):
  Backend hanya menerima kode standar A1, A2, A3, B1, B2, dan B3, sedangkan nilai bawaan awal di app.js masih mengirimkan GRG-KERING-01 yang memicu pesan galat validasi. Tim mengganti nilai bawaan tersebut ke kode valid (A1 sampai B3) dan mengubah kolom input menjadi pilihan terstandar agar operator tidak salah memasukkan kode.
- Perbaikan Kontras Warna Teks Menu Aktif (style.css):
  Saat menu navigasi aktif menggunakan kelas Tailwind bg-primary-container dan text-on-primary, warna teks dan ikon terlihat gelap di atas latar hijau tua. Tim menambahkan aturan CSS spesifik untuk kelas .nav-link.text-on-primary di bagian akhir style.css agar warna teks dan ikon menjadi putih (#ffffff).
- Penyegaran Cache Service Worker Saat Deployment (sw.js):
  Setelah pembaruan kode diunggah ke GitHub dan Vercel, browser sempat memuat versi tampilan lama dari memori offline. Tim melakukan penghapusan penyimpanan situs (Clear site data) dan memastikan pembaruan cache Service Worker berjalan agar perubahan terbaru langsung tampil.
- Perbaikan Kode Ikon Antarmuka:
  Mengganti nama ikon Material Symbols yang tidak dikenali browser (signal_wifi_statusbar_connected_no_internet_4) menjadi ikon standar cloud_done dan wifi_off agar tidak tampil sebagai teks panjang yang menabrak elemen lain.
- Penyelarasan Rumus Estimasi Lokal Saat Offline:
  Menyesuaikan perhitungan rendemen sementara pada fungsi antrean offline di app.js agar hasil estimasi sementara yang tampil di layar saat tanpa internet tetap selaras dengan logika dasar server.

---

## 4. Sumber Dataset, Pustaka, dan Aset Pihak Ketiga

- Dataset dan Parameter Produksi:
  Data historis batch produksi dan standar rendemen bawang goreng (target wajar 26 hingga 30 persen) disusun dari data simulasi berbasis observasi proses pengupasan, pengirisan, penggorengan, dan pengemasan pada UMKM bawang goreng.
- Pustaka Backend:
  Python, Flask, dan Flask-CORS untuk penyediaan endpoint REST API dan pengaturan izin akses lintas domain.
- Pustaka Frontend:
  Tailwind CSS Play CDN untuk pengaturan tata letak grid dan responsivitas, Google Fonts (Plus Jakarta Sans) untuk tipografi, serta Google Material Symbols Outlined untuk ikon navigasi dan indikator status jaringan.
- Aset Desain Referensi:
  Struktur layar dan palet warna diambil dari berkas referensi desain Stitch pada folder stitch_rugi_batch_umkm_monitor.
- Layanan Hosting dan Deployment:
  PythonAnywhere untuk menjalankan server backend dan API (https://abiliya.pythonanywhere.com), serta GitHub dan Vercel untuk publikasi web statis berprotokol HTTPS agar Service Worker berjalan aktif.

---

## 5. Pemetaan Endpoint API dan Mekanisme Offline

### Daftar Endpoint Utama
- POST /api/login: Menerima email dan password, mengembalikan access_token dan profil pengguna.
- GET /api/dashboard-summary: Mengambil statistik total batch, rata-rata rendemen, jumlah batch bermasalah, total kerugian rupiah, tahap paling boros, peringatan mingguan, dan data grafik.
- POST /api/analyze-batch: Menerima 9 parameter input produksi dan mengembalikan status batch, rendemen aktual, prediksi rendemen AI, tahap paling bocor, estimasi kerugian, dan daftar rekomendasi pemeriksaan.
- GET /api/batches: Mengambil seluruh daftar riwayat batch beserta rincian hasil analisisnya.

### Mekanisme Penanganan Sinyal Lemah dan Offline
1. Service Worker (sw.js): Menyimpan berkas index.html, style.css, app.js, dan sw.js ke dalam cache rugibatch-v1 menggunakan strategi Cache-First sehingga halaman tetap dapat dimuat ulang tanpa koneksi internet.
2. Batas Waktu Tunggu 8 Detik: Permintaan API dibatasi maksimal 8 detik menggunakan AbortController. Jika sinyal lambat melewati batas tersebut, sistem langsung beralih memuat data cadangan dari memori lokal.
3. Penyimpanan localStorage dan Antrean Sinkronisasi:
  - rugibatch_dashboard_v1: Menyimpan data ringkasan beranda terakhir selama 24 jam.
  - rugibatch_riwayat_v1: Menyimpan daftar riwayat batch terakhir selama 24 jam.
  - rugibatch_offline_queue_v1: Menyimpan antrean catatan batch yang dikirim saat offline dan menyinkronkannya otomatis ke server begitu event window.online aktif.

---

## 6. Panduan Pengujian Tim

- Akun Demo Pengujian: Email sari@bawanghangat.com dengan kata sandi demo123 (tersedia tombol pengisian otomatis di halaman masuk).
- Skenario Uji Batch Normal: Masukkan berat awal 50 kg, harga beli Rp 42.672, kode perlakuan A1, suhu minyak 160 derajat Celcius, lama goreng 10 menit, tahap kupas 43 kg, iris 41,5 kg, goreng 15 kg, dan kemas 14,5 kg untuk memverifikasi status Normal dengan perkiraan rugi Rp 0.
- Pengujian Mode Offline: Service Worker aktif penuh saat aplikasi diakses melalui alamat HTTPS (tautan Vercel) atau localhost. Saat diuji secara offline, pastikan data beranda tetap muncul dari cache lokal dan pengiriman batch baru masuk ke antrean sinkronisasi.
