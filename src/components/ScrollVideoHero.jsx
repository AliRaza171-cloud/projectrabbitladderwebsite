import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Full-bleed hero where the store walk-in plays as the visitor scrolls.
 *
 * Two ways of showing the walk-in, picked once when the page loads:
 *
 *  • Laptops / landscape screens → a <video> that is downloaded in full
 *    (as a blob) and "scrubbed" by setting currentTime.
 *
 *  • Phones / portrait screens → a sequence of still images drawn on a
 *    <canvas>. Mobile browsers (especially iPhone Safari) often refuse to
 *    show frames of a paused video, so images are the reliable option there.
 *    Frames stream in one by one and the first frame shows straight away.
 *
 * Re-encode the desktop video with every frame as a keyframe:
 *   ffmpeg -i in.mp4 -an -vf fps=15,scale=1280:-2 -c:v libx264 -crf 30 -g 1 -pix_fmt yuv420p -movflags +faststart hero-walkin.mp4
 * Make the phone frames (91 frames, 432×720, centre crop):
 *   ffmpeg -i in.mp4 -vf "fps=12,crop=432:720" -c:v libwebp -quality 60 hero-frames/f_%03d.webp
 */

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function pickMode({ mobileFrames }) {
  const portrait = typeof window !== 'undefined' && window.matchMedia('(max-aspect-ratio: 1/1)').matches;
  return portrait && mobileFrames ? 'frames' : 'video';
}

const frameUrl = ({ path, ext = 'webp', pad = 3 }, i) => `${path}${String(i + 1).padStart(pad, '0')}.${ext}`;

export default function ScrollVideoHero({ videoSrc, posterSrc, mobileFrames, mobilePosterSrc }) {
  const [mode] = useState(() => pickMode({ mobileFrames }));
  const poster = mode === 'frames' ? mobilePosterSrc || posterSrc : posterSrc;

  const sectionRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const framesRef = useRef([]); // Image objects (frames mode)
  const loadedRef = useRef([]); // booleans: which frames have loaded
  const introRef = useRef(null);
  const welcomeRef = useRef(null);
  const barRef = useRef(null);

  const [loadPct, setLoadPct] = useState(0);
  const [ready, setReady] = useState(false);

  // ---------------------------------------------------------------------------
  // 1a) VIDEO mode: download the whole video, then hand it to <video>.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (mode !== 'video') return undefined;
    const video = videoRef.current;
    if (!video) return undefined;

    const controller = new AbortController();
    let objectUrl = '';

    const setVideoBlob = (blob) => {
      objectUrl = URL.createObjectURL(blob);
      video.src = objectUrl;
      video.load();
    };

    (async () => {
      try {
        const res = await fetch(videoSrc, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        if (!res.body || !total) {
          setVideoBlob(await res.blob());
          return;
        }
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          setLoadPct(Math.min(99, Math.round((received / total) * 100)));
        }
        setVideoBlob(new Blob(chunks, { type: 'video/mp4' }));
      } catch (err) {
        if (err.name === 'AbortError') return;
        video.src = videoSrc; // fallback: normal streaming
        video.load();
      }
    })();

    const onReady = () => {
      setLoadPct(100);
      setReady(true);
    };
    video.addEventListener('loadeddata', onReady);

    return () => {
      controller.abort();
      video.removeEventListener('loadeddata', onReady);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mode, videoSrc]);

  // ---------------------------------------------------------------------------
  // 1b) FRAMES mode: load the image sequence (first frame first).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (mode !== 'frames') return undefined;
    const { count } = mobileFrames;
    let cancelled = false;
    let loaded = 0;

    framesRef.current = new Array(count);
    loadedRef.current = new Array(count).fill(false);

    // Load order: first frame, then every 8th frame (so the whole walk-in is
    // roughly scrubbable early), then fill in the rest.
    const order = [0];
    for (const step of [8, 4, 2, 1]) {
      for (let i = 0; i < count; i += step) if (!order.includes(i)) order.push(i);
    }

    let next = 0;
    const PARALLEL = 6;

    const loadNext = () => {
      if (cancelled || next >= order.length) return;
      const i = order[next++];
      const img = new Image();
      img.decoding = 'async';
      img.onload = img.onerror = () => {
        if (cancelled) return;
        if (img.naturalWidth) loadedRef.current[i] = true;
        loaded += 1;
        setLoadPct(Math.round((loaded / count) * 100));
        if (loaded === count) setReady(true);
        loadNext();
      };
      img.src = frameUrl(mobileFrames, i);
      framesRef.current[i] = img;
    };

    for (let k = 0; k < PARALLEL; k++) loadNext();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, mobileFrames?.path, mobileFrames?.count]);

  // ---------------------------------------------------------------------------
  // 2) Map scroll position to the walk-in (both modes).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return undefined;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas ? canvas.getContext('2d') : null;

    let raf = 0;
    let eased = 0;
    let drawnIndex = -1;
    let primed = false;

    // Keep the canvas at the screen's real pixel size (sharp on retina).
    const sizeCanvas = () => {
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        drawnIndex = -1; // force a redraw
      }
    };

    // Draw an image so it covers the canvas (like CSS object-fit: cover).
    const drawCover = (img) => {
      const cw = canvas.width;
      const ch = canvas.height;
      const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
    };

    // Nearest frame that has loaded (looks backwards first, then forwards).
    const nearestLoaded = (i) => {
      const ok = loadedRef.current;
      for (let d = 0; d < ok.length; d++) {
        if (ok[i - d]) return i - d;
        if (ok[i + d]) return i + d;
      }
      return -1;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);

      const rect = section.getBoundingClientRect();
      const scrollable = Math.max(1, rect.height - window.innerHeight);
      const progress = clamp(-rect.top / scrollable, 0, 1);
      const visible = rect.bottom > 0;

      eased += (progress - eased) * 0.18;
      if (Math.abs(progress - eased) < 0.0005) eased = progress;

      if (visible && mode === 'frames' && ctx) {
        sizeCanvas();
        const count = loadedRef.current.length;
        const want = Math.round(eased * (count - 1));
        const idx = nearestLoaded(want);
        if (idx !== -1 && idx !== drawnIndex) {
          drawCover(framesRef.current[idx]);
          drawnIndex = idx;
        }
      }

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

    // Video mode on touch devices: unlock seeking with one play/pause.
    const prime = () => {
      if (primed || !video) return;
      primed = true;
      const p = video.play();
      if (p && typeof p.then === 'function') p.then(() => video.pause()).catch(() => {});
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
          <video
            ref={videoRef}
            className="hero-scroll__video"
            poster={poster}
            muted
            playsInline
            preload="auto"
            aria-label="Walking in through the doors of Rabbit Ladders"
          />
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
