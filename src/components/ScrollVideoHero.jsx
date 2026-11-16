import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Full-bleed hero where the walk-in video is "scrubbed" by scrolling.
 *
 * Why it's built this way:
 *  1. The whole video is downloaded into memory first (as a blob). On a live
 *     server, seeking into a part of the video that hasn't downloaded yet
 *     stalls — that's what made the scroll effect barely move online.
 *  2. A new seek is only started once the previous one has finished
 *     (video.seeking === false). Firing a seek on every scroll event cancels
 *     the previous one before a frame is ever painted.
 *  3. The playhead eases toward the scroll position, so motion stays smooth
 *     even with a mouse wheel that jumps in big steps.
 *
 * The video should have every frame as a keyframe (-g 1) so seeks are cheap:
 *   ffmpeg -i in.mp4 -an -c:v libx264 -crf 24 -g 1 -pix_fmt yuv420p -movflags +faststart hero-walkin.mp4
 */
export default function ScrollVideoHero({ videoSrc, posterSrc }) {
  const sectionRef = useRef(null);
  const videoRef = useRef(null);
  const introRef = useRef(null);
  const welcomeRef = useRef(null);
  const barRef = useRef(null);

  const [loadPct, setLoadPct] = useState(0);
  const [ready, setReady] = useState(false);

  // 1) Download the whole video, then hand it to the <video> element.
  useEffect(() => {
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
        // Fallback: stream the file normally (scrubbing may be less smooth).
        video.src = videoSrc;
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
  }, [videoSrc]);

  // 2) Map scroll position to the video's playhead.
  useEffect(() => {
    const section = sectionRef.current;
    const video = videoRef.current;
    if (!section || !video) return undefined;

    const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
    let raf = 0;
    let eased = 0;
    let primed = false;

    const scrollProgress = () => {
      const rect = section.getBoundingClientRect();
      const scrollable = Math.max(1, rect.height - window.innerHeight);
      return { progress: clamp(-rect.top / scrollable, 0, 1), visible: rect.bottom > 0 };
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const { progress, visible } = scrollProgress();

      // Ease toward the scroll position (higher = snappier, lower = smoother).
      eased += (progress - eased) * 0.18;
      if (Math.abs(progress - eased) < 0.0005) eased = progress;

      if (visible && video.readyState >= 2 && !video.seeking && Number.isFinite(video.duration)) {
        const target = eased * (video.duration - 0.05);
        if (Math.abs(video.currentTime - target) > 0.015) {
          video.currentTime = target;
        }
      }

      if (introRef.current) {
        const o = clamp(1 - eased * 3.2, 0, 1);
        introRef.current.style.opacity = String(o);
        introRef.current.style.transform = `translateY(${-eased * 60}px)`;
        introRef.current.style.visibility = o < 0.02 ? 'hidden' : 'visible';
      }
      if (welcomeRef.current) {
        welcomeRef.current.style.opacity = String(clamp((eased - 0.62) / 0.25, 0, 1));
      }
      if (barRef.current) {
        barRef.current.style.transform = `scaleX(${eased})`;
      }
    };

    // iOS Safari only allows seeking after the video has been "touched" once.
    const prime = () => {
      if (primed) return;
      primed = true;
      const p = video.play();
      if (p && typeof p.then === 'function') p.then(() => video.pause()).catch(() => {});
    };

    window.addEventListener('touchstart', prime, { passive: true, once: true });
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('touchstart', prime);
    };
  }, []);

  return (
    <section ref={sectionRef} className="hero-scroll" aria-label="Step inside Rabbit Ladders">
      <div className="hero-scroll__sticky">
        <video
          ref={videoRef}
          className="hero-scroll__video"
          poster={posterSrc}
          muted
          playsInline
          preload="auto"
          aria-label="Walking in through the doors of Rabbit Ladders"
        />
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
