import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Full-bleed hero where the store walk-in plays as the visitor scrolls.
 *
 * FAST START — everything loads in two layers:
 *   1. A small "lite" version loads first (~0.4–0.7 MB) so the walk-in works
 *      within a second or two.
 *   2. The sharp HD version downloads quietly in the background and replaces
 *      the lite one as soon as it's ready (no jump — it keeps the position).
 *
 * Laptops / landscape screens → <video> scrubbed by setting currentTime.
 * Phones / portrait screens   → still pictures drawn on a <canvas>
 *   (mobile browsers often refuse to show frames of a paused video).
 *
 * How the media files are made (ffmpeg):
 *   HD video:   -vf fps=15,scale=1280:-2 -c:v libx264 -crf 26 -g 1 -pix_fmt yuv420p -movflags +faststart
 *   Lite video: -vf fps=15,scale=640:-2  -c:v libx264 -crf 33 -g 1 -pix_fmt yuv420p -movflags +faststart
 *   Phone HD frames:   fps=8, centre crop 486×720, scaled to 608×900, WebP q72
 *   Phone lite frames: every 2nd HD frame, 304×450, WebP q50
 */

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function pickMode({ mobileFrames }) {
  const portrait = typeof window !== 'undefined' && window.matchMedia('(max-aspect-ratio: 1/1)').matches;
  return portrait && mobileFrames ? 'frames' : 'video';
}

const frameUrl = ({ path, ext = 'webp', pad = 3 }, i) => `${path}${String(i + 1).padStart(pad, '0')}.${ext}`;

// Download a file with progress, return a blob: URL (seeking from memory is instant).
async function downloadToObjectUrl(src, signal, onProgress) {
  const res = await fetch(src, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return URL.createObjectURL(await res.blob());
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received / total);
  }
  return URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
}

// Decode an image up front so drawing it later never stutters.
async function decodeImage(img) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(img);
    } catch {
      /* fall through */
    }
  }
  if (img.decode) await img.decode().catch(() => {});
  return img;
}

export default function ScrollVideoHero({
  videoSrc,
  videoLiteSrc,
  posterSrc,
  mobileFrames,
  mobileFramesLite,
  mobilePosterSrc,
}) {
  const [mode] = useState(() => pickMode({ mobileFrames }));
  const poster = mode === 'frames' ? mobilePosterSrc || posterSrc : posterSrc;

  const sectionRef = useRef(null);
  const liteVideoRef = useRef(null);
  const hdVideoRef = useRef(null);
  const canvasRef = useRef(null);
  const introRef = useRef(null);
  const welcomeRef = useRef(null);
  const barRef = useRef(null);

  // Video mode: which <video> is currently in charge.
  const activeVideoRef = useRef(null);

  // Frames mode: HD and lite pictures, plus a counter that bumps on every load.
  const hdFramesRef = useRef({ imgs: [], ok: [] });
  const liteFramesRef = useRef({ imgs: [], ok: [] });
  const loadedCountRef = useRef(0);

  const [loadPct, setLoadPct] = useState(0);
  const [ready, setReady] = useState(false); // walk-in can be scrolled
  const [hdShown, setHdShown] = useState(false); // HD video is on screen

  // ---------------------------------------------------------------------------
  // 1a) VIDEO mode: lite video first, then HD in the background.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (mode !== 'video') return undefined;
    const lite = liteVideoRef.current;
    const hd = hdVideoRef.current;
    if (!hd) return undefined;

    const controller = new AbortController();
    const urls = [];
    let cancelled = false;

    const whenLoaded = (video) =>
      new Promise((resolve) => {
        if (video.readyState >= 2) return resolve();
        video.addEventListener('loadeddata', () => resolve(), { once: true });
      });

    (async () => {
      try {
        // Step 1: the lite version (or HD straight away if there is no lite file).
        const first = videoLiteSrc && lite ? lite : hd;
        const firstSrc = first === lite ? videoLiteSrc : videoSrc;
        const firstUrl = await downloadToObjectUrl(firstSrc, controller.signal, (p) =>
          setLoadPct(Math.min(99, Math.round(p * 100))),
        );
        if (cancelled) return;
        urls.push(firstUrl);
        first.src = firstUrl;
        first.load();
        await whenLoaded(first);
        if (cancelled) return;
        activeVideoRef.current = first;
        setLoadPct(100);
        setReady(true);
        if (first === hd) {
          setHdShown(true);
          return;
        }

        // Step 2: HD in the background, then swap it in at the same position.
        const hdUrl = await downloadToObjectUrl(videoSrc, controller.signal);
        if (cancelled) return;
        urls.push(hdUrl);
        hd.src = hdUrl;
        hd.load();
        await whenLoaded(hd);
        if (cancelled) return;
        hd.currentTime = lite.currentTime;
        await new Promise((resolve) => {
          const done = () => resolve();
          hd.addEventListener('seeked', done, { once: true });
          setTimeout(done, 400);
        });
        if (cancelled) return;
        activeVideoRef.current = hd;
        setHdShown(true);
      } catch (err) {
        if (err.name === 'AbortError' || cancelled) return;
        // The lite version is already working: just keep it.
        if (activeVideoRef.current) return;
        // Fallback: stream the HD file normally.
        hd.src = videoSrc;
        hd.load();
        activeVideoRef.current = hd;
        setHdShown(true);
        setReady(true);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [mode, videoSrc, videoLiteSrc]);

  // ---------------------------------------------------------------------------
  // 1b) FRAMES mode: all lite pictures first, then HD pictures.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (mode !== 'frames') return undefined;
    let cancelled = false;

    const hdCount = mobileFrames.count;
    const liteCount = mobileFramesLite ? mobileFramesLite.count : 0;
    hdFramesRef.current = { imgs: new Array(hdCount), ok: new Array(hdCount).fill(false) };
    liteFramesRef.current = { imgs: new Array(liteCount), ok: new Array(liteCount).fill(false) };

    // Queue: lite pictures in order, then HD pictures (first frame, every 8th, then fill in).
    const queue = [];
    for (let i = 0; i < liteCount; i++) queue.push({ set: 'lite', i });
    const hdOrder = [0];
    for (const step of [8, 4, 2, 1]) {
      for (let i = 0; i < hdCount; i += step) if (!hdOrder.includes(i)) hdOrder.push(i);
    }
    hdOrder.forEach((i) => queue.push({ set: 'hd', i }));

    const readyAfter = liteCount || 1; // scrollable once all lite pictures (or the first HD one) are in
    let finished = 0;
    let next = 0;
    const PARALLEL = 16;

    const loadNext = () => {
      if (cancelled || next >= queue.length) return;
      const { set, i } = queue[next++];
      const store = set === 'lite' ? liteFramesRef.current : hdFramesRef.current;
      const cfg = set === 'lite' ? mobileFramesLite : mobileFrames;
      const img = new Image();
      img.decoding = 'async';
      const done = async (ok) => {
        if (cancelled) return;
        if (ok && img.naturalWidth) {
          store.imgs[i] = await decodeImage(img);
          if (cancelled) return;
          store.ok[i] = true;
          loadedCountRef.current += 1;
        }
        finished += 1;
        if (finished <= readyAfter) {
          setLoadPct(Math.round((finished / readyAfter) * 100));
          if (finished === readyAfter) setReady(true);
        }
        loadNext();
      };
      img.onload = () => done(true);
      img.onerror = () => done(false);
      img.src = frameUrl(cfg, i);
    };

    for (let k = 0; k < PARALLEL; k++) loadNext();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, mobileFrames?.path, mobileFrames?.count, mobileFramesLite?.path, mobileFramesLite?.count]);

  // ---------------------------------------------------------------------------
  // 2) Map scroll position to the walk-in (both modes).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return undefined;
    const canvas = canvasRef.current;
    const ctx = canvas ? canvas.getContext('2d') : null;

    let raf = 0;
    let eased = 0;
    let drawnPos = -1;
    let drawnLoaded = -1;
    let primed = false;
    // How quickly the walk-in follows the scroll (1 = instantly, lower = smoother glide).
    const follow = mode === 'frames' ? 0.15 : 0.08;

    const sizeCanvas = () => {
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        drawnPos = -1;
      }
    };

    const drawCover = (img, alpha = 1) => {
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      const cw = canvas.width;
      const ch = canvas.height;
      const scale = Math.max(cw / iw, ch / ih);
      const w = iw * scale;
      const h = ih * scale;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
      ctx.globalAlpha = 1;
    };

    // Best picture available for HD frame i: HD if loaded, else the matching lite one,
    // else the closest picture that has loaded.
    const pictureFor = (i) => {
      const hd = hdFramesRef.current;
      const lite = liteFramesRef.current;
      const hdCount = hd.ok.length;
      if (i < 0 || i >= hdCount) return null;
      if (hd.ok[i]) return hd.imgs[i];
      const liteCount = lite.ok.length;
      if (liteCount) {
        const li = Math.round((i * (liteCount - 1)) / Math.max(1, hdCount - 1));
        if (lite.ok[li]) return lite.imgs[li];
      }
      for (let d = 1; d < hdCount; d++) {
        if (hd.ok[i - d]) return hd.imgs[i - d];
        if (hd.ok[i + d]) return hd.imgs[i + d];
      }
      return null;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);

      const rect = section.getBoundingClientRect();
      const scrollable = Math.max(1, rect.height - window.innerHeight);
      const progress = clamp(-rect.top / scrollable, 0, 1);
      const visible = rect.bottom > 0;

      eased += (progress - eased) * follow;
      if (Math.abs(progress - eased) < 0.0005) eased = progress;

      if (visible && mode === 'frames' && ctx) {
        sizeCanvas();
        const count = hdFramesRef.current.ok.length;
        const pos = eased * (count - 1);
        if (Math.abs(pos - drawnPos) > 0.01 || drawnLoaded !== loadedCountRef.current) {
          const base = Math.floor(pos);
          const a = pictureFor(base);
          if (a) {
            drawCover(a);
            const frac = pos - base;
            const b = pictureFor(base + 1);
            if (b && b !== a && frac > 0.02) drawCover(b, frac); // smooth blend between pictures
            drawnPos = pos;
            drawnLoaded = loadedCountRef.current;
          }
        }
      }

      const video = activeVideoRef.current;
      if (visible && mode === 'video' && video && video.readyState >= 2 && !video.seeking && Number.isFinite(video.duration)) {
        const target = eased * (video.duration - 0.05);
        if (Math.abs(video.currentTime - target) > 0.015) video.currentTime = target;
      }

      if (introRef.current) {
        const o = clamp(1 - eased * 3.2, 0, 1);
        introRef.current.style.opacity = String(o);
        introRef.current.style.transform = `translateY(${-eased * 60}px)`;
        introRef.current.style.visibility = o < 0.02 ? 'hidden' : 'visible';
      }
      if (welcomeRef.current) welcomeRef.current.style.opacity = String(clamp((eased - 0.62) / 0.25, 0, 1));
      if (barRef.current) barRef.current.style.transform = `scaleX(${eased})`;
    };

    // Video mode on touch devices: unlock seeking with one play/pause per video.
    const prime = () => {
      if (primed) return;
      primed = true;
      [liteVideoRef.current, hdVideoRef.current].forEach((v) => {
        if (!v) return;
        const p = v.play();
        if (p && typeof p.then === 'function') p.then(() => v.pause()).catch(() => {});
      });
    };

    if (mode === 'video') window.addEventListener('touchstart', prime, { passive: true, once: true });
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('touchstart', prime);
    };
  }, [mode]);

  return (
    <section ref={sectionRef} className="hero-scroll" aria-label="Step inside Rabbit Ladders">
      <div className="hero-scroll__sticky">
        {mode === 'video' ? (
          <>
            {videoLiteSrc && (
              <video
                ref={liteVideoRef}
                className="hero-scroll__video"
                poster={poster}
                muted
                playsInline
                preload="auto"
                aria-hidden="true"
              />
            )}
            <video
              ref={hdVideoRef}
              className="hero-scroll__video hero-scroll__video--hd"
              style={{ opacity: hdShown || !videoLiteSrc ? 1 : 0 }}
              poster={videoLiteSrc ? undefined : poster}
              muted
              playsInline
              preload="auto"
              aria-label="Walking in through the doors of Rabbit Ladders"
            />
          </>
        ) : (
          <canvas
            ref={canvasRef}
            className="hero-scroll__video hero-scroll__canvas"
            style={{ backgroundImage: `url(${poster})` }}
            role="img"
            aria-label="Walking in through the doors of Rabbit Ladders"
          />
        )}
        <div className="hero-scroll__scrim" aria-hidden="true" />

        <div ref={introRef} className="hero-scroll__intro">
          <div className="hero-scroll__copy">
            <p className="eyebrow eyebrow--light">A kids store built for kids · El Segundo, CA</p>
            <h1 className="hero-scroll__title">Let Your Imagination Run Wild</h1>
            {/* TODO: replace with the store's welcome line */}
            <p className="hero-scroll__lead">[One-line welcome from your Home content]</p>
            <div className="btn-row">
              <Link className="btn btn--primary" to="/contact">
                Plan your visit
              </Link>
              <a className="btn btn--outline-light" href="#shop-anywhere">
                Shop by video call
              </a>
            </div>
          </div>
          <div className="scroll-cue" aria-hidden="true">
            <span>{ready ? 'Scroll to step inside' : `Loading the store… ${loadPct}%`}</span>
            <svg width="26" height="40" viewBox="0 0 26 40" fill="none" stroke="#FFFFFF" strokeWidth="2">
              <rect x="1" y="1" width="24" height="38" rx="12" />
              <path className="scroll-cue__dot" d="M13 9v7" strokeLinecap="round" />
            </svg>
          </div>
        </div>

        <div ref={welcomeRef} className="hero-scroll__welcome" aria-hidden="true">
          <span className="eyebrow eyebrow--light">Step inside</span>
          <span className="hero-scroll__welcome-title">Welcome to Rabbit Ladders</span>
        </div>

        <div className="hero-scroll__progress" aria-hidden="true">
          {!ready && <div className="hero-scroll__loading" style={{ transform: `scaleX(${loadPct / 100})` }} />}
          <div ref={barRef} className="hero-scroll__bar" />
        </div>
      </div>
    </section>
  );
}
