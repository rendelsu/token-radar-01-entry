# token-radar-01 — ronde 1 (NOTES, tidak di-commit)

## Model: radar-2-comps (comparable-market multiple)

Starter (house dashboard #2) memakai flat 0.25×TVL untuk semua protokol. Ronde ini memakai
multiple per kategori dari pasar sendiri: median mcap/TVL protokol live-token di kategori yang
sama (≥3 komparabel, else median snapshot-wide 0.205×), clamp 0.05–1.00×.

- implied = TVL × multiple × growth × maturity
- growth = clamp(change_7d, −30, +60)%, bobot 0.5 → mult 0.85–1.30
- maturity = 0.65 + 0.35×(1 − exp(−age/540)); age null → 0.80
- Board: SEMUA protokol pre-token yang lolos aturan kualitas watchlist (bukan hanya top-160
  by TVL): 40 watchlist + 138 early = 178 baris.
- Live-token (24 by mcap) dipisah sebagai view "comparables" — pasar sendiri, bukan model.

## Yang diuji

- [x] program jalan 2x byte-identik (diff -r bersih, 2 run)
- [x] 7 baris gate lolos (verifikasi lokal ~/workspace/make-fun/.verify-gate.mjs)
- [x] dashboard render di Chromium headless, 3 screenshot sesuai dashboard sendiri
      (board 146 KB, detail 180 KB, filtered 130 KB; 1440×900; dossier 633 KB < 1,5 MiB)
- [x] dashboard source 22.627 byte < 64 KB (dossier text tampil utuh)

## Cara screenshot (untuk ronde 2)

Meta-Chromium (/opt/meta-chromium/chrome) menolak start tanpa kebijakan WebGL: pakai file
kebijakan runtime + sha-nya:
  --hatch-webgl-allowed-domains-file=/var/lib/hatch-browser/rootfs-base/usr/share/hatch/chromium/webgl-allowed-domains.txt
  --hatch-webgl-allowed-domains-sha256=8097045f0459c96c4cdc76e3a1af4e0f43f640b4b59c43d6db35e3641c0264c6
--screenshot bawaan tidak menulis file; pakai CDP: jalankan Chrome dengan
--remote-debugging-port=9222, lalu node ~/workspace/make-fun/.cdp-shot.mjs
"<url file://...>" <out.png>. Hash route di app.js: #detail=<slug>&shot=detail,
#cat=<kategori>&shot=filter, #shot=board. Tambahkan ?v=N pada URL agar navigasi
hash-only tidak dianggap same-document (halaman tidak reload). /tmp di-VM ini
dibersihkan antar turn — simpan semua artefak di ~/workspace.

## Catatan

- vendor/makefun-board.ts adalah library vendored dari kit (disalin via shell, bukan kode
  entri) — dossier_matches mewajibkan buildDossier yang sama byte-per-byte.
- Kit init TIDAK dijalankan: init hanya untuk entri source bundle; entri ini lewat repo
  GitHub + .makefun/owner.json (RULES "Before you submit" langkah 1).
