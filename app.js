/* ================================================================
   RUGI-BATCH AI — app.js  v4.0  (Offline-First)
   HTML render sepenuhnya mengikuti desain Stitch (kelas Tailwind asli).
   Base API: https://abiliya.pythonanywhere.com

   Struktur:
     §1  Konstanta & state
     §2  Utilitas (toast, loading, error, format)
     §3  Auth (login, logout, togglePassword, fillDemo)
     §4  Navigasi SPA
     §5  Beranda         — GET /api/dashboard-summary (+ LS cache)
     §6  Catat Batch     — form 9 field
     §7  Hasil Analisis  — POST /api/analyze-batch result (+ antrean offline)
     §8  Riwayat         — GET /api/batches + fallback
     §9  API helpers (dengan timeout 8 detik + LS cache)
     §10 Offline queue — sinkronisasi antrean batch offline
     §11 Inisialisasi
   ================================================================ */
'use strict';

/* ---------------------------------------------------------------- §1 ---- */
const API_BASE = 'https://abiliya.pythonanywhere.com';

/** Kunci localStorage */
const LS = {
  DASHBOARD  : 'rugibatch_dashboard_v1',
  RIWAYAT    : 'rugibatch_riwayat_v1',
  OFFLINE_Q  : 'rugibatch_offline_queue_v1',
};

/** Waktu cache dianggap segar (ms) — 15 menit */
const CACHE_TTL = 15 * 60 * 1000;

/** Timeout fetch ke API (ms) */
const FETCH_TIMEOUT = 8000;

const STATE = {
  token        : null,
  username     : 'Bu Sari',
  batchSesi    : [],
  dashboardData: null,
  lastResult   : null,
  riwayatData  : null,
  currentView  : 'beranda',
  isOffline    : false,   // true jika data terakhir dari cache
};

/* ---------------------------------------------------------------- §2 ---- */

/** Tampilkan toast. tipe: 'sukses'|'error'|'info' */
function showToast(title, body = '', tipe = 'sukses') {
  const toast  = document.getElementById('global-toast');
  const icon   = document.getElementById('toast-icon');
  const tTitle = document.getElementById('toast-title');
  const tBody  = document.getElementById('toast-body');
  if (!toast) return;

  const paleta = {
    sukses: { bg: '#2f6b3a', ico: 'task_alt'  },
    error : { bg: '#ba1a1a', ico: 'error'      },
    info  : { bg: '#145224', ico: 'info'       },
  };
  const p = paleta[tipe] || paleta.info;

  toast.style.setProperty('background-color', p.bg, 'important');
  toast.style.color = '#ffffff';
  if (icon)   icon.textContent   = p.ico;
  if (tTitle) tTitle.textContent = title;
  if (tBody)  tBody.textContent  = body;

  toast.classList.remove('hidden', 'toast-hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.add('toast-hidden'), 4500);
}

function showLoading(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `
    <div class="bg-surface-container-lowest rounded-xl p-space-xl flex flex-col items-center justify-center text-center gap-space-md shadow-sm">
      <div class="w-14 h-14 rounded-full border-4 border-surface-container-high border-t-primary animate-spin"></div>
      <div class="flex flex-col gap-space-xs">
        <span class="font-headline-sm text-headline-sm text-on-surface">Sedang memuat data…</span>
        <span class="font-body-md text-body-md text-on-surface-variant">Mohon tunggu sebentar.</span>
      </div>
    </div>`;
}

function showError(id, pesan) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `
    <div class="flex flex-col items-center justify-center gap-space-md py-16 text-center px-space-md">
      <span class="material-symbols-outlined text-[52px] text-error">wifi_off</span>
      <p class="font-headline-sm text-headline-sm text-error max-w-md">${esc(pesan)}</p>
      <button onclick="navigateTo(STATE.currentView)"
        class="mt-2 h-14 px-space-xl rounded-xl bg-primary text-on-primary font-label-lg text-label-lg hover:bg-primary-container transition-colors shadow-md">
        ↺ Coba Lagi
      </button>
    </div>`;
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** Format Rupiah — 1511582 → "Rp 1.511.582" */
function rp(n) {
  if (n == null || isNaN(n)) return 'Rp –';
  return 'Rp ' + Math.round(Number(n)).toLocaleString('id-ID');
}

/** Format desimal koma Indonesia — 31.17 → "31,2" */
function fd(n, d = 1) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/**
 * Ekstrak teks dari alert_mingguan.
 * API: { batch_bocor_7_hari: 2, total_kerugian_7_hari: 1511582.59 }
 */
function alertTeks(a) {
  if (!a) return null;
  if (typeof a === 'string') return a;
  if (typeof a === 'object') {
    if (a.pesan)      return a.pesan;
    if (a.judul)      return a.judul;
    if (a.deskripsi)  return a.deskripsi;
    if (a.message)    return a.message;
    // Bangun kalimat dari kolom yang diketahui
    const bocor = a.batch_bocor_7_hari;
    const rugi  = a.total_kerugian_7_hari;
    if (bocor != null && rugi != null)
      return `Minggu ini ada ${bocor} batch anomali/bocor. Perkiraan rugi ${rp(rugi)}.`;
    return Object.entries(a).filter(([,v])=>v!=null)
      .map(([k,v])=>`${k.replace(/_/g,' ')}: ${typeof v==='number'?v.toLocaleString('id-ID'):v}`)
      .join(' · ');
  }
  return String(a);
}

/**
 * Normalisasi status ke: 'Normal' | 'Waspada' | 'Anomali'
 * API backend mengembalikan 'Normal' atau 'Anomali'
 */
function normSt(s) {
  const v = (s||'').toLowerCase();
  if (v === 'normal')                       return 'Normal';
  if (v === 'waspada')                      return 'Waspada';
  if (v.includes('anomali')||v.includes('bocor')) return 'Anomali';
  return s || 'Normal';
}

/** Badge HTML chip berdasarkan status */
function badge(status) {
  const s = normSt(status);
  if (s === 'Normal')
    return `<div class="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-primary-fixed text-on-primary-fixed-variant font-label-sm text-label-sm"><span class="material-symbols-outlined text-[16px]">check_circle</span><span>✔ Normal</span></div>`;
  if (s === 'Waspada')
    return `<div class="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-secondary-fixed text-on-secondary-fixed-variant font-label-sm text-label-sm"><span class="material-symbols-outlined text-[16px]">warning</span><span>⚠ Waspada</span></div>`;
  return `<div class="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-error-container text-on-error-container font-label-sm text-label-sm"><span class="material-symbols-outlined text-[16px]">cancel</span><span>✖ ${esc(s)}</span></div>`;
}

/** Warna batang kiri kartu */
function barCol(status) {
  const s = normSt(status);
  if (s==='Normal')  return 'bg-primary';
  if (s==='Waspada') return 'bg-secondary-container';
  return 'bg-error';
}

/* ---------------------------------------------------------------- §3 ---- */

function togglePasswordVisibility() {
  const input = document.getElementById('passwordInput');
  const teks  = document.getElementById('toggleText');
  if (!input) return;
  const hidden = input.type === 'password';
  input.type        = hidden ? 'text'     : 'password';
  if (teks) teks.textContent = hidden ? 'Tutup' : 'Lihat';
}

function fillDemoAccount() {
  const em = document.getElementById('emailInput');
  const pw = document.getElementById('passwordInput');
  if (em) em.value = 'sari@bawanghangat.com';
  if (pw) pw.value = 'demo123';
  handleLogin();
}

async function handleLogin() {
  const email   = document.getElementById('emailInput');
  const pwd     = document.getElementById('passwordInput');
  const errBox  = document.getElementById('login-error');
  const errMsg  = document.getElementById('login-error-msg');
  const btn     = document.getElementById('btn-login');
  const spinner = document.getElementById('login-spinner');
  const lbl     = document.getElementById('login-label');

  if (!email || !pwd) return;
  if (errBox) errBox.classList.add('hidden');

  if (spinner) spinner.classList.remove('hidden');
  if (lbl)    lbl.textContent = 'Memproses…';
  if (btn)    btn.disabled = true;

  try {
    const res = await apiFetch('/api/login', {
      method: 'POST',
      body  : JSON.stringify({ email: email.value, password: pwd.value }),
    });
    // Respons: { access_token, pengguna: { nama, email, peran }, status }
    STATE.token    = res.access_token || res.token || null;
    STATE.username = res.pengguna?.nama || res.nama || res.username || 'Pengguna';

    const su = document.getElementById('sidebar-username');
    if (su) su.textContent = STATE.username;

    document.getElementById('page-login').classList.remove('active');
    document.getElementById('page-login').style.display = 'none';
    document.getElementById('app-layout').classList.remove('hidden');
    navigateTo('beranda');

  } catch (err) {
    if (errBox) errBox.classList.remove('hidden');
    if (errMsg) errMsg.textContent = err.message || 'Email atau kata sandi salah. Coba lagi.';
  } finally {
    if (spinner) spinner.classList.add('hidden');
    if (lbl)    lbl.textContent = 'Masuk';
    if (btn)    btn.disabled = false;
  }
}

function handleLogout() {
  STATE.token = STATE.dashboardData = STATE.riwayatData = null;
  STATE.batchSesi = [];

  document.getElementById('app-layout').classList.add('hidden');
  const lp = document.getElementById('page-login');
  lp.style.display = '';
  lp.classList.add('active');

  const em = document.getElementById('emailInput');
  const pw = document.getElementById('passwordInput');
  if (em) em.value = '';
  if (pw) pw.value = '';
}

/* ---------------------------------------------------------------- §4 ---- */

function navigateTo(view) {
  STATE.currentView = view;
  setActiveNav(view);

  document.querySelectorAll('#app-layout .page-view').forEach(el => {
    el.classList.remove('active');
    el.style.display = 'none';
  });

  const peta = {
    'beranda'        : 'page-beranda',
    'catat-batch'    : 'page-catat-batch',
    'hasil-analisis' : 'page-hasil-analisis',
    'riwayat'        : 'page-riwayat',
  };
  const tid = peta[view];
  if (!tid) return;

  const el = document.getElementById(tid);
  if (!el) return;
  el.style.display = 'block';
  requestAnimationFrame(() => el.classList.add('active'));

  if (view === 'beranda')          renderBeranda();
  else if (view === 'catat-batch') renderCatatBatch();
  else if (view === 'riwayat')     renderRiwayat();
  else if (view === 'hasil-analisis') renderHasilAnalisis(STATE.lastResult);

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setActiveNav(view) {
  document.querySelectorAll('.nav-link').forEach(a => {
    if (a.dataset.view === view) {
      a.classList.add('bg-primary-container', 'text-on-primary', 'font-bold', 'shadow-sm');
      a.classList.remove('text-on-surface-variant');
    } else {
      a.classList.remove('bg-primary-container', 'text-on-primary', 'font-bold', 'shadow-sm');
      a.classList.add('text-on-surface-variant');
    }
  });
}

/* ---------------------------------------------------------------- §5  BERANDA ---- */

async function renderBeranda() {
  const c = document.getElementById('page-beranda');
  if (!c) return;

  // Pakai state in-memory jika ada dan masih segar (dalam sesi ini)
  if (STATE.dashboardData && !STATE.isOffline) {
    _htmlBeranda(c, STATE.dashboardData);
    return;
  }

  showLoading('page-beranda');

  try {
    const res = await apiFetch('/api/dashboard-summary');
    const d   = res.data || res;
    STATE.dashboardData = d;
    STATE.isOffline     = false;
    lsSave(LS.DASHBOARD, d);        // simpan ke cache
    _htmlBeranda(c, d);
  } catch (err) {
    // Coba ambil dari cache localStorage
    const cached = lsLoad(LS.DASHBOARD, 24 * 60 * 60 * 1000); // 24 jam
    if (cached) {
      STATE.dashboardData = cached;
      STATE.isOffline     = true;
      _htmlBeranda(c, cached, true /* offline */);
      showToast('Mode Offline', 'Menampilkan data tersimpan. Hubungkan internet untuk memperbarui.', 'info');
    } else {
      showError('page-beranda', 'Tidak ada koneksi internet dan belum ada data tersimpan.');
    }
  }
}

function _htmlBeranda(c, d, offline = false) {
  const alertStr = alertTeks(d.alert_mingguan);
  const alertHTML = alertStr ? `
    <div class="bg-error-container text-on-error-container rounded-xl p-space-lg mb-space-xl shadow-sm relative overflow-hidden">
      <div class="absolute -right-6 -bottom-6 w-32 h-32 rounded-full bg-error/10 pointer-events-none"></div>
      <div class="flex flex-col sm:flex-row items-start sm:items-center gap-space-md relative z-10">
        <div class="w-14 h-14 rounded-xl bg-error flex items-center justify-center shrink-0 shadow-sm text-on-error">
          <span class="material-symbols-outlined text-[36px]" style="font-variation-settings:'FILL' 1;">warning</span>
        </div>
        <div class="flex flex-col">
          <h2 class="font-headline-sm text-headline-sm text-error leading-snug">${esc(alertStr)}</h2>
          <p class="font-body-md text-body-md text-on-surface-variant mt-1">
            Silakan periksa rincian timbangan di bawah ini.
          </p>
        </div>
      </div>
    </div>` : '';

  /* Banner offline — tampil hanya saat data dari cache */
  const offlineBannerHTML = offline ? `
    <div class="bg-[#FFFDE7] border border-[#F2D06B] rounded-xl p-space-md mb-space-lg shadow-sm flex items-start gap-space-md">
      <div class="w-12 h-12 rounded-full bg-secondary-container/20 flex items-center justify-center shrink-0 text-secondary">
        <span class="material-symbols-outlined text-[30px]">wifi_off</span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-secondary text-on-secondary font-label-sm text-label-sm">
            <span class="inline-block w-2 h-2 rounded-full bg-surface"></span>
            Mode Offline (Data Tersimpan)
          </span>
        </div>
        <p class="font-body-sm text-body-sm text-on-surface mt-1">
          Menampilkan data terakhir yang tersimpan di perangkat ini.
          <button onclick="STATE.dashboardData=null; STATE.isOffline=false; renderBeranda();"
            class="ml-2 text-primary font-bold underline hover:no-underline">Muat Ulang</button>
        </p>
      </div>
    </div>` : '';

  /* Badge status Online/Offline di header beranda */
  const statusBadgeHTML = offline
    ? `<div class="flex items-center self-start md:self-center gap-space-sm bg-secondary-fixed text-on-secondary-fixed-variant px-space-md py-space-xs rounded-full shadow-sm">
        <span class="w-3.5 h-3.5 rounded-full bg-secondary inline-block"></span>
        <span class="font-label-md text-label-md">Mode Offline (Data Tersimpan)</span>
      </div>`
    : `<div class="flex items-center self-start md:self-center gap-space-sm bg-primary-fixed text-on-primary-fixed-variant px-space-md py-space-xs rounded-full shadow-sm">
        <span class="w-3.5 h-3.5 rounded-full bg-primary animate-pulse inline-block"></span>
        <span class="font-label-md text-label-md">Online (Tersambung)</span>
      </div>`;

  const grafik = Array.isArray(d.riwayat_grafik) ? d.riwayat_grafik : [];

  c.innerHTML = `
    <div class="flex flex-col w-full">
      ${offlineBannerHTML}
      <!-- Sapaan -->
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-space-md pb-space-lg">
        <div class="flex flex-col">
          <span class="font-label-sm text-label-sm text-secondary font-bold uppercase tracking-wider">Koperasi Pengolah Bawang</span>
          <h1 class="font-headline-lg text-headline-lg text-on-surface leading-tight mt-1">Selamat pagi, ${esc(STATE.username)}</h1>
          <p class="font-body-md text-body-md text-on-surface-variant flex items-center gap-space-xs mt-1">
            <span class="material-symbols-outlined text-[20px] text-primary">calendar_today</span>
            ${new Date().toLocaleDateString('id-ID',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}
          </p>
        </div>
        ${statusBadgeHTML}
      </div>

      ${alertHTML}

      <!-- 4 Kartu Statistik -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-space-md mb-space-xl">

        <div class="bg-surface-container-lowest rounded-xl p-space-md flex flex-col justify-between shadow-sm relative overflow-hidden">
          <div class="absolute left-0 top-0 bottom-0 w-2 bg-primary"></div>
          <div class="pl-2">
            <span class="font-label-md text-label-md text-on-surface-variant block mb-space-xs">Hasil Jadi Rata-rata</span>
            <div class="flex items-baseline gap-1 my-1">
              <span class="font-headline-lg text-headline-lg text-primary leading-none">${fd(d.rendemen_rata_persen)}%</span>
            </div>
            <span class="font-body-sm text-body-sm text-on-surface-variant block mt-2">dari bawang segar <span class="font-bold text-on-surface">(target wajar 26–30%)</span></span>
          </div>
        </div>

        <div class="bg-surface-container-lowest rounded-xl p-space-md flex flex-col justify-between shadow-sm relative overflow-hidden">
          <div class="absolute left-0 top-0 bottom-0 w-2 bg-error"></div>
          <div class="pl-2">
            <span class="font-label-md text-label-md text-on-surface-variant block mb-space-xs">Batch Bermasalah</span>
            <div class="flex items-baseline gap-2 my-1">
              <span class="font-headline-lg text-headline-lg text-error leading-none">${d.batch_bermasalah??0}</span>
              <span class="font-label-lg text-label-lg text-on-surface-variant">dari ${d.total_batch??0} batch</span>
            </div>
            <span class="font-body-sm text-body-sm text-error font-bold block mt-2">Perlu perhatian khusus</span>
          </div>
        </div>

        <div class="bg-surface-container-lowest rounded-xl p-space-md flex flex-col justify-between shadow-sm relative overflow-hidden">
          <div class="absolute left-0 top-0 bottom-0 w-2 bg-secondary"></div>
          <div class="pl-2">
            <span class="font-label-md text-label-md text-on-surface-variant block mb-space-xs">Total Perkiraan Rugi</span>
            <div class="flex items-baseline gap-1 my-1">
              <span class="font-headline-md text-headline-md text-on-surface leading-tight font-bold">${rp(d.total_kerugian_rupiah)}</span>
            </div>
            <span class="font-body-sm text-body-sm text-on-surface-variant block mt-2">akibat susut di luar batas wajar</span>
          </div>
        </div>

        <div class="bg-surface-container-lowest rounded-xl p-space-md flex flex-col justify-between shadow-sm relative overflow-hidden">
          <div class="absolute left-0 top-0 bottom-0 w-2 bg-secondary-container"></div>
          <div class="pl-2">
            <span class="font-label-md text-label-md text-on-surface-variant block mb-space-xs">Tahap Paling Boros</span>
            <div class="flex items-baseline gap-1 my-1">
              <span class="font-headline-sm text-headline-sm text-secondary font-bold leading-tight">${esc(d.tahap_paling_boros||'–')}</span>
            </div>
            <span class="font-body-sm text-body-sm text-secondary font-bold block mt-2">Kehilangan di atas wajar</span>
          </div>
        </div>
      </div>

      <!-- Grafik + Panel Boros -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-space-lg mb-space-xl items-start">

        <!-- Grafik Rendemen -->
        <div class="lg:col-span-8 bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-space-xs mb-space-lg">
            <div>
              <h2 class="font-headline-sm text-headline-sm text-on-surface">Hasil Jadi Tiap Batch</h2>
              <span class="font-body-sm text-body-sm text-on-surface-variant">Catatan ${grafik.length} batch terakhir</span>
            </div>
            <div class="bg-surface-container-high px-space-sm py-1 rounded-lg self-start">
              <span class="font-label-sm text-label-sm text-primary font-bold">Standar: Min. 26%</span>
            </div>
          </div>
          <div class="w-full overflow-x-auto pb-space-sm">
            <div class="relative" style="min-width:${Math.max(620, grafik.length*60+70)}px">
              ${_svgGrafik(grafik)}
            </div>
          </div>
          <div class="mt-space-md pt-space-sm bg-surface-container-low p-space-md rounded-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-space-sm">
            <div class="flex items-center gap-space-md flex-wrap">
              <div class="flex items-center gap-2">
                <span class="w-4 h-4 rounded-full bg-error inline-block"></span>
                <span class="font-label-md text-label-md text-error">Merah = Anomali/Bocor</span>
              </div>
              <div class="flex items-center gap-2">
                <span class="w-4 h-4 rounded-full bg-primary inline-block"></span>
                <span class="font-label-md text-label-md text-primary">Hijau = Normal</span>
              </div>
            </div>
            <span class="font-body-sm text-body-sm text-on-surface-variant italic">Data akurat timbangan gudang</span>
          </div>
        </div>

        <!-- Panel Barang Hilang Berlebih -->
        <div class="lg:col-span-4 bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col justify-between h-full">
          <div>
            <div class="mb-space-md">
              <h2 class="font-headline-sm text-headline-sm text-on-surface">Barang Hilang Berlebih</h2>
              <span class="font-body-sm text-body-sm text-on-surface-variant">Rata-rata selisih hilang per tahap produksi</span>
            </div>
            <div class="flex flex-col gap-space-lg py-space-sm">
              <div class="flex flex-col gap-1.5">
                <div class="flex justify-between items-baseline">
                  <span class="font-label-md text-label-md text-on-surface">1. Sortasi &amp; Kupas</span>
                  <span class="font-headline-sm text-headline-sm text-on-surface-variant">0,4 kg</span>
                </div>
                <div class="w-full bg-surface-container h-8 rounded-lg overflow-hidden p-1">
                  <div class="bg-outline-variant h-full rounded" style="width:24%"></div>
                </div>
                <span class="font-body-sm text-body-sm text-on-surface-variant">Batas toleransi: 0,5 kg (Aman)</span>
              </div>
              <div class="flex flex-col gap-1.5 bg-secondary-fixed/30 p-space-sm rounded-xl relative">
                <div class="flex justify-between items-baseline">
                  <span class="font-label-md text-label-md text-secondary font-bold">${esc(d.tahap_paling_boros||'Penggorengan')}</span>
                  <div class="flex items-center gap-2">
                    <span class="bg-secondary text-on-secondary font-label-sm text-label-sm px-2 py-0.5 rounded shadow-sm">Paling boros!</span>
                  </div>
                </div>
                <div class="w-full bg-surface-container-highest h-10 rounded-lg overflow-hidden p-1">
                  <div class="bg-secondary h-full rounded shadow-sm" style="width:85%"></div>
                </div>
                <span class="font-body-sm text-body-sm text-secondary font-bold">⚠ Kehilangan di atas batas wajar</span>
              </div>
              <div class="flex flex-col gap-1.5">
                <div class="flex justify-between items-baseline">
                  <span class="font-label-md text-label-md text-on-surface">3. Pengemasan</span>
                  <span class="font-headline-sm text-headline-sm text-on-surface-variant">0,2 kg</span>
                </div>
                <div class="w-full bg-surface-container h-8 rounded-lg overflow-hidden p-1">
                  <div class="bg-outline-variant h-full rounded" style="width:12%"></div>
                </div>
                <span class="font-body-sm text-body-sm text-on-surface-variant">Batas toleransi: 0,3 kg (Aman)</span>
              </div>
            </div>
          </div>
          <div class="mt-space-md p-space-sm bg-surface-container-low rounded-lg">
            <p class="font-body-sm text-body-sm text-on-surface-variant leading-relaxed">
              <span class="font-bold text-on-surface">Catatan:</span> Angka di atas menunjukkan kg yang hilang <em>di atas batas wajar</em>.
            </p>
          </div>
        </div>
      </div>

      <!-- CTA Sticky -->
      <div class="sticky bottom-20 lg:bottom-6 z-30 pt-space-sm pb-space-xs">
        <div class="bg-surface/95 backdrop-blur-md p-space-sm rounded-2xl shadow-xl flex items-center justify-between gap-space-md">
          <div class="hidden sm:flex items-center gap-space-sm pl-space-sm">
            <div class="w-10 h-10 rounded-full bg-primary-container text-on-primary-container flex items-center justify-center">
              <span class="material-symbols-outlined text-[24px]">assignment</span>
            </div>
            <div class="flex flex-col">
              <span class="font-label-md text-label-md text-on-surface">Siap menimbang bawang baru?</span>
              <span class="font-body-sm text-body-sm text-on-surface-variant">Batch berikutnya menunggu</span>
            </div>
          </div>
          <button onclick="navigateTo('catat-batch')"
            class="w-full sm:w-auto flex-1 sm:flex-initial flex items-center justify-center gap-space-sm h-[60px] px-space-xl bg-primary text-on-primary font-headline-sm text-headline-sm rounded-xl shadow-md hover:bg-primary-container active:translate-y-0.5 transition-all">
            <span class="material-symbols-outlined text-[32px]">add_circle</span>
            <span>+ Catat Batch Baru</span>
          </button>
        </div>
      </div>
    </div>`;
}

/** SVG grafik rendemen mengikuti struktur Stitch (skala Y otomatis). */
function _svgGrafik(data) {
  if (!data.length) return `<div class="text-center py-12 font-body-md text-body-md text-on-surface-variant">Belum ada data riwayat grafik.</div>`;

  const vals = data.map(b => Number(b.rendemen_aktual_persen ?? 0));
  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);
  const pad  = Math.max((rawMax - rawMin) * 0.3, 6);
  const yMin = Math.max(0,  Math.floor(rawMin - pad));
  const yMax = Math.ceil(rawMax + pad);
  const range = yMax - yMin || 1;

  const W = 60, H = 210, padL = 50, padT = 20, padB = 30;
  const totalW = padL + data.length * W + 10;
  const toY = pct => padT + ((yMax - pct) / range) * H;
  const batasY = toY(26);

  // Grid Y ticks
  const step = Math.round(range / 3) || 1;
  const ticks = [yMin, yMin + step, yMin + 2*step, yMax];

  let gridLines = ticks.map(v => {
    const y = toY(v);
    return `<line stroke="#f2dfd1" stroke-width="1" x1="${padL}" x2="${totalW}" y1="${y}" y2="${y}"/>
    <text fill="#71796f" font-size="12" font-weight="700" text-anchor="end" x="${padL-6}" y="${y+4}">${v}%</text>`;
  }).join('');

  let batasLine = '';
  if (batasY > padT && batasY < padT + H) {
    batasLine = `
      <rect fill="#ffdad6" fill-opacity="0.25" height="${padT+H-batasY}" width="${totalW-padL}" x="${padL}" y="${batasY}"/>
      <line stroke="#71796f" stroke-dasharray="6 6" stroke-width="2.5" x1="${padL}" x2="${totalW}" y1="${batasY}" y2="${batasY}"/>
      <rect fill="#231a11" height="26" rx="4" width="250" x="${padL+20}" y="${batasY-13}"/>
      <text fill="#ffffff" font-size="12" font-weight="700" text-anchor="middle" x="${padL+145}" y="${batasY+4}">--- BATAS WAJAR MINIMAL 26% ---</text>`;
  }

  let pathD = '', circles = '', labels = '';
  data.forEach((item, i) => {
    const x   = padL + i * W + W/2;
    const pct = vals[i];
    const y   = toY(pct);
    const st  = normSt(item.status_batch);
    const anomali = st !== 'Normal';

    if (i > 0) {
      const px  = padL + (i-1)*W + W/2;
      const py  = toY(vals[i-1]);
      pathD += `<line fill="none" stroke="#2F6B3A" stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" x1="${px}" y1="${py}" x2="${x}" y2="${y}"/>`;
    }

    if (anomali) {
      circles += `
        <circle cx="${x}" cy="${y}" fill="#ba1a1a" r="10" stroke="#ffffff" stroke-width="2"/>
        <circle cx="${x}" cy="${y}" fill="none" opacity="0.6" r="14" stroke="#ba1a1a" stroke-width="2"/>
        <rect fill="#ba1a1a" height="24" rx="4" width="70" x="${x-35}" y="${y+16}"/>
        <text fill="#ffffff" font-size="11" font-weight="700" text-anchor="middle" x="${x}" y="${y+32}">✖ ${esc(st)}</text>
        <text fill="#ba1a1a" font-size="12" font-weight="700" text-anchor="middle" x="${x}" y="${y-16}">${fd(pct)}%</text>`;
      labels += `<text fill="#ba1a1a" font-size="11" font-weight="700" text-anchor="middle" x="${x}" y="${padT+H+padB-2}">${esc(item.kode_batch||`B${i+1}`)}</text>`;
    } else {
      circles += `<circle cx="${x}" cy="${y}" fill="#2F6B3A" r="6" stroke="#ffffff" stroke-width="2"/>
        <text fill="#145224" font-size="11" font-weight="700" text-anchor="middle" x="${x}" y="${y-10}">${fd(pct)}%</text>`;
      labels  += `<text fill="#414940" font-size="11" font-weight="700" text-anchor="middle" x="${x}" y="${padT+H+padB-2}">${esc(item.kode_batch||`B${i+1}`)}</text>`;
    }
  });

  return `
    <svg class="w-full h-72" fill="none" viewBox="0 0 ${totalW} ${padT+H+padB+10}" xmlns="http://www.w3.org/2000/svg">
      <rect fill="#FFFBF7" height="${H}" rx="8" width="${totalW-padL}" x="${padL}" y="${padT}"/>
      ${gridLines}
      <line stroke="#c0c9bd" stroke-width="1.5" x1="${padL}" x2="${totalW}" y1="${padT+H}" y2="${padT+H}"/>
      ${batasLine}
      ${pathD}${circles}${labels}
    </svg>`;
}

/* ---------------------------------------------------------------- §6  CATAT BATCH ---- */

function renderCatatBatch() {
  const c = document.getElementById('page-catat-batch');
  if (!c) return;
  if (c.dataset.rendered === '1') return;
  c.dataset.rendered = '1';

  c.innerHTML = `
    <div class="flex flex-col w-full">
      <!-- Banner Mode Online -->
      <div class="w-full bg-[#FFFDE7] p-space-md sm:p-space-lg rounded-xl mb-space-lg shadow-sm flex items-start sm:items-center gap-space-sm sm:gap-space-md">
        <div class="w-12 h-12 rounded-full bg-secondary-container/20 flex items-center justify-center shrink-0 text-secondary">
          <span class="material-symbols-outlined text-[32px]">cloud_done</span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-secondary text-on-secondary font-label-sm text-label-sm tracking-wide">
              <span class="inline-block w-2.5 h-2.5 rounded-full bg-surface animate-pulse"></span>
              Tersambung ke Server AI
            </span>
            <span class="font-label-md text-label-md text-secondary">Analisis dikirim ke abiliya.pythonanywhere.com</span>
          </div>
          <p class="font-body-md text-body-md text-on-surface mt-1 leading-snug">
            Isi timbangan tiap tahap, lalu tekan <strong>Analisis Batch Ini</strong> untuk mendapat hasil AI.
          </p>
        </div>
      </div>

      <!-- Stepper Visual -->
      <div class="bg-surface-container-low p-space-md sm:p-space-lg rounded-xl mb-space-xl shadow-sm">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-space-xs mb-space-md">
          <div class="flex items-center gap-space-xs">
            <span class="material-symbols-outlined text-primary text-[28px]">assignment_turned_in</span>
            <h2 class="font-headline-sm text-headline-sm text-on-surface">Pencatatan Batch Bawang Goreng</h2>
          </div>
          <span class="font-label-md text-label-md px-3 py-1 bg-primary text-on-primary rounded-full w-fit">
            Tahap 1, 2, &amp; 3 Terbuka Lengkap
          </span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-space-sm sm:gap-space-md">
          <div class="flex items-center gap-space-sm p-space-sm bg-primary-container text-on-primary rounded-xl shadow-sm">
            <div class="w-10 h-10 rounded-full bg-on-primary text-primary flex items-center justify-center font-headline-sm text-headline-sm shrink-0">1</div>
            <div class="flex flex-col min-w-0">
              <span class="font-label-md text-label-md text-on-primary truncate">1. Bawang Awal</span>
              <span class="font-label-sm text-label-sm text-on-primary-container truncate font-normal">Bahan mentah &amp; harga</span>
            </div>
          </div>
          <div class="flex items-center gap-space-sm p-space-sm bg-surface-container-high rounded-xl text-on-surface">
            <div class="w-10 h-10 rounded-full bg-surface-container-highest text-on-surface flex items-center justify-center font-headline-sm text-headline-sm shrink-0">2</div>
            <div class="flex flex-col min-w-0">
              <span class="font-label-md text-label-md truncate">2. Timbangan Tiap Tahap</span>
              <span class="font-label-sm text-label-sm text-on-surface-variant truncate font-normal">Kupas, iris, goreng, kemas</span>
            </div>
          </div>
          <div class="flex items-center gap-space-sm p-space-sm bg-surface-container-high rounded-xl text-on-surface">
            <div class="w-10 h-10 rounded-full bg-surface-container-highest text-on-surface flex items-center justify-center font-headline-sm text-headline-sm shrink-0">3</div>
            <div class="flex flex-col min-w-0">
              <span class="font-label-md text-label-md truncate">3. Periksa &amp; Kirim</span>
              <span class="font-label-sm text-label-sm text-on-surface-variant truncate font-normal">Audit susut AI otomatis</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Error banner -->
      <div id="form-error" class="hidden mb-space-md p-space-md rounded-xl bg-error-container text-on-error-container font-label-md text-label-md flex items-center gap-space-xs">
        <span class="material-symbols-outlined">error</span>
        <span id="form-error-msg">Terjadi kesalahan.</span>
      </div>

      <form class="flex flex-col gap-space-xl" id="form-catat-batch" onsubmit="event.preventDefault(); submitAnalisis();" novalidate>

        <!-- SEKSI 1: DATA BAWANG AWAL -->
        <section class="bg-surface-container-lowest rounded-xl p-space-md sm:p-space-lg shadow-sm">
          <div class="flex items-center gap-space-sm pb-space-sm mb-space-lg">
            <div class="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-on-primary font-bold shrink-0">1</div>
            <div class="flex flex-col">
              <h3 class="font-headline-sm text-headline-sm text-on-surface">Langkah 1: Data Bawang Awal</h3>
              <p class="font-body-sm text-body-sm text-on-surface-variant">Catat informasi sebelum bawang mulai diproses di wajan.</p>
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-space-lg">

            <!-- Berat Segar -->
            <div class="flex flex-col gap-space-xs md:col-span-2">
              <label class="font-label-md text-label-md text-on-surface flex items-center justify-between" for="f-berat-awal">
                <span>Berat Bawang Merah Segar (Mentah)</span>
                <span class="font-label-sm text-label-sm text-primary font-bold">Wajib Diisi</span>
              </label>
              <div class="flex items-center gap-space-sm">
                <button aria-label="Kurangi" class="w-16 h-14 bg-surface-container-high active:bg-surface-variant text-on-surface rounded-xl flex items-center justify-center select-none shadow-sm hover:opacity-90 active:scale-95 transition-all font-bold" onclick="adj('f-berat-awal',-5,5)" type="button">
                  <span class="material-symbols-outlined text-[32px]">remove</span>
                </button>
                <div class="relative flex-1">
                  <input class="h-14 w-full text-center bg-surface-container-lowest rounded-xl font-headline-md text-headline-md text-on-surface focus:outline-none focus:ring-4 focus:ring-primary/20"
                    id="f-berat-awal" name="berat_awal_kg" type="number" min="5" step="1" value="50" required oninput="calcSum()"/>
                  <span class="absolute right-4 top-1/2 -translate-y-1/2 font-headline-sm text-headline-sm text-on-surface-variant select-none pointer-events-none">kg</span>
                </div>
                <button aria-label="Tambah" class="w-16 h-14 bg-surface-container-high active:bg-surface-variant text-on-surface rounded-xl flex items-center justify-center select-none shadow-sm hover:opacity-90 active:scale-95 transition-all font-bold" onclick="adj('f-berat-awal',5,5)" type="button">
                  <span class="material-symbols-outlined text-[32px]">add</span>
                </button>
              </div>
              <p class="font-body-md text-body-md text-on-surface-variant mt-1">
                <span class="material-symbols-outlined text-base align-middle text-primary">scale</span>
                Timbang bawang mentah dalam karung lalu isi angkanya di sini.
              </p>
            </div>

            <!-- Harga per kg -->
            <div class="flex flex-col gap-space-xs">
              <label class="font-label-md text-label-md text-on-surface" for="f-harga">Harga Beli per Kilogram (Rp)</label>
              <div class="relative flex items-center">
                <span class="absolute left-4 font-headline-sm text-headline-sm text-on-surface-variant select-none">Rp</span>
                <input class="h-14 w-full pl-14 pr-space-md bg-surface-container-lowest rounded-xl font-headline-sm text-headline-sm text-on-surface focus:outline-none focus:ring-4 focus:ring-primary/20"
                  id="f-harga" name="harga_per_kg" type="number" min="1000" step="500" value="35000" required />
              </div>
              <p class="font-body-sm text-body-sm text-on-surface-variant">Harga dari nota pembelian petani atau pasar induk.</p>
            </div>

            <!-- Kode Perlakuan -->
            <div class="flex flex-col gap-space-xs">
              <label class="font-label-md text-label-md text-on-surface" for="f-kode">Kode Perlakuan / Metode Goreng</label>
              <input class="h-14 px-space-md bg-surface-container-lowest rounded-xl font-label-md text-label-md text-on-surface focus:outline-none focus:ring-4 focus:ring-primary/20"
                id="f-kode" name="kode_perlakuan" type="text" placeholder="Contoh: A1" value="A1" required />
              <p class="font-body-sm text-body-sm text-on-surface-variant">Kode SOP wajan yang digunakan hari ini.</p>
            </div>

            <!-- Suhu + Durasi -->
            <div class="grid grid-cols-2 gap-space-sm">
              <div class="flex flex-col gap-space-xs">
                <label class="font-label-sm text-label-sm text-on-surface-variant" for="f-suhu">Suhu Minyak</label>
                <div class="relative">
                  <input class="h-12 w-full px-3 bg-surface-container-lowest rounded-lg font-label-md text-label-md text-on-surface focus:outline-none"
                    id="f-suhu" name="suhu_goreng_c" type="number" min="100" max="250" step="5" value="160" required />
                  <span class="absolute right-2 top-1/2 -translate-y-1/2 font-label-sm text-label-sm text-on-surface-variant select-none">°C</span>
                </div>
              </div>
              <div class="flex flex-col gap-space-xs">
                <label class="font-label-sm text-label-sm text-on-surface-variant" for="f-durasi">Lama Goreng</label>
                <div class="relative">
                  <input class="h-12 w-full px-3 bg-surface-container-lowest rounded-lg font-label-md text-label-md text-on-surface focus:outline-none"
                    id="f-durasi" name="durasi_menit" type="number" min="1" max="120" step="1" value="18" required />
                  <span class="absolute right-2 top-1/2 -translate-y-1/2 font-label-sm text-label-sm text-on-surface-variant select-none">mnt</span>
                </div>
              </div>
            </div>

          </div>
        </section>

        <!-- SEKSI 2: BERAT TIAP TAHAP -->
        <section class="bg-surface-container-lowest rounded-xl p-space-md sm:p-space-lg shadow-sm">
          <div class="flex items-center gap-space-sm pb-space-sm mb-space-lg">
            <div class="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-on-primary font-bold shrink-0">2</div>
            <div class="flex flex-col">
              <h3 class="font-headline-sm text-headline-sm text-on-surface">Langkah 2: Berat Setelah Tiap Tahap</h3>
              <p class="font-body-sm text-body-sm text-on-surface-variant">Empat kartu pengukuran berurutan untuk mendeteksi susut terbesar.</p>
            </div>
          </div>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-space-lg">

            ${_kartuTahap(1,'f-t1','berat_tahap1_kupas','Sortasi &amp; Kupas','content_cut','Berat Bawang Bersih (kg)','Timbang bawang setelah dikupas dan dibuang kulit/busuknya.',42,1,'labelSusutKulit','Kulit terbuang:')}
            ${_kartuTahap(2,'f-t2','berat_tahap2_iris','Pengirisan','carpenter','Berat Setelah Diiris (kg)','Timbang setelah proses perajang / slicer manual.',41,0.5,'labelSusutIris','Susut iris:')}
            ${_kartuTahap(3,'f-t3','berat_tahap3_goreng','Penggorengan','skillet','Berat Setelah Ditiriskan (kg)','Bawang setelah keluar wajan dan ditiriskan minyak.',12.6,0.1,'labelSusutGoreng','Kadar air hilang:')}
            ${_kartuTahap(4,'f-t4','berat_tahap4_kemas','Pengemasan','inventory_2','Berat Jadi Dikemas (kg)','Total bawang goreng yang masuk toples / standing pouch.',12.3,0.1,'labelSusutKemas','Remukan/Gagal:')}

          </div>
        </section>

        <!-- Validasi Box -->
        <div class="bg-primary-fixed/30 p-space-md sm:p-space-lg rounded-xl shadow-sm flex items-start gap-space-sm sm:gap-space-md transition-all" id="validasiBox">
          <div class="w-12 h-12 rounded-full bg-primary flex items-center justify-center text-on-primary shrink-0" id="validasiIconWrap">
            <span class="material-symbols-outlined text-[30px]" id="validasiIcon">task_alt</span>
          </div>
          <div class="flex-1 min-w-0">
            <h4 class="font-headline-sm text-headline-sm text-on-surface" id="validasiJudul">Pemeriksaan Timbangan Otomatis</h4>
            <p class="font-body-md text-body-md text-on-surface-variant mt-1" id="validasiTeks">
              Isi semua kolom timbangan di atas, sistem akan memeriksa kewajaran angkanya.
            </p>
          </div>
        </div>

        <!-- SEKSI 3: RINGKASAN & SUBMIT -->
        <section class="bg-surface-container-low rounded-xl p-space-md sm:p-space-lg shadow-sm">
          <div class="flex items-center gap-space-sm pb-space-sm mb-space-md">
            <div class="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-on-primary font-bold shrink-0">3</div>
            <div>
              <h3 class="font-headline-sm text-headline-sm text-on-surface">Langkah 3: Periksa Ringkasan dan Analisis</h3>
              <p class="font-body-sm text-body-sm text-on-surface-variant">Pastikan alur timbangan sesuai sebelum dikirim ke AI.</p>
            </div>
          </div>

          <!-- Ringkasan 4 kolom -->
          <div class="bg-surface-container-lowest rounded-xl p-space-md sm:p-space-lg mb-space-lg shadow-sm">
            <div class="grid grid-cols-2 md:grid-cols-4 gap-space-md text-center">
              <div class="flex flex-col p-space-xs bg-surface-container-low rounded-xl">
                <span class="font-label-sm text-label-sm text-on-surface-variant">Bawang Segar</span>
                <span class="font-headline-md text-headline-md text-on-surface mt-1" id="sum-segar">50 kg</span>
                <span class="font-label-sm text-label-sm text-primary font-bold">Bahan Awal (100%)</span>
              </div>
              <div class="flex flex-col p-space-xs bg-surface-container-low rounded-xl">
                <span class="font-label-sm text-label-sm text-on-surface-variant">Bawang Kupas</span>
                <span class="font-headline-md text-headline-md text-on-surface mt-1" id="sum-kupas">42 kg</span>
                <span class="font-label-sm text-label-sm text-on-surface-variant" id="sum-kupas-pct">Sisa 84,0%</span>
              </div>
              <div class="flex flex-col p-space-xs bg-surface-container-low rounded-xl">
                <span class="font-label-sm text-label-sm text-on-surface-variant">Setelah Goreng</span>
                <span class="font-headline-md text-headline-md text-on-surface mt-1" id="sum-goreng">12,6 kg</span>
                <span class="font-label-sm text-label-sm text-on-surface-variant" id="sum-goreng-pct">Sisa 25,2%</span>
              </div>
              <div class="flex flex-col p-space-xs bg-primary-fixed/40 rounded-xl">
                <span class="font-label-sm text-label-sm text-primary">Hasil Kemas Jadi</span>
                <span class="font-headline-md text-headline-md text-primary mt-1" id="sum-kemas">12,3 kg</span>
                <span class="font-label-sm text-label-sm text-primary font-bold" id="sum-kemas-pct">Hasil Akhir: 24,6%</span>
              </div>
            </div>
          </div>

          <!-- Tombol Aksi -->
          <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-space-md pt-space-xs">
            <button type="button" onclick="navigateTo('beranda')"
              class="h-14 px-space-lg rounded-xl bg-surface-container-high text-on-surface active:bg-surface-variant font-label-lg text-label-lg flex items-center justify-center gap-space-xs shadow-sm active:scale-98 transition-all order-2 sm:order-1">
              <span class="material-symbols-outlined text-[24px]">arrow_back</span>
              <span>Kembali ke Beranda</span>
            </button>
            <button id="btn-analisis" type="submit"
              class="h-[60px] px-space-xl rounded-xl bg-primary text-on-primary hover:bg-primary-container active:scale-98 font-headline-sm text-headline-sm flex items-center justify-center gap-space-sm shadow-md transition-all order-1 sm:order-2">
              <span id="analisis-spinner" class="hidden w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
              <span class="material-symbols-outlined text-[30px]" id="analisis-icon">calculate</span>
              <span id="analisis-label">Analisis Batch Ini</span>
            </button>
          </div>
        </section>
      </form>
    </div>`;

  // Pasang listener update ringkasan
  ['f-berat-awal','f-t1','f-t2','f-t3','f-t4'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', calcSum);
  });
  calcSum();
}

function _kartuTahap(no, id, name, judul, ico, label, hint, def, step, lblId, lblTeks) {
  return `
    <div class="bg-surface-container-low rounded-xl p-space-md sm:p-space-lg flex flex-col justify-between shadow-sm relative overflow-hidden">
      <div class="flex flex-col gap-space-sm">
        <div class="flex items-center justify-between">
          <span class="font-label-lg text-label-lg text-primary font-bold">${no}. ${judul}</span>
          <span class="material-symbols-outlined text-primary text-[28px]">${ico}</span>
        </div>
        <label class="font-label-md text-label-md text-on-surface mt-2" for="${id}">${label}</label>
        <div class="flex items-center gap-space-xs">
          <button aria-label="Kurangi" class="w-14 h-14 bg-surface rounded-xl active:bg-surface-container-highest text-on-surface flex items-center justify-center shadow-sm text-xl font-bold" onclick="adj('${id}',${-step},0)" type="button">
            <span class="material-symbols-outlined text-[26px]">remove</span>
          </button>
          <div class="relative flex-1">
            <input class="h-14 w-full text-center bg-surface-container-lowest rounded-xl font-headline-sm text-headline-sm text-on-surface focus:outline-none focus:ring-4 focus:ring-primary/20"
              id="${id}" name="${name}" type="number" min="0" step="${step}" value="${def}" required oninput="calcSum()"/>
            <span class="absolute right-3 top-1/2 -translate-y-1/2 font-label-md text-label-md text-on-surface-variant select-none pointer-events-none">kg</span>
          </div>
          <button aria-label="Tambah" class="w-14 h-14 bg-surface rounded-xl active:bg-surface-container-highest text-on-surface flex items-center justify-center shadow-sm text-xl font-bold" onclick="adj('${id}',${step},0)" type="button">
            <span class="material-symbols-outlined text-[26px]">add</span>
          </button>
        </div>
        <p class="font-body-sm text-body-sm text-on-surface-variant leading-snug">${hint}</p>
      </div>
      <div class="mt-space-md pt-space-sm bg-surface-container-lowest/70 p-3 rounded-lg flex items-center justify-between">
        <span class="font-body-sm text-body-sm text-on-surface-variant">${lblTeks}</span>
        <span class="font-label-md text-label-md text-on-surface-variant" id="${lblId}">–</span>
      </div>
    </div>`;
}

/** Tombol +/- stepper */
function adj(id, delta, minVal) {
  const el = document.getElementById(id);
  if (!el) return;
  let v = parseFloat(el.value) || 0;
  v = Math.round((v + delta) * 100) / 100;
  if (v < minVal) v = minVal;
  el.value = v;
  calcSum();
}

function calcSum() {
  const f = id => parseFloat(document.getElementById(id)?.value) || 0;
  const segar  = f('f-berat-awal');
  const kupas  = f('f-t1');
  const iris   = f('f-t2');
  const goreng = f('f-t3');
  const kemas  = f('f-t4');
  const pct = v => segar > 0 ? fd((v/segar)*100) + '%' : '–';

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  set('sum-segar',      fd(segar,0) + ' kg');
  set('sum-kupas',      fd(kupas,1) + ' kg');
  set('sum-kupas-pct',  'Sisa ' + pct(kupas));
  set('sum-goreng',     fd(goreng,1) + ' kg');
  set('sum-goreng-pct', 'Sisa ' + pct(goreng));
  set('sum-kemas',      fd(kemas,1)  + ' kg');
  set('sum-kemas-pct',  'Hasil Akhir: ' + pct(kemas));

  // Label susut tiap tahap
  const fmtLoss = (loss, base) => base > 0
    ? fd(loss,1) + ' kg (-' + Math.round((loss/(base||1))*100) + '%)'
    : '–';
  set('labelSusutKulit',  fmtLoss(segar-kupas,  segar));
  set('labelSusutIris',   fmtLoss(kupas-iris,   kupas));
  set('labelSusutGoreng', fmtLoss(iris-goreng,  iris));
  set('labelSusutKemas',  goreng-kemas > 1 ? fd(goreng-kemas,1)+' kg (Tinggi)' : fd(goreng-kemas,1)+' kg (Wajar)');

  // Validasi
  const box   = document.getElementById('validasiBox');
  const wrap  = document.getElementById('validasiIconWrap');
  const ico   = document.getElementById('validasiIcon');
  const judul = document.getElementById('validasiJudul');
  const teks  = document.getElementById('validasiTeks');
  if (!box) return;

  if (kupas > segar && segar > 0) {
    _setValidasi(box,wrap,ico,judul,teks,'error','Periksa Kembali Timbangan Kupas!',
      `Berat setelah kupas (${fd(kupas,1)} kg) tidak mungkin melebihi bawang segar (${fd(segar,1)} kg).`);
  } else if (iris > kupas && kupas > 0) {
    _setValidasi(box,wrap,ico,judul,teks,'error','Periksa Timbangan Irisan!',
      `Berat setelah diiris (${fd(iris,1)} kg) tidak mungkin melebihi bawang kupas (${fd(kupas,1)} kg).`);
  } else if (goreng > iris && iris > 0) {
    _setValidasi(box,wrap,ico,judul,teks,'error','Periksa Timbangan Goreng!',
      `Berat setelah digoreng (${fd(goreng,1)} kg) tidak mungkin melebihi bawang iris (${fd(iris,1)} kg).`);
  } else if (kemas > goreng && goreng > 0) {
    _setValidasi(box,wrap,ico,judul,teks,'error','Periksa Timbangan Kemasan!',
      `Berat dikemas (${fd(kemas,1)} kg) lebih dari hasil goreng (${fd(goreng,1)} kg).`);
  } else if (segar > 0) {
    _setValidasi(box,wrap,ico,judul,teks,'ok','Pemeriksaan Timbangan Otomatis',
      `Alur timbangan wajar. Rendemen ${pct(kemas)} dari ${fd(segar,0)} kg bawang segar.`);
  }
}

function _setValidasi(box, wrap, ico, judul, teks, tipe, judulTeks, teksTeks) {
  if (tipe === 'error') {
    box.className  = 'bg-error-container p-space-md sm:p-space-lg rounded-xl shadow-sm flex items-start gap-space-sm sm:gap-space-md transition-all';
    wrap.className = 'w-12 h-12 rounded-full bg-error flex items-center justify-center text-on-error shrink-0';
    ico.textContent = 'error';
  } else {
    box.className  = 'bg-primary-fixed/30 p-space-md sm:p-space-lg rounded-xl shadow-sm flex items-start gap-space-sm sm:gap-space-md transition-all';
    wrap.className = 'w-12 h-12 rounded-full bg-primary flex items-center justify-center text-on-primary shrink-0';
    ico.textContent = 'task_alt';
  }
  if (judul) judul.textContent = judulTeks;
  if (teks)  teks.textContent  = teksTeks;
}

/* ---------------------------------------------------------------- §7  HASIL ANALISIS ---- */

function renderHasilAnalisis(h) {
  const c = document.getElementById('page-hasil-analisis');
  if (!c) return;

  if (!h) {
    c.innerHTML = `
      <div class="flex flex-col w-full">
        <div class="flex flex-col items-center justify-center gap-space-md py-16 text-center">
          <span class="material-symbols-outlined text-[52px] text-on-surface-variant">search_off</span>
          <p class="font-headline-sm text-headline-sm text-on-surface-variant">Belum ada hasil analisis.<br>Silakan isi form Catat Batch terlebih dahulu.</p>
          <button onclick="navigateTo('catat-batch')"
            class="mt-2 h-14 px-space-xl rounded-xl bg-primary text-on-primary font-label-lg text-label-lg hover:bg-primary-container transition-colors shadow-md">
            Catat Batch Baru
          </button>
        </div>
      </div>`;
    return;
  }

  const st     = normSt(h.status_batch);
  /* Jika status adalah antrean offline, tampilkan halaman khusus */
  if (h._offline === true) {
    _htmlHasilOffline(c, h);
    return;
  }
  const anomali  = st !== 'Normal';
  const waspada  = st === 'Waspada';
  const barCls   = anomali ? (waspada ? 'bg-secondary-container' : 'bg-error') : 'bg-primary';
  const bgCls    = anomali ? (waspada ? 'bg-[#fff8e1]' : 'bg-error-container/40') : 'bg-primary-fixed/10';
  const teksColor = anomali ? (waspada ? 'text-secondary' : 'text-error') : 'text-primary';
  const icoName  = anomali ? (waspada ? 'warning' : 'cancel') : 'check_circle';
  const iconBg   = anomali ? (waspada ? 'bg-secondary' : 'bg-error') : 'bg-primary';

  const rekArr = Array.isArray(h.rekomendasi_pemeriksaan)
    ? h.rekomendasi_pemeriksaan
    : (h.rekomendasi_pemeriksaan ? [h.rekomendasi_pemeriksaan] : []);

  const rekHTML = rekArr.length
    ? rekArr.map((r,i) => `
        <label class="flex items-start gap-space-md bg-surface-container-lowest p-space-md rounded-xl cursor-pointer shadow-sm hover:bg-surface-container transition-colors">
          <input class="w-7 h-7 mt-0.5 rounded accent-primary shrink-0 cursor-pointer" type="checkbox"/>
          <div class="flex flex-col">
            <span class="font-label-lg text-label-lg text-on-surface">${i+1}. ${esc(r)}</span>
          </div>
        </label>`).join('')
    : `<p class="font-body-md text-body-md text-on-surface-variant p-space-sm">Tidak ada rekomendasi khusus.</p>`;

  // Alur 3 tahap (backend hanya ada 3: kupas, goreng, kemas)
  const tahapan = [
    { no:1, label:'Sortasi &amp; Kupas',  berat: h.berat_tahap1_kupas  ?? h.berat_tahap1_kupas },
    { no:2, label:'Penggorengan',          berat: h.berat_tahap3_goreng ?? h.berat_tahap3_goreng },
    { no:3, label:'Pengemasan',            berat: h.berat_tahap4_kemas  ?? h.berat_tahap4_kemas },
  ];
  const bocorTahap = (h.tahap_paling_bocor||'').toLowerCase();
  const tahapHTML = tahapan.map(t => {
    const ib = bocorTahap.includes(String(t.no))||bocorTahap.includes(t.label.replace(/&amp;/g,'').toLowerCase().split(' ')[0]);
    return ib
      ? `<div class="bg-error-container/40 rounded-xl p-space-md shadow-md flex flex-col justify-between gap-space-md relative overflow-hidden">
          <div class="w-2 h-full absolute left-0 top-0 bottom-0 bg-error"></div>
          <div class="flex flex-col gap-space-xs pl-space-xs">
            <div class="flex items-center justify-between">
              <span class="font-label-md text-label-md text-error font-bold">Tahap ${t.no} • Titik Kritis</span>
              <span class="material-symbols-outlined text-error text-[20px]">warning</span>
            </div>
            <span class="font-headline-sm text-headline-sm text-on-surface font-bold">${t.label}</span>
            <span class="font-headline-md text-headline-md text-error font-bold">${t.berat!=null?fd(t.berat,1)+' kg':'–'}</span>
          </div>
          <div class="bg-error text-on-error px-space-sm py-space-xs rounded-lg font-label-sm text-label-sm flex items-center gap-1 font-bold shadow-sm">
            <span class="material-symbols-outlined text-[18px]">cancel</span>
            <span>Bocor: Di sini paling banyak hilang!</span>
          </div>
        </div>`
      : `<div class="bg-surface-container-lowest rounded-xl p-space-md shadow-sm flex flex-col justify-between gap-space-md relative">
          <div class="flex flex-col gap-space-xs">
            <span class="font-label-md text-label-md text-on-surface-variant">Tahap ${t.no}</span>
            <span class="font-headline-sm text-headline-sm text-on-surface">${t.label}</span>
            <span class="font-headline-md text-headline-md text-primary font-bold">${t.berat!=null?fd(t.berat,1)+' kg':'–'}</span>
          </div>
          <div class="bg-primary/10 text-primary px-space-sm py-space-xs rounded-lg font-label-sm text-label-sm flex items-center gap-1 font-bold">
            <span class="material-symbols-outlined text-[18px]">check_circle</span>
            <span>Normal</span>
          </div>
        </div>`;
  }).join('');

  c.innerHTML = `
    <div class="flex flex-col w-full">
      <!-- Breadcrumb -->
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-space-sm pb-space-md">
        <div class="flex items-center gap-space-xs font-label-md text-label-md text-on-surface-variant flex-wrap">
          <button onclick="navigateTo('catat-batch')" class="hover:text-primary cursor-pointer transition-colors">Pencatatan Batch</button>
          <span class="material-symbols-outlined text-[18px]">chevron_right</span>
          <span class="text-on-surface font-bold">Analisis Hasil Produksi ${esc(h.kode_batch||'')}</span>
        </div>
        <div class="flex items-center gap-space-xs bg-surface-container-high px-space-md py-space-xs rounded-full self-start sm:self-auto shadow-sm">
          <span class="w-3 h-3 rounded-full bg-primary animate-pulse inline-block"></span>
          <span class="font-label-sm text-label-sm text-primary">Status Selesai Dihitung</span>
        </div>
      </div>

      <!-- Kartu Status Besar -->
      <div class="${bgCls} rounded-xl p-space-lg flex flex-col md:flex-row items-start md:items-center justify-between gap-space-md shadow-sm relative overflow-hidden">
        <div class="w-3 h-full absolute left-0 top-0 bottom-0 ${barCls}"></div>
        <div class="flex items-start gap-space-md pl-space-xs">
          <div class="w-14 h-14 rounded-xl ${iconBg} flex items-center justify-center text-on-error shrink-0 shadow-sm">
            <span class="material-symbols-outlined text-[36px]" style="font-variation-settings:'FILL' 1;">${icoName}</span>
          </div>
          <div class="flex flex-col gap-space-xs">
            <div class="flex items-center gap-space-sm flex-wrap">
              <span class="font-headline-md text-headline-md ${teksColor} tracking-tight">Status: ${esc(st)}</span>
              ${badge(h.status_batch)}
            </div>
            <p class="font-body-lg text-body-lg text-on-surface font-bold">
              Batch ${esc(h.kode_batch||'')} hasil analisis AI.
            </p>
            <p class="font-body-sm text-body-sm text-on-surface-variant">
              Dihitung pada <strong class="text-on-surface">${new Date().toLocaleDateString('id-ID')}</strong>
            </p>
          </div>
        </div>
        <div class="bg-surface-container-lowest px-space-md py-space-sm rounded-lg shadow-sm text-right self-stretch md:self-auto flex md:flex-col justify-between items-center md:items-end">
          <span class="font-label-sm text-label-sm text-on-surface-variant">ID BATCH</span>
          <span class="font-headline-sm text-headline-sm text-primary tracking-wider font-bold">${esc(h.kode_batch||'–')}</span>
        </div>
      </div>

      <!-- 2 Kartu Komparasi Rendemen -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-space-md mt-space-lg">
        <div class="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col justify-between relative overflow-hidden">
          <div class="w-2 h-full absolute left-0 top-0 bottom-0 bg-primary"></div>
          <div class="flex flex-col gap-space-xs pl-space-xs">
            <div class="flex items-center justify-between">
              <span class="font-label-lg text-label-lg text-on-surface-variant">Hasil Jadi yang Seharusnya (AI)</span>
              <span class="material-symbols-outlined text-primary text-[24px]">verified</span>
            </div>
            <div class="my-space-sm flex items-baseline gap-space-xs">
              <span class="font-headline-lg text-headline-lg text-primary tracking-tight">${fd(h.prediksi_rendemen_ai_persen)}%</span>
              <span class="font-label-md text-label-md text-on-surface-variant">target sistem</span>
            </div>
            <p class="font-body-md text-body-md text-on-surface-variant leading-relaxed">
              Perkiraan AI berdasarkan berat bawang, suhu minyak (${fd(h.suhu_goreng_c,0)}°C), dan durasi goreng.
            </p>
          </div>
          <div class="mt-space-md pt-space-sm bg-surface-container-low rounded-lg p-space-sm pl-space-md">
            <span class="font-label-sm text-label-sm text-primary font-bold">Toleransi Normal: 26,0% – 30,0%</span>
          </div>
        </div>

        <div class="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col justify-between relative overflow-hidden">
          <div class="w-2 h-full absolute left-0 top-0 bottom-0 ${barCls}"></div>
          <div class="flex flex-col gap-space-xs pl-space-xs">
            <div class="flex items-center justify-between">
              <span class="font-label-lg text-label-lg ${teksColor}">Hasil Jadi Aktual Anda</span>
              <span class="material-symbols-outlined ${teksColor} text-[24px]">${anomali?'trending_down':'trending_up'}</span>
            </div>
            <div class="my-space-sm flex items-baseline gap-space-xs">
              <span class="font-headline-lg text-headline-lg ${teksColor} tracking-tight">${fd(h.rendemen_aktual_persen)}%</span>
              ${anomali?`<span class="${iconBg} text-on-error px-space-xs py-0.5 rounded text-[13px] font-bold">${fd(h.rendemen_aktual_persen-h.prediksi_rendemen_ai_persen,1)}%</span>`:''}
            </div>
            <p class="font-body-md text-body-md text-on-surface font-bold leading-relaxed">
              ${anomali?'Keluar dari rentang prediksi normal.':'Sesuai prediksi normal AI.'}
            </p>
          </div>
          <div class="mt-space-md pt-space-sm ${anomali?'bg-error-container/50':'bg-primary-fixed/30'} rounded-lg p-space-sm pl-space-md">
            <span class="font-label-sm text-label-sm ${anomali?'text-on-error-container':'text-primary'} font-bold">
              ${anomali?'• Hilang di luar ambang batas':'• Dalam batas normal ✓'}
            </span>
          </div>
        </div>
      </div>

      <!-- 2 Angka Penting -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-space-md mt-space-md">
        <div class="bg-surface-container-low rounded-xl p-space-lg shadow-sm flex items-center gap-space-md">
          <div class="w-16 h-16 rounded-xl bg-error/10 text-error flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-[36px]">payments</span>
          </div>
          <div class="flex flex-col gap-space-xs">
            <span class="font-label-md text-label-md text-on-surface-variant">Perkiraan Kerugian Modal</span>
            <span class="font-headline-md text-headline-md text-error tracking-tight">${rp(h.estimasi_kerugian_rupiah)}</span>
            <span class="bg-error text-on-error px-space-sm py-1 rounded-full font-label-sm text-label-sm inline-block w-fit">Potensi selisih modal terbuang</span>
          </div>
        </div>
        <div class="bg-surface-container-low rounded-xl p-space-lg shadow-sm flex items-center gap-space-md">
          <div class="w-16 h-16 rounded-xl bg-secondary/15 text-secondary flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-[36px]">scale</span>
          </div>
          <div class="flex flex-col gap-space-xs">
            <span class="font-label-md text-label-md text-on-surface-variant">Tahap Paling Bocor</span>
            <span class="font-headline-md text-headline-md text-secondary tracking-tight">${esc(h.tahap_paling_bocor||'–')}</span>
            <span class="bg-secondary-container text-on-secondary-container px-space-sm py-1 rounded-full font-label-sm text-label-sm inline-block font-bold w-fit">Susut terbesar di tahap ini</span>
          </div>
        </div>
      </div>

      <!-- Alur 3 Tahap -->
      <div class="flex flex-col gap-space-sm mt-space-lg">
        <div class="flex items-center justify-between">
          <h2 class="font-headline-sm text-headline-sm text-on-surface">Pemeriksaan Alur Tahap Produksi</h2>
          <span class="font-label-sm text-label-sm text-on-surface-variant">Bawang Mentah: ${fd(h.berat_awal_kg||0,0)} kg</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-space-md">${tahapHTML}</div>
      </div>

      <!-- Rekomendasi (Checklist) -->
      <div class="bg-surface-container-low rounded-xl p-space-lg shadow-sm flex flex-col gap-space-md mt-space-md">
        <div class="flex flex-col gap-space-xs">
          <div class="flex items-center gap-space-sm">
            <span class="material-symbols-outlined text-secondary text-[28px]">assignment_turned_in</span>
            <h2 class="font-headline-sm text-headline-sm text-on-surface">Yang Perlu Diperiksa Hari Ini</h2>
          </div>
          <p class="font-body-md text-body-md text-on-surface-variant">Centang satu per satu setelah dicek langsung ke bagian produksi:</p>
        </div>
        <div class="flex flex-col gap-space-md pt-space-xs">${rekHTML}</div>
      </div>

      <!-- Accordion: Cara Hitung -->
      <div class="bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden mt-space-md">
        <button onclick="_toggleAk(this)" class="w-full min-h-[56px] px-space-lg py-space-md flex items-center justify-between text-left hover:bg-surface-container-high/50 transition-colors" type="button">
          <div class="flex items-center gap-space-sm">
            <span class="material-symbols-outlined text-primary text-[24px]">calculate</span>
            <span class="font-label-lg text-label-lg text-on-surface">Lihat cara sistem menghitung</span>
          </div>
          <span class="material-symbols-outlined text-on-surface-variant text-[28px] transition-transform duration-200">expand_more</span>
        </button>
        <div class="hidden px-space-lg pb-space-lg pt-space-xs bg-surface-container-low/40">
          <ul class="flex flex-col gap-space-sm font-body-md text-body-md text-on-surface leading-relaxed">
            <li class="flex items-start gap-space-xs"><span class="text-primary font-bold">•</span><span><strong>Prediksi AI:</strong> Dihitung oleh model Random Forest dari berat bawang, suhu minyak, dan lama menggoreng.</span></li>
            <li class="flex items-start gap-space-xs"><span class="text-primary font-bold">•</span><span><strong>Status Normal/Anomali:</strong> Ditentukan oleh Isolation Forest yang membandingkan batch ini dengan pola normal sebelumnya.</span></li>
            <li class="flex items-start gap-space-xs"><span class="text-primary font-bold">•</span><span><strong>Rupiah Kerugian:</strong> Selisih berat di luar toleransi wajar dikalikan harga pokok per kg.</span></li>
            <li class="flex items-start gap-space-xs pt-space-xs text-on-surface-variant"><span class="text-secondary font-bold">•</span><span class="italic font-body-sm text-body-sm">Hasil analisis ini adalah alat bantu deteksi mandiri. Keputusan teknis di dapur tetap sepenuhnya di tangan Anda.</span></li>
          </ul>
        </div>
      </div>

      <!-- Tombol Aksi Bawah -->
      <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-space-md pt-space-md pb-space-lg">
        <button onclick="navigateTo('catat-batch')"
          class="min-h-[56px] px-space-lg rounded-xl bg-secondary-fixed text-on-secondary-fixed hover:bg-secondary-fixed-dim transition-colors font-label-lg text-label-lg flex items-center justify-center gap-space-xs shadow-sm">
          <span class="material-symbols-outlined text-[20px]">add_circle</span>
          <span>Catat Batch Lagi</span>
        </button>
        <button onclick="simpanKeRiwayat()"
          class="min-h-[56px] px-space-xl rounded-xl bg-primary text-on-primary hover:bg-primary-container transition-colors font-label-lg text-label-lg flex items-center justify-center gap-space-xs shadow-md">
          <span class="material-symbols-outlined text-[20px]">save</span>
          <span>Simpan ke Riwayat</span>
        </button>
      </div>
    </div>`;
}

function _toggleAk(btn) {
  const content = btn.nextElementSibling;
  const chevron = btn.querySelector('.material-symbols-outlined.transition-transform');
  if (!content) return;
  const hidden = content.classList.contains('hidden');
  content.classList.toggle('hidden', !hidden);
  if (chevron) chevron.style.transform = hidden ? 'rotate(180deg)' : '';
}

function simpanKeRiwayat() {
  if (STATE.lastResult) {
    const ada = STATE.batchSesi.some(b => b.kode_batch === STATE.lastResult.kode_batch);
    if (!ada) STATE.batchSesi.unshift({ ...STATE.lastResult, _waktu: new Date().toISOString() });
    STATE.riwayatData   = null;
    STATE.dashboardData = null;
  }
  showToast('Tersimpan', 'Data batch berhasil dicatat ke riwayat sesi.', 'sukses');
  setTimeout(() => navigateTo('riwayat'), 800);
}

/* ---------------------------------------------------------------- §8  RIWAYAT ---- */

let _sumberRiwayat = [];

async function renderRiwayat() {
  const c = document.getElementById('page-riwayat');
  if (!c) return;
  if (STATE.riwayatData) { _htmlRiwayat(c, STATE.riwayatData); return; }

  showLoading('page-riwayat');
  try {
    const res  = await apiFetch('/api/batches');
    const list = res.batches || res.data || (Array.isArray(res) ? res : []);
    const kodeAPI = new Set(list.map(b => b.kode_batch));
    const extra   = STATE.batchSesi.filter(b => !kodeAPI.has(b.kode_batch));
    STATE.riwayatData = [...list, ...extra];
    lsSave(LS.RIWAYAT, STATE.riwayatData);    // simpan ke cache
  } catch (_) {
    // 1. Coba cache localStorage
    const cached = lsLoad(LS.RIWAYAT, 24 * 60 * 60 * 1000);
    if (cached) {
      const kodeCache = new Set(cached.map(b => b.kode_batch));
      const extra = STATE.batchSesi.filter(b => !kodeCache.has(b.kode_batch));
      STATE.riwayatData = [...STATE.batchSesi, ...cached.filter(g => !STATE.batchSesi.some(s => s.kode_batch === g.kode_batch))];
      showToast('Mode Offline', 'Menampilkan riwayat tersimpan.', 'info');
    } else {
      // 2. Fallback: data sesi + riwayat_grafik
      const grafik = (STATE.dashboardData?.riwayat_grafik || []).map(g => ({
        kode_batch              : g.kode_batch,
        rendemen_aktual_persen  : g.rendemen_aktual_persen,
        status_batch            : g.status_batch,
        estimasi_kerugian_rupiah: null,
        tahap_paling_bocor      : null,
        tanggal                 : null,
      }));
      STATE.riwayatData = [
        ...STATE.batchSesi,
        ...grafik.filter(g => !STATE.batchSesi.some(s => s.kode_batch === g.kode_batch)),
      ];
    }
  }
  _sumberRiwayat = STATE.riwayatData;
  _htmlRiwayat(c, _sumberRiwayat);
}

function _htmlRiwayat(c, daftar) {
  const pertama  = daftar[0] || null;
  const jumlahMasalah = daftar.filter(b => normSt(b.status_batch) !== 'Normal').length;

  const kartuList = !daftar.length
    ? `<div class="py-16 text-center">
        <span class="material-symbols-outlined text-[52px] text-on-surface-variant block mx-auto mb-4">inventory_2</span>
        <p class="font-body-md text-body-md text-on-surface-variant">Belum ada riwayat batch.</p>
        <button onclick="navigateTo('catat-batch')"
          class="mt-4 h-14 px-space-xl rounded-xl bg-primary text-on-primary font-label-lg text-label-lg hover:bg-primary-container shadow-md transition-colors">
          Catat Batch Pertama
        </button>
      </div>`
    : daftar.map((b,i) => _kartuRiwayat(b, i===0)).join('');

  c.innerHTML = `
    <div class="flex flex-col w-full pb-space-xl">
      <!-- Breadcrumb -->
      <div class="flex flex-wrap items-center justify-between gap-space-sm mb-space-md">
        <div class="flex items-center gap-space-xs text-on-surface-variant font-body-sm text-body-sm">
          <span class="material-symbols-outlined text-[20px] text-primary">fact_check</span>
          <span>Pemeriksaan Produksi</span>
          <span>/</span>
          <span class="font-label-sm text-label-sm text-on-surface">Audit Batch Mingguan</span>
        </div>
        <div class="flex items-center gap-space-xs px-space-sm py-1 rounded-full bg-surface-container font-label-sm text-label-sm text-on-surface">
          <span class="w-2.5 h-2.5 rounded-full bg-error animate-pulse inline-block"></span>
          <span>${jumlahMasalah} Batch Perlu Perhatian</span>
        </div>
      </div>

      <!-- Split 42/58 -->
      <div class="flex flex-col lg:flex-row gap-space-lg items-start w-full">

        <!-- KIRI 42% -->
        <div class="w-full lg:w-[42%] flex flex-col gap-space-md">
          <!-- Panel Judul & Filter -->
          <div class="bg-surface-container-lowest p-space-md rounded-xl shadow-sm flex flex-col gap-space-sm">
            <div class="flex items-center justify-between">
              <div>
                <h1 class="font-headline-sm text-headline-sm text-on-surface leading-tight">Riwayat Batch Bawang Goreng</h1>
                <p class="font-body-sm text-body-sm text-on-surface-variant mt-0.5">Pantau susut bobot &amp; potensi rugi tiap wajan</p>
              </div>
              <div class="flex items-center gap-2">
                <button onclick="STATE.riwayatData=null; renderRiwayat();"
                  class="w-9 h-9 rounded-lg bg-surface-container-low flex items-center justify-center hover:bg-surface-container-high transition-colors">
                  <span class="material-symbols-outlined text-primary text-[20px]">refresh</span>
                </button>
                <span class="material-symbols-outlined text-primary text-[32px]">inventory_2</span>
              </div>
            </div>
            <!-- Filter 4 tombol -->
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-space-xs">
              <button id="rfil-semua" onclick="filterRiwayatTab('semua')"
                class="h-12 px-3 rounded-lg bg-primary text-on-primary font-label-sm text-label-sm flex items-center justify-center transition-all shadow-sm">Semua</button>
              <button id="rfil-normal" onclick="filterRiwayatTab('Normal')"
                class="h-12 px-3 rounded-lg bg-surface-container-low text-on-surface hover:bg-surface-container-high font-label-sm text-label-sm flex items-center justify-center gap-1 transition-all">
                <span class="material-symbols-outlined text-[18px] text-primary">check_circle</span><span>Normal</span>
              </button>
              <button id="rfil-waspada" onclick="filterRiwayatTab('Waspada')"
                class="h-12 px-3 rounded-lg bg-surface-container-low text-on-surface hover:bg-surface-container-high font-label-sm text-label-sm flex items-center justify-center gap-1 transition-all">
                <span class="material-symbols-outlined text-[18px] text-secondary">warning</span><span>Waspada</span>
              </button>
              <button id="rfil-anomali" onclick="filterRiwayatTab('Anomali')"
                class="h-12 px-3 rounded-lg bg-surface-container-low text-on-surface hover:bg-surface-container-high font-label-sm text-label-sm flex items-center justify-center gap-1 transition-all">
                <span class="material-symbols-outlined text-[18px] text-error">cancel</span><span>Anomali</span>
              </button>
            </div>
          </div>
          <!-- Daftar Kartu -->
          <div class="flex flex-col gap-space-sm" id="riwayat-list">${kartuList}</div>
        </div>

        <!-- KANAN 58% -->
        <div class="w-full lg:w-[58%] flex flex-col gap-space-lg" id="panel-detail-riwayat">
          ${pertama ? _htmlDetailRiwayat(pertama) : `
            <div class="bg-surface-container-lowest p-space-xl rounded-xl shadow-sm flex flex-col items-center justify-center gap-space-md text-center">
              <span class="material-symbols-outlined text-[52px] text-on-surface-variant">touch_app</span>
              <p class="font-body-md text-body-md text-on-surface-variant">Pilih batch dari daftar di kiri<br>untuk melihat detail pemeriksaannya.</p>
            </div>`}
        </div>
      </div>
    </div>`;

  c._data = daftar;
}

function _kartuRiwayat(b, aktif=false) {
  const st     = normSt(b.status_batch);
  const bc     = barCol(st);
  const tglRaw = b.tanggal || b.dibuat_at || b._waktu || '';
  const tgl    = tglRaw ? tglRaw.slice(0,10) : '–';
  const rugi   = b.estimasi_kerugian_rupiah != null ? rp(b.estimasi_kerugian_rupiah) : '–';

  return `
    <div id="kartu-${esc(b.kode_batch)}"
      class="batch-card group cursor-pointer relative bg-surface-container-lowest rounded-xl p-space-md shadow-sm transition-all${aktif?' ring-2 ring-secondary-container bg-surface-container-low shadow-md':''}"
      onclick="pilihBatch('${esc(b.kode_batch)}')">
      <div class="absolute left-0 top-0 bottom-0 w-2.5 ${bc} rounded-l-xl"></div>
      <div class="pl-2 flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="font-headline-sm text-headline-sm text-on-surface font-bold tracking-tight">${esc(b.kode_batch||'–')}</span>
            ${aktif?`<span class="text-xs px-2 py-0.5 rounded bg-secondary-container/20 text-secondary font-bold">Terpilih</span>`:''}
          </div>
          ${badge(b.status_batch)}
        </div>
        <div class="flex items-center text-on-surface-variant font-body-sm text-body-sm gap-2">
          <span class="material-symbols-outlined text-[18px]">calendar_today</span>
          <span>${esc(tgl)}</span>
          <span>•</span>
          <span class="font-label-sm text-label-sm text-on-surface">Hasil: ${fd(b.rendemen_aktual_persen)}%</span>
        </div>
        <div class="flex items-center justify-between pt-1 border-t border-surface-variant/40">
          <span class="font-body-sm text-body-sm text-on-surface-variant">Perkiraan Rugi:</span>
          <span class="font-label-md text-label-md ${normSt(b.status_batch)==='Normal'?'text-primary':'text-error'}">${rugi}</span>
        </div>
      </div>
    </div>`;
}

function _htmlDetailRiwayat(b) {
  const st     = normSt(b.status_batch);
  const anomali  = st !== 'Normal';
  const icoName  = anomali ? 'error' : 'check_circle';
  const iconBg   = anomali ? 'bg-error' : 'bg-primary';
  const teksColor = anomali ? 'text-error' : 'text-primary';
  const bgPanel   = anomali ? 'bg-error-container/40' : 'bg-primary-fixed/10';
  const tglRaw  = b.tanggal || b.dibuat_at || '–';
  const tgl     = tglRaw !== '–' ? tglRaw.slice(0,10) : '–';

  const rekArr = Array.isArray(b.rekomendasi_pemeriksaan)
    ? b.rekomendasi_pemeriksaan
    : (b.rekomendasi_pemeriksaan ? [b.rekomendasi_pemeriksaan] : []);

  const rekHTML = rekArr.length
    ? rekArr.map((r,i) => `
        <label class="group flex items-start gap-space-md p-space-md rounded-xl bg-surface-container-lowest hover:bg-surface-container cursor-pointer transition-all shadow-sm">
          <input class="w-6 h-6 rounded accent-primary text-primary mt-0.5 cursor-pointer shrink-0" id="chk-riw-${i}" onchange="_chkRiw()" type="checkbox"/>
          <div class="flex flex-col select-none">
            <span class="font-label-lg text-label-lg text-on-surface group-hover:text-primary transition-colors">${i+1}. ${esc(r)}</span>
          </div>
        </label>`).join('')
    : `<p class="font-body-md text-body-md text-on-surface-variant p-space-sm">Tidak ada rekomendasi khusus.</p>`;

  return `
    <!-- Header kartu -->
    <div class="${bgPanel} p-space-md sm:p-space-lg rounded-xl shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-space-md relative overflow-hidden">
      <div class="flex items-start gap-space-md">
        <div class="w-14 h-14 rounded-xl ${iconBg} text-on-error flex items-center justify-center shrink-0 shadow-sm">
          <span class="material-symbols-outlined text-[36px]">${icoName}</span>
        </div>
        <div class="flex flex-col">
          <div class="flex items-center gap-space-sm mb-1">
            <span class="font-headline-sm text-headline-sm text-on-surface font-bold">Detail Batch ${esc(b.kode_batch||'–')}</span>
            ${badge(b.status_batch)}
          </div>
          <p class="font-label-lg text-label-lg ${teksColor} font-bold leading-snug">
            ${anomali?'Batch ini kehilangan lebih banyak dari biasanya.':'Batch ini berjalan normal sesuai standar.'}
          </p>
          <p class="font-body-sm text-body-sm text-on-surface-variant mt-0.5">
            Diproses pada ${esc(tgl)} · Tahap bocor: ${esc(b.tahap_paling_bocor||'Tidak Ada')}
          </p>
        </div>
      </div>
    </div>

    <!-- 3 Kotak Angka -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-space-md">
      <div class="bg-surface-container-lowest p-space-md rounded-xl shadow-sm flex flex-col justify-between">
        <div class="flex items-center justify-between text-on-surface-variant mb-2">
          <span class="font-label-sm text-label-sm">Rendemen / Hasil Jadi</span>
          <span class="material-symbols-outlined text-secondary">pie_chart</span>
        </div>
        <div>
          <div class="font-headline-md text-headline-md text-on-surface font-bold">${fd(b.rendemen_aktual_persen)}%</div>
          <div class="font-body-sm text-body-sm text-on-surface-variant mt-1">
            Prediksi AI: <span class="font-bold text-primary">${fd(b.prediksi_rendemen_ai_persen)}%</span>
          </div>
        </div>
        <div class="mt-3 w-full bg-surface-container h-2 rounded-full overflow-hidden">
          <div class="bg-secondary h-full rounded-full" style="width:${Math.min(100,b.rendemen_aktual_persen||0)}%"></div>
        </div>
      </div>
      <div class="${anomali?'bg-error-container/30':'bg-primary-fixed/20'} p-space-md rounded-xl shadow-sm flex flex-col justify-between">
        <div class="flex items-center justify-between ${teksColor} mb-2">
          <span class="font-label-sm text-label-sm font-bold">Perkiraan Rugi</span>
          <span class="material-symbols-outlined">trending_down</span>
        </div>
        <div>
          <div class="font-headline-md text-headline-md ${teksColor} font-bold">${rp(b.estimasi_kerugian_rupiah)}</div>
          <div class="font-body-sm text-body-sm ${teksColor} mt-1">Potensi selisih modal terbuang</div>
        </div>
        <div class="mt-3 inline-flex items-center gap-1 ${teksColor} font-label-sm text-label-sm">
          <span class="material-symbols-outlined text-[18px]">${anomali?'warning':'check'}</span>
          <span>${anomali?'Nilai susut kritis':'Tidak ada kerugian'}</span>
        </div>
      </div>
      <div class="bg-surface-container-lowest p-space-md rounded-xl shadow-sm flex flex-col justify-between">
        <div class="flex items-center justify-between text-on-surface-variant mb-2">
          <span class="font-label-sm text-label-sm">Bawang Hilang Berlebih</span>
          <span class="material-symbols-outlined text-on-surface">scale</span>
        </div>
        <div>
          <div class="font-headline-md text-headline-md text-on-surface font-bold">${fd(b.berat_hilang_kg,1)} kg</div>
          <div class="font-body-sm text-body-sm text-on-surface-variant mt-1 leading-snug">Tahap: ${esc(b.tahap_paling_bocor||'Tidak Ada')}</div>
        </div>
        <div class="mt-3 font-label-sm text-label-sm text-secondary-container">
          Suhu: ${fd(b.suhu_goreng_c,0)}°C • Durasi: ${fd(b.durasi_menit,0)} mnt
        </div>
      </div>
    </div>

    <!-- Checklist Rekomendasi -->
    <div class="bg-surface-container-low p-space-lg rounded-xl shadow-sm flex flex-col gap-space-md">
      <div class="flex items-center gap-space-sm">
        <div class="w-10 h-10 rounded-lg bg-secondary text-on-secondary flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-[24px]">checklist</span>
        </div>
        <div>
          <h2 class="font-headline-sm text-headline-sm text-on-surface">Yang Perlu Diperiksa Hari Ini</h2>
          <p class="font-body-sm text-body-sm text-on-surface-variant">Centang satu per satu setelah dicek langsung:</p>
        </div>
      </div>
      <div class="flex flex-col gap-space-sm">${rekHTML}</div>
    </div>

    <!-- Tombol Aksi -->
    <div class="flex flex-col sm:flex-row items-center gap-space-md pt-space-xs">
      <button id="btn-mark-checked" onclick="_tandaiDiperiksa()"
        class="w-full sm:flex-1 h-14 px-space-lg rounded-xl bg-primary hover:bg-primary-container text-on-primary font-label-lg text-label-lg flex items-center justify-center gap-space-sm shadow-md transition-all active:scale-[0.99]">
        <span class="material-symbols-outlined text-[24px]">verified</span>
        <span>✔ Tandai Sudah Diperiksa</span>
      </button>
      <button onclick="navigateTo('catat-batch')"
        class="w-full sm:w-auto h-14 px-space-lg rounded-xl bg-surface-container-lowest hover:bg-surface-container text-secondary font-label-lg text-label-lg flex items-center justify-center gap-space-sm shadow-sm transition-all ring-2 ring-secondary active:scale-[0.99]">
        <span class="material-symbols-outlined text-[24px]">add_circle</span>
        <span>+ Catat Batch Baru</span>
      </button>
    </div>

    <!-- Toast sukses diperiksa -->
    <div id="toast-diperiksa" class="hidden p-space-md rounded-xl bg-primary-fixed text-on-primary-fixed-variant flex items-center justify-between gap-space-md shadow-sm">
      <div class="flex items-center gap-space-sm">
        <span class="material-symbols-outlined text-primary text-[28px]">task_alt</span>
        <div>
          <div class="font-label-md text-label-md text-on-surface font-bold">Pemeriksaan ${esc(b.kode_batch||'')} Disimpan!</div>
          <div class="font-body-sm text-body-sm text-on-surface-variant">Catatan kendala telah diteruskan ke log harian penanggung jawab wajan.</div>
        </div>
      </div>
      <button onclick="document.getElementById('toast-diperiksa').classList.add('hidden')" class="p-1 rounded-lg hover:bg-surface-variant/50 text-on-surface-variant" type="button">
        <span class="material-symbols-outlined text-[20px]">close</span>
      </button>
    </div>`;
}

function pilihBatch(kode) {
  const target = _sumberRiwayat.find(b => b.kode_batch === kode);
  if (!target) return;

  document.querySelectorAll('#riwayat-list .batch-card').forEach(el => {
    el.classList.remove('ring-2','ring-secondary-container','bg-surface-container-low','shadow-md');
    const badge = el.querySelector('.text-xs');
    if (badge && badge.textContent.trim() === 'Terpilih') badge.remove();
  });
  const kartu = document.getElementById('kartu-' + kode);
  if (kartu) {
    kartu.classList.add('ring-2','ring-secondary-container','bg-surface-container-low','shadow-md');
    const kodeSpan = kartu.querySelector('.font-headline-sm');
    if (kodeSpan && !kartu.querySelector('.text-xs')) {
      const tk = document.createElement('span');
      tk.className = 'text-xs px-2 py-0.5 rounded bg-secondary-container/20 text-secondary font-bold';
      tk.textContent = 'Terpilih';
      kodeSpan.after(tk);
    }
  }

  const panel = document.getElementById('panel-detail-riwayat');
  if (panel) panel.innerHTML = _htmlDetailRiwayat(target);
}

/** Filter tab riwayat — TIDAK menimpa _sumberRiwayat */
function filterRiwayatTab(tipe) {
  ['semua','Normal','Waspada','Anomali'].forEach(f => {
    const id = 'rfil-' + (f==='semua'?'semua':f.toLowerCase()==='normal'?'normal':f.toLowerCase()==='waspada'?'waspada':'anomali');
    const el = document.getElementById(id);
    if (!el) return;
    if (f === tipe || (tipe==='semua' && f==='semua')) {
      el.className = 'h-12 px-3 rounded-lg bg-primary text-on-primary font-label-sm text-label-sm flex items-center justify-center transition-all shadow-sm';
    } else {
      el.className = 'h-12 px-3 rounded-lg bg-surface-container-low text-on-surface hover:bg-surface-container-high font-label-sm text-label-sm flex items-center justify-center gap-1 transition-all';
    }
  });

  const filtered = tipe==='semua'
    ? _sumberRiwayat
    : _sumberRiwayat.filter(b => normSt(b.status_batch) === tipe);

  const list = document.getElementById('riwayat-list');
  if (!list) return;

  list.innerHTML = filtered.length
    ? filtered.map((b,i) => _kartuRiwayat(b, i===0)).join('')
    : `<div class="text-center py-10 font-body-md text-body-md text-on-surface-variant">Tidak ada batch dengan status "${esc(tipe)}".</div>`;

  if (filtered.length) {
    const panel = document.getElementById('panel-detail-riwayat');
    if (panel) panel.innerHTML = _htmlDetailRiwayat(filtered[0]);
  }
}

function _chkRiw() {
  const checks = document.querySelectorAll('[id^="chk-riw-"]');
  const semua  = Array.from(checks).every(c => c.checked);
  const btn    = document.getElementById('btn-mark-checked');
  if (btn) btn.classList.toggle('animate-pulse', semua);
}

function _tandaiDiperiksa() {
  const t = document.getElementById('toast-diperiksa');
  if (t) {
    t.classList.remove('hidden');
    t.scrollIntoView({ behavior:'smooth', block:'nearest' });
  }
}

/* ---------------------------------------------------------------- §9  API ---- */

/**
 * Wrapper fetch dengan timeout 8 detik.
 * Melempar error bermakna saat jaringan gagal.
 */
async function apiFetch(path, options = {}) {
  const url = API_BASE + path;
  const headers = {
    'Content-Type': 'application/json',
    ...(STATE.token ? { Authorization: 'Bearer ' + STATE.token } : {}),
    ...(options.headers || {}),
  };

  // Buat AbortController untuk timeout manual
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  let res;
  try {
    res = await fetch(url, { ...options, headers, signal: controller.signal });
  } catch (e) {
    clearTimeout(tid);
    throw new Error('offline');
  }
  clearTimeout(tid);

  if (!res.ok) {
    let pesan = `Server error ${res.status}.`;
    try { const j = await res.json(); pesan = j.message || j.error || j.detail || pesan; } catch(_) {}
    throw new Error(pesan);
  }
  return res.json();
}

/* ---- localStorage cache helpers ---- */

/** Simpan data ke localStorage dengan timestamp */
function lsSave(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch (_) { /* storage penuh — abaikan */ }
}

/** Ambil data dari localStorage; kembalikan null jika tidak ada atau kadaluarsa */
function lsLoad(key, maxAgeMs = CACHE_TTL * 10) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > maxAgeMs) return null;
    return data;
  } catch (_) { return null; }
}

async function submitAnalisis() {
  const btn      = document.getElementById('btn-analisis');
  const spinner  = document.getElementById('analisis-spinner');
  const ico      = document.getElementById('analisis-icon');
  const lbl      = document.getElementById('analisis-label');
  const errBox   = document.getElementById('form-error');
  const errMsg   = document.getElementById('form-error-msg');

  if (errBox) errBox.classList.add('hidden');
  if (spinner) spinner.classList.remove('hidden');
  if (ico)    ico.classList.add('hidden');
  if (lbl)    lbl.textContent = 'Menganalisis…';
  if (btn)    btn.disabled = true;

  const payload = {
    berat_awal_kg      : parseFloat(document.getElementById('f-berat-awal')?.value) || 0,
    harga_per_kg       : parseFloat(document.getElementById('f-harga')?.value)      || 0,
    kode_perlakuan     : document.getElementById('f-kode')?.value?.trim() || '',
    suhu_goreng_c      : parseFloat(document.getElementById('f-suhu')?.value)       || 0,
    durasi_menit       : parseFloat(document.getElementById('f-durasi')?.value)     || 0,
    berat_tahap1_kupas : parseFloat(document.getElementById('f-t1')?.value)         || 0,
    berat_tahap2_iris  : parseFloat(document.getElementById('f-t2')?.value)         || 0,
    berat_tahap3_goreng: parseFloat(document.getElementById('f-t3')?.value)         || 0,
    berat_tahap4_kemas : parseFloat(document.getElementById('f-t4')?.value)         || 0,
  };

  try {
    const res       = await apiFetch('/api/analyze-batch', { method: 'POST', body: JSON.stringify(payload) });
    const hasil     = res.hasil || res;
    const kodeBatch = res.kode_batch || hasil.kode_batch || ('BG-' + Date.now());

    STATE.lastResult    = { ...payload, ...hasil, kode_batch: kodeBatch, _offline: false };
    STATE.dashboardData = null;
    STATE.riwayatData   = null;

    showToast('Analisis Selesai', `Batch ${kodeBatch} berhasil dianalisis AI.`, 'sukses');
    navigateTo('hasil-analisis');

  } catch (err) {
    if (err.message === 'offline' || !navigator.onLine) {
      // ======= MODE OFFLINE: simpan ke antrean, tampilkan estimasi =======
      _enqueueOfflineBatch(payload);

      // Hitung estimasi rendemen sederhana (rata-rata industri ~27%)
      const beratAwal   = payload.berat_awal_kg || 1;
      const beratKemas  = payload.berat_tahap4_kemas || 0;
      const rendemenEst = beratAwal > 0 ? (beratKemas / beratAwal) * 100 : 27;

      STATE.lastResult = {
        ...payload,
        kode_batch                  : 'DRAFT-' + Date.now(),
        status_batch                : 'Menunggu Sinkronisasi',
        rendemen_aktual_persen      : rendemenEst,
        prediksi_rendemen_ai_persen : 27,          // rata-rata industri
        tahap_paling_bocor          : '–',
        estimasi_kerugian_rupiah    : 0,
        rekomendasi_pemeriksaan     : 'Data ini masih estimasi lokal. Sinkronkan ke server untuk mendapat analisis AI yang akurat.',
        _offline                    : true,
      };

      showToast('Tersimpan Offline', 'Data batch masuk antrean. Akan dikirim saat online.', 'info');
      navigateTo('hasil-analisis');
    } else {
      const pesan = err.message || 'Gagal menghubungi server analisis.';
      if (errBox) errBox.classList.remove('hidden');
      if (errMsg) errMsg.textContent = pesan;
      showToast('Gagal Analisis', pesan, 'error');
    }
  } finally {
    if (spinner) spinner.classList.add('hidden');
    if (ico)    ico.classList.remove('hidden');
    if (lbl)    lbl.textContent = 'Analisis Batch Ini';
    if (btn)    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------- §10  OFFLINE QUEUE ---- */

/**
 * Tambah payload batch ke antrean offline di localStorage.
 * Setiap item disimpan dengan ID lokal dan timestamp.
 */
function _enqueueOfflineBatch(payload) {
  const queue = _loadQueue();
  const item  = {
    _id      : 'OQ-' + Date.now(),
    _ts      : new Date().toISOString(),
    ...payload,
  };
  queue.push(item);
  _saveQueue(queue);
  _updateQueueBadge();
}

function _loadQueue() {
  try {
    const raw = localStorage.getItem(LS.OFFLINE_Q);
    return raw ? JSON.parse(raw) : [];
  } catch (_) { return []; }
}

function _saveQueue(queue) {
  try {
    localStorage.setItem(LS.OFFLINE_Q, JSON.stringify(queue));
  } catch (_) {}
}

/** Perbarui badge jumlah antrean di tombol Sinkronkan */
function _updateQueueBadge() {
  const q    = _loadQueue();
  const btns = document.querySelectorAll('[data-sync-badge]');
  btns.forEach(b => {
    b.dataset.syncBadge = q.length;
    b.textContent = q.length > 0
      ? `Sinkronkan Sekarang (${q.length})`
      : 'Sinkronkan Sekarang';
  });
}

/**
 * Kirim semua item antrean ke server.
 * Dipanggil saat: (1) window 'online', (2) tombol Sinkronkan Sekarang.
 */
async function syncOfflineQueue() {
  const queue = _loadQueue();
  if (!queue.length) {
    showToast('Antrean Kosong', 'Tidak ada batch yang menunggu sinkronisasi.', 'info');
    return;
  }

  if (!navigator.onLine) {
    showToast('Masih Offline', 'Belum ada koneksi internet. Coba lagi nanti.', 'error');
    return;
  }

  showToast('Menyinkronkan…', `Mengirim ${queue.length} batch ke server.`, 'info');

  const berhasil = [];
  const gagal    = [];

  for (const item of queue) {
    const { _id, _ts, ...payload } = item;
    try {
      const res      = await apiFetch('/api/analyze-batch', { method: 'POST', body: JSON.stringify(payload) });
      const hasil    = res.hasil || res;
      const kodeBatch = res.kode_batch || hasil.kode_batch || _id;
      berhasil.push({ ...payload, ...hasil, kode_batch: kodeBatch });
    } catch (_) {
      gagal.push(item);
    }
  }

  // Simpan kembali hanya yang gagal
  _saveQueue(gagal);
  _updateQueueBadge();

  if (berhasil.length) {
    // Simpan hasil terakhir yang berhasil dan invalidasi cache
    STATE.lastResult    = { ...berhasil[berhasil.length - 1], _offline: false };
    STATE.dashboardData = null;
    STATE.riwayatData   = null;

    // Tambah ke sesi
    berhasil.forEach(h => {
      const ada = STATE.batchSesi.some(b => b.kode_batch === h.kode_batch);
      if (!ada) STATE.batchSesi.unshift({ ...h, _waktu: new Date().toISOString() });
    });

    showToast(
      'Sinkronisasi Berhasil',
      `${berhasil.length} batch berhasil dikirim ke server AI.${gagal.length ? ` ${gagal.length} gagal.` : ''}`,
      'sukses'
    );

    // Jika sedang di halaman hasil analisis, perbarui tampilan
    if (STATE.currentView === 'hasil-analisis') {
      renderHasilAnalisis(STATE.lastResult);
    }
  } else if (gagal.length) {
    showToast('Sinkronisasi Gagal', `${gagal.length} batch masih dalam antrean.`, 'error');
  }
}

/** Halaman hasil analisis khusus status offline (Menunggu Sinkronisasi) */
function _htmlHasilOffline(c, h) {
  const q = _loadQueue();

  c.innerHTML = `
    <div class="flex flex-col w-full">
      <!-- Breadcrumb -->
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-space-sm pb-space-md">
        <div class="flex items-center gap-space-xs font-label-md text-label-md text-on-surface-variant flex-wrap">
          <button onclick="navigateTo('catat-batch')" class="hover:text-primary cursor-pointer transition-colors">Pencatatan Batch</button>
          <span class="material-symbols-outlined text-[18px]">chevron_right</span>
          <span class="text-on-surface font-bold">Hasil Analisis ${esc(h.kode_batch||'')}</span>
        </div>
        <div class="flex items-center gap-space-xs bg-secondary-fixed px-space-md py-space-xs rounded-full self-start sm:self-auto shadow-sm">
          <span class="w-3 h-3 rounded-full bg-secondary inline-block"></span>
          <span class="font-label-sm text-label-sm text-on-secondary-fixed-variant">Menunggu Sinkronisasi</span>
        </div>
      </div>

      <!-- Banner Offline -->
      <div class="bg-[#FFFDE7] border border-[#F2D06B] rounded-xl p-space-lg mb-space-lg shadow-sm">
        <div class="flex flex-col sm:flex-row items-start gap-space-md">
          <div class="w-14 h-14 rounded-xl bg-secondary flex items-center justify-center shrink-0 text-on-secondary shadow-sm">
            <span class="material-symbols-outlined text-[36px]" style="font-variation-settings:'FILL' 1;">cloud_off</span>
          </div>
          <div class="flex flex-col gap-space-xs">
            <h2 class="font-headline-sm text-headline-sm text-secondary">Hasil Estimasi — Menunggu Sinkronisasi</h2>
            <p class="font-body-md text-body-md text-on-surface-variant">
              Data batch ini tersimpan di perangkat Anda (${q.length} batch dalam antrean).
              Nilai rendemen di bawah adalah <strong>estimasi lokal</strong>, bukan analisis AI.
              Hubungkan internet lalu tekan tombol Sinkronkan untuk mendapat hasil sesungguhnya.
            </p>
            <div class="flex flex-wrap gap-space-sm mt-space-xs">
              <button onclick="syncOfflineQueue()"
                class="h-12 px-space-lg rounded-xl bg-secondary text-on-secondary font-label-lg text-label-lg flex items-center justify-center gap-2 shadow-md hover:opacity-90 transition-all"
                data-sync-badge="${q.length}">
                <span class="material-symbols-outlined text-[22px]">sync</span>
                Sinkronkan Sekarang${q.length > 0 ? ` (${q.length})` : ''}
              </button>
              <button onclick="navigateTo('catat-batch')"
                class="h-12 px-space-md rounded-xl bg-surface-container-high text-on-surface font-label-md text-label-md flex items-center justify-center gap-2 hover:bg-surface-container transition-colors">
                <span class="material-symbols-outlined text-[20px]">add_circle</span>
                Catat Batch Lagi
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Estimasi Rendemen -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-space-md mb-space-lg">
        <div class="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col justify-between relative overflow-hidden border border-[#F2D06B]">
          <div class="w-2 h-full absolute left-0 top-0 bottom-0 bg-secondary-container"></div>
          <div class="pl-space-xs flex flex-col gap-space-xs">
            <span class="font-label-lg text-label-lg text-on-surface-variant">Estimasi Rendemen Lokal</span>
            <div class="flex items-baseline gap-space-xs my-space-sm">
              <span class="font-headline-lg text-headline-lg text-secondary tracking-tight">${fd(h.rendemen_aktual_persen)}%</span>
              <span class="font-label-md text-label-md text-on-surface-variant">estimasi</span>
            </div>
            <p class="font-body-sm text-body-sm text-on-surface-variant">
              Dihitung dari berat kemas ÷ berat awal. Belum diverifikasi AI.
            </p>
          </div>
          <div class="mt-space-md bg-secondary-fixed/30 rounded-lg p-space-sm pl-space-md">
            <span class="font-label-sm text-label-sm text-on-secondary-fixed-variant font-bold">Rata-rata industri: 26–30%</span>
          </div>
        </div>

        <div class="bg-surface-container-lowest rounded-xl p-space-lg shadow-sm flex flex-col justify-between border border-[#E3DACD]">
          <h3 class="font-headline-sm text-headline-sm text-on-surface mb-space-md">Data yang Disimpan</h3>
          <div class="flex flex-col gap-2 font-body-sm text-body-sm text-on-surface-variant">
            <div class="flex justify-between">
              <span>Berat awal</span>
              <span class="font-bold text-on-surface">${fd(h.berat_awal_kg,0)} kg</span>
            </div>
            <div class="flex justify-between">
              <span>Berat kemas</span>
              <span class="font-bold text-on-surface">${fd(h.berat_tahap4_kemas,1)} kg</span>
            </div>
            <div class="flex justify-between">
              <span>Suhu goreng</span>
              <span class="font-bold text-on-surface">${fd(h.suhu_goreng_c,0)} °C</span>
            </div>
            <div class="flex justify-between">
              <span>Durasi goreng</span>
              <span class="font-bold text-on-surface">${fd(h.durasi_menit,0)} menit</span>
            </div>
            <div class="flex justify-between">
              <span>Kode perlakuan</span>
              <span class="font-bold text-on-surface">${esc(h.kode_perlakuan||'–')}</span>
            </div>
            <div class="flex justify-between border-t border-surface-variant/40 pt-2 mt-1">
              <span>ID Lokal</span>
              <span class="font-bold text-secondary text-[13px]">${esc(h.kode_batch||'–')}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Catatan -->
      <div class="bg-surface-container-low rounded-xl p-space-lg shadow-sm flex items-start gap-space-md">
        <span class="material-symbols-outlined text-secondary text-[28px] shrink-0">info</span>
        <p class="font-body-md text-body-md text-on-surface-variant leading-relaxed">
          <strong class="text-on-surface">Catatan:</strong>
          Setelah sinkronisasi berhasil, halaman ini akan memperbarui diri dengan hasil analisis AI yang sesungguhnya
          (status Normal/Anomali, tahap bocor, estimasi rugi dalam Rupiah, dan rekomendasi pemeriksaan spesifik).
        </p>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- §11  INIT ---- */

document.addEventListener('DOMContentLoaded', () => {
  // Pasang event listener semua .nav-link
  document.querySelectorAll('.nav-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const v = a.dataset.view;
      if (v) navigateTo(v);
    });
  });

  // Tampilkan halaman login
  const lp = document.getElementById('page-login');
  if (lp) { lp.style.display = ''; lp.classList.add('active'); }

  // Toast tersembunyi awal
  const toast = document.getElementById('global-toast');
  if (toast) toast.classList.add('toast-hidden');

  /* ---- Offline / Online event handlers ---- */

  // Saat browser kembali online: sinkronkan antrean otomatis
  window.addEventListener('online', () => {
    showToast('Kembali Online', 'Koneksi pulih. Menyinkronkan data batch…', 'sukses');
    setTimeout(() => syncOfflineQueue(), 1500);
    // Muat ulang data yang mungkin expired
    STATE.dashboardData = null;
    STATE.riwayatData   = null;
    if (STATE.currentView === 'beranda') renderBeranda();
    if (STATE.currentView === 'riwayat') renderRiwayat();
  });

  // Saat browser offline: beri tahu pengguna
  window.addEventListener('offline', () => {
    showToast('Koneksi Terputus', 'Anda sedang offline. Data tersimpan tetap bisa diakses.', 'info');
  });

  // SW update tersedia
  window.addEventListener('sw-update-available', () => {
    showToast('Pembaruan Tersedia', 'Versi baru tersedia. Muat ulang halaman untuk memperbarui.', 'info');
  });

  // Perbarui badge antrean awal
  _updateQueueBadge();
});
