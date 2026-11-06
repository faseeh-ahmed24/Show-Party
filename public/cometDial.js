/**
 * cometDial.js
 *
 * Vanilla JavaScript port of the React Bits <CometDial /> component.
 * Zero React or external motion library dependencies: implements damped harmonic
 * spring physics, pointer-drag velocity tracking, momentum carry, and the 12-segment
 * SVG comet trail natively.
 */

(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const R = 80;
  const DEAD = 44;
  const K = 12;
  const V_FULL = 4;
  const V_FLICK = 2;
  const TAU_FOLLOW = 0.06;
  const TAU_V = 0.05;
  const DECEL = 0.99;
  const DRAG_PX = 10;
  const STALE_MS = 80;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const velocityOf = (hist) => {
    if (hist.length < 2) return 0;
    const a = hist[0];
    const b = hist[hist.length - 1];
    return ((b[1] - a[1]) / Math.max(1, b[0] - a[0])) * 1000;
  };

  const decimalsOf = (step) => {
    const s = String(step);
    const i = s.indexOf('.');
    return i === -1 ? 0 : s.length - i - 1;
  };

  const pointAt = (deg) => {
    const a = (deg * Math.PI) / 180;
    return [100 + Math.cos(a) * R, 100 + Math.sin(a) * R];
  };

  const arcPath = (a0, a1) => {
    const [x0, y0] = pointAt(a0);
    const [x1, y1] = pointAt(a1);
    return `M ${x0.toFixed(3)} ${y0.toFixed(3)} A ${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(3)} ${y1.toFixed(3)}`;
  };

  function createSvgElement(tag) {
    if (typeof document.createElementNS === 'function') {
      return document.createElementNS(SVG_NS, tag);
    }
    return document.createElement(tag);
  }

  /**
   * Damped harmonic spring value replacing motion/react's useMotionValue + animate(type: 'spring').
   */
  class SpringReading {
    constructor(initialValue) {
      this.current = initialValue;
      this.target = initialValue;
      this.velocity = 0;
      this.stiffness = 375;
      this.damping = 30;
      this.animating = false;
    }

    get() {
      return this.current;
    }

    getVelocity() {
      return this.velocity;
    }

    set(v) {
      this.current = v;
    }

    jump(v) {
      this.current = v;
      this.target = v;
      this.velocity = 0;
      this.animating = false;
    }

    stop() {
      this.animating = false;
      this.velocity = 0;
    }

    isAnimating() {
      return this.animating;
    }

    animateSpring(to, { stiffness, damping, velocity }) {
      this.target = to;
      this.stiffness = stiffness;
      this.damping = damping;
      if (typeof velocity === 'number' && Number.isFinite(velocity)) {
        this.velocity = velocity;
      }
      this.animating = true;
    }

    step(dt) {
      if (!this.animating || dt <= 0) {
        return;
      }
      const subSteps = 4;
      const subDt = dt / subSteps;
      for (let i = 0; i < subSteps; i++) {
        const displacement = this.current - this.target;
        const accel = -this.stiffness * displacement - this.damping * this.velocity;
        this.velocity += accel * subDt;
        this.current += this.velocity * subDt;
      }
      if (Math.abs(this.current - this.target) < 0.04 && Math.abs(this.velocity) < 0.4) {
        this.current = this.target;
        this.velocity = 0;
        this.animating = false;
      }
    }
  }

  /**
   * Mounts a CometDial instance inside `container`.
   */
  function createCometDial(container, options = {}) {
    if (!container) {
      return null;
    }

    const min = options.min ?? 0;
    const max = options.max ?? 100;
    const step = options.step ?? 1;
    const unit = options.unit ?? '%';
    const label = options.label ?? 'Volume';
    const accent = options.accent ?? '#c4b5fd';
    const ink = options.ink ?? '#fdfdfd';
    const size = options.size ?? 190;
    const sweep = options.sweep ?? 320;
    const thickness = options.thickness ?? 5;
    const speed = options.speed ?? 25;
    const tapBounce = options.tapBounce ?? 0.2;
    const flickBounce = options.flickBounce ?? 0.1;
    const momentum = options.momentum ?? 1;
    const cometReach = options.cometReach ?? 180;
    const cometWidth = options.cometWidth ?? 12;
    let disabled = Boolean(options.disabled);
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;
    const onChangeEnd = typeof options.onChangeEnd === 'function' ? options.onChangeEnd : null;
    const onDragStart = typeof options.onDragStart === 'function' ? options.onDragStart : null;
    const onDragEnd = typeof options.onDragEnd === 'function' ? options.onDragEnd : null;
    const extraClass = options.className || '';

    const range = Math.max(1e-9, max - min);
    const gap = 360 - sweep;
    const start = 90 + gap / 2;
    const end = start + sweep;
    const decimals = decimalsOf(step);
    const k = 200 + (clamp(speed, 0, 100) / 100) * 700;
    const crit = 2 * Math.sqrt(k);
    const snap = (v) =>
      step > 0 ? clamp(Math.round((v - min) / step) * step + min, min, max) : clamp(v, min, max);

    const initialVal = snap(options.value ?? options.defaultValue ?? 100);
    let targetValue = initialVal;
    let grip = null;
    let unbindWindowListeners = null;
    let dragging = false;

    const reading = new SpringReading(initialVal);
    const loop = {
      raf: 0,
      last: 0,
      v: 0,
      rPrev: null,
      text: '',
      valueText: ''
    };

    const isReducedMotion = () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // --- Build DOM Structure ---
    const root = document.createElement('div');
    root.className = `comet-dial${extraClass ? ` ${extraClass}` : ''}`;
    root.style.setProperty('--cd-accent', accent);
    root.style.setProperty('--cd-ink', ink);
    root.style.setProperty('--cd-size', `${size}px`);
    root.style.setProperty('--cd-figure', `${Math.round(size * 0.16)}px`);
    if (disabled) {
      root.setAttribute('data-disabled', '');
    }

    const svg = createSvgElement('svg');
    svg.setAttribute('class', 'comet-dial__ring');
    svg.setAttribute('viewBox', '0 0 200 200');
    svg.setAttribute('role', 'slider');
    svg.setAttribute('tabindex', disabled ? '-1' : '0');
    svg.setAttribute('aria-label', label);
    svg.setAttribute('aria-valuemin', String(min));
    svg.setAttribute('aria-valuemax', String(max));
    svg.setAttribute('aria-valuenow', String(targetValue));
    svg.setAttribute('aria-valuetext', `${targetValue}${unit}`);

    const trackPath = createSvgElement('path');
    trackPath.setAttribute('class', 'comet-dial__track');
    trackPath.setAttribute('d', arcPath(start, end));
    trackPath.setAttribute('stroke-width', String(thickness));
    svg.appendChild(trackPath);

    const litPath = createSvgElement('path');
    litPath.setAttribute('class', 'comet-dial__lit');
    litPath.setAttribute('stroke-width', String(thickness));
    svg.appendChild(litPath);

    const cometGroup = createSvgElement('g');
    cometGroup.setAttribute('class', 'comet-dial__comet');
    const cometPaths = [];
    for (let j = 0; j < K; j++) {
      const p = createSvgElement('path');
      p.style.opacity = '0';
      cometGroup.appendChild(p);
      cometPaths.push(p);
    }
    svg.appendChild(cometGroup);

    const headCircle = createSvgElement('circle');
    headCircle.setAttribute('class', 'comet-dial__head');
    headCircle.setAttribute('r', String(thickness * 1.8));
    svg.appendChild(headCircle);

    const readout = document.createElement('div');
    readout.className = 'comet-dial__readout';
    readout.setAttribute('aria-hidden', 'true');

    const valueWrap = document.createElement('span');
    valueWrap.className = 'comet-dial__value';

    const figureSpan = document.createElement('span');
    figureSpan.className = 'comet-dial__figure';
    valueWrap.appendChild(figureSpan);

    if (unit) {
      const unitSpan = document.createElement('span');
      unitSpan.className = 'comet-dial__unit';
      unitSpan.textContent = unit;
      valueWrap.appendChild(unitSpan);
    }

    const captionSpan = document.createElement('span');
    captionSpan.className = 'comet-dial__caption';
    captionSpan.textContent = label;

    readout.appendChild(valueWrap);
    readout.appendChild(captionSpan);

    root.appendChild(svg);
    root.appendChild(readout);
    container.innerHTML = '';
    container.appendChild(root);

    function setDraggingState(nextDragging) {
      dragging = nextDragging;
      if (dragging) {
        root.setAttribute('data-dragging', '');
      } else {
        root.removeAttribute('data-dragging');
      }
    }

    function commit(v, finished, detail) {
      const s = snap(v);
      if (s !== targetValue) {
        targetValue = s;
        if (onChange) {
          onChange(s);
        }
      }
      if (finished && onChangeEnd) {
        onChangeEnd(s, detail ?? { velocity: 0, bounce: tapBounce });
      }
    }

    function nowMs() {
      return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    }

    function paint(now) {
      const currentNow = typeof now === 'number' ? now : nowMs();
      const dt = clamp((currentNow - loop.last) / 1000, 0, 0.05);
      loop.last = currentNow;
      const reduce = isReducedMotion();

      if (grip && grip.at != null) {
        if (reduce) {
          reading.jump(grip.at);
        } else {
          reading.set(reading.get() + (grip.at - reading.get()) * (1 - Math.exp(-dt / TAU_FOLLOW)));
        }
      } else if (reading.isAnimating()) {
        reading.step(dt);
      }

      const r = reading.get();
      const vRaw = loop.rPrev == null || dt === 0 || reduce ? 0 : (r - loop.rPrev) / dt / range;
      loop.rPrev = r;
      loop.v += (vRaw - loop.v) * (1 - Math.exp(-dt / TAU_V));
      const v = loop.v;
      const s = clamp(Math.abs(v) / V_FULL, 0, 1);
      const dir = Math.sign(v) || 1;
      const f = clamp((r - min) / range, 0, 1);
      const ang = start + f * sweep;

      litPath.setAttribute('d', f > 0.0005 ? arcPath(start, ang) : '');
      const [cx, cy] = pointAt(ang);
      headCircle.setAttribute('cx', cx.toFixed(3));
      headCircle.setAttribute('cy', cy.toFixed(3));

      const seg = (cometReach * s) / K;
      for (let j = 0; j < K; j++) {
        const el = cometPaths[j];
        if (!el) continue;
        let a0 = dir > 0 ? ang - (j + 1) * seg : ang + j * seg;
        let a1 = dir > 0 ? ang - j * seg : ang + (j + 1) * seg;
        a0 = clamp(a0, start, end);
        a1 = clamp(a1, start, end);
        if (seg < 0.01 || a1 - a0 < 0.01) {
          if (el.style.opacity !== '0') el.style.opacity = '0';
          continue;
        }
        const w = 1 - j / K;
        el.setAttribute('d', arcPath(a0, a1));
        el.setAttribute('stroke-width', (thickness + cometWidth * w * s).toFixed(2));
        el.style.opacity = (w * s).toFixed(3);
      }

      const shown = clamp(r, min, max).toFixed(decimals);
      if (shown !== loop.text) {
        loop.text = shown;
        figureSpan.textContent = shown;
        svg.setAttribute('aria-valuenow', shown);
      }

      const valueText = `${targetValue}${unit}`;
      if (valueText !== loop.valueText) {
        loop.valueText = valueText;
        svg.setAttribute('aria-valuetext', valueText);
      }

      const moving = Boolean(grip) || reading.isAnimating() || Math.abs(v) > 0.002;
      if (!moving) {
        for (const el of cometPaths) {
          if (el && el.style.opacity !== '0') el.style.opacity = '0';
        }
      }
      loop.raf = moving ? requestAnimationFrame(paint) : 0;
    }

    function wake() {
      if (loop.raf) return;
      loop.last = nowMs();
      loop.rPrev = null;
      loop.raf = requestAnimationFrame(paint);
    }

    function launch(to, bounce, velocity = reading.getVelocity()) {
      reading.stop();
      if (isReducedMotion()) {
        reading.jump(to);
        wake();
        return;
      }
      reading.animateSpring(to, {
        stiffness: k,
        damping: crit * (1 - clamp(bounce, 0, 0.9)),
        velocity
      });
      wake();
    }

    function localPoint(cx, cy) {
      const b = typeof svg.getBoundingClientRect === 'function'
        ? svg.getBoundingClientRect()
        : { left: 0, top: 0, width: size, height: size };
      const width = b.width || size;
      const height = b.height || size;
      return [((cx - b.left) / width) * 200 - 100, ((cy - b.top) / height) * 200 - 100];
    }

    function angleAt(cx, cy) {
      const [x, y] = localPoint(cx, cy);
      let rel = ((Math.atan2(y, x) * 180) / Math.PI - start + 720) % 360;
      if (rel > sweep) {
        rel = grip && grip.side ? (grip.side === 'hi' ? sweep : 0) : rel < sweep + gap / 2 ? sweep : 0;
      } else if (grip) {
        grip.side = rel > sweep / 2 ? 'hi' : 'lo';
      }
      return min + (rel / sweep) * range;
    }

    function onPointerMove(e) {
      if (!grip || (e.pointerId !== undefined && grip.id !== e.pointerId)) return;
      if (!grip.moved) {
        if (Math.hypot(e.clientX - grip.x0, e.clientY - grip.y0) < DRAG_PX) return;
        grip.moved = true;
        reading.stop();
      }
      grip.at = angleAt(e.clientX, e.clientY);
      grip.hist.push([nowMs(), grip.at]);
      if (grip.hist.length > 4) grip.hist.shift();
      commit(grip.at, false);
      wake();
    }

    function onPointerUp(e) {
      if (!grip || (e.pointerId !== undefined && grip.id !== e.pointerId)) return;
      const currentGrip = grip;
      grip = null;
      if (unbindWindowListeners) {
        unbindWindowListeners();
        unbindWindowListeners = null;
      }
      setDraggingState(false);
      try {
        if (typeof svg.releasePointerCapture === 'function' && e.pointerId !== undefined) {
          svg.releasePointerCapture(e.pointerId);
        }
      } catch {}

      if (!currentGrip.moved) {
        commit(targetValue, true);
        if (onDragEnd) onDragEnd(targetValue);
        return;
      }

      const stale = nowMs() - currentGrip.hist[currentGrip.hist.length - 1][0] > STALE_MS;
      const v = e.type === 'pointercancel' || stale ? 0 : velocityOf(currentGrip.hist);
      const bounce = tapBounce + (flickBounce - tapBounce) * clamp(Math.abs(v) / range / V_FLICK, 0, 1);
      const to = snap((currentGrip.at ?? targetValue) + (v / 1000) * (DECEL / (1 - DECEL)) * momentum);
      commit(to, true, { velocity: v, bounce });
      launch(to, bounce, v);
      if (onDragEnd) onDragEnd(to);
    }

    function onPointerDown(e) {
      if (disabled || grip || (e.button !== undefined && e.button > 0)) return;
      const [x, y] = localPoint(e.clientX, e.clientY);
      if (Math.hypot(x, y) < DEAD) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();

      try {
        if (typeof svg.setPointerCapture === 'function' && e.pointerId !== undefined) {
          svg.setPointerCapture(e.pointerId);
        }
      } catch {}

      grip = {
        id: e.pointerId,
        at: null,
        hist: [],
        side: null,
        moved: false,
        x0: e.clientX,
        y0: e.clientY
      };
      const at = angleAt(e.clientX, e.clientY);
      grip.hist.push([nowMs(), at]);
      setDraggingState(true);
      if (onDragStart) onDragStart();
      commit(at, false);
      launch(snap(at), tapBounce);

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
      unbindWindowListeners = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerUp);
      };
    }

    svg.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('click', (e) => {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
    });

    // Initial paint
    loop.last = nowMs();
    paint(loop.last);

    return {
      setValue(newValue, { animate = true } = {}) {
        if (grip) return;
        const s = snap(newValue);
        if (s === targetValue && !animate) {
          reading.jump(s);
          paint(nowMs());
          return;
        }
        targetValue = s;
        const valueText = `${targetValue}${unit}`;
        loop.valueText = valueText;
        svg.setAttribute('aria-valuetext', valueText);
        if (animate) {
          launch(s, tapBounce);
        } else {
          reading.jump(s);
          paint(nowMs());
        }
      },
      getValue() {
        return targetValue;
      },
      isDragging() {
        return dragging;
      },
      destroy() {
        if (loop.raf) {
          cancelAnimationFrame(loop.raf);
          loop.raf = 0;
        }
        if (unbindWindowListeners) {
          unbindWindowListeners();
          unbindWindowListeners = null;
        }
        reading.stop();
      }
    };
  }

  window.createCometDial = createCometDial;
})();
