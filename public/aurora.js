/**
 * aurora.js
 *
 * Vanilla JavaScript WebGL2 port of the React Bits Aurora background effect.
 * Renders a flowing simplex-noise aurora curtain behind the ShowParty UI
 * without React or external WebGL libraries.
 */

(function () {
  'use strict';

  const VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

  const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;
uniform float uBlend;
uniform float uHeight;
uniform float uGlow;
uniform float uBrightness;
uniform float uLayers;
uniform vec2 uMouse;
uniform float uIntro;

out vec4 fragColor;

vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v) {
  const vec4 C = vec4(
    0.211324865405187, 0.366025403784439,
    -0.577350269189626, 0.024390243902439
  );
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);

  vec3 p = permute(
    permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0)
  );

  vec3 m = max(
    0.5 - vec3(
      dot(x0, x0),
      dot(x12.xy, x12.xy),
      dot(x12.zw, x12.zw)
    ),
    0.0
  );
  m = m * m;
  m = m * m;

  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);

  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

struct ColorStop {
  vec3 color;
  float position;
};

#define COLOR_RAMP(colors, factor, finalColor) {              \
  int index = 0;                                              \
  for (int i = 0; i < 2; i++) {                               \
    ColorStop currentColor = colors[i];                       \
    bool isInBetween = currentColor.position <= factor;       \
    index = int(mix(float(index), float(i), float(isInBetween))); \
  }                                                           \
  ColorStop currentColor = colors[index];                     \
  ColorStop nextColor = colors[index + 1];                    \
  float range = nextColor.position - currentColor.position;   \
  float lerpFactor = clamp((factor - currentColor.position) / max(range, 0.0001), 0.0, 1.0); \
  finalColor = mix(currentColor.color, nextColor.color, lerpFactor); \
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  ColorStop colors[3];
  colors[0] = ColorStop(uColorStops[0], 0.0);
  colors[1] = ColorStop(uColorStops[1], 0.5);
  colors[2] = ColorStop(uColorStops[2], 1.0);

  float rampCoord = clamp(uv.x + (uMouse.x - 0.5) * 0.14, 0.0, 1.0);
  vec3 rampColor;
  COLOR_RAMP(colors, rampCoord, rampColor);

  float mouseShiftY = (uMouse.y - 0.5) * 0.16;
  float wave = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;

  if (uLayers > 1.0) {
    wave += snoise(vec2(uv.x * 3.6 - uTime * 0.14, uTime * 0.18 + 1.7)) * 0.22 * uAmplitude;
  }

  float height = exp(wave);
  height = (uv.y * 1.55 - height + (uHeight * 0.85) + mouseShiftY);
  float intensity = 0.65 * height;

  // Secondary lower ribbon so the aurora colors also sneak behind the chat and bottom bar
  float lowerWave = snoise(vec2(uv.x * 1.7 - uTime * 0.08 + 2.4, uTime * 0.18 + 0.9));
  float lowerBand = smoothstep(0.55, 0.0, abs(uv.y - 0.22 - lowerWave * 0.12)) * 0.42;

  float midPoint = 0.18;
  float auroraAlpha = smoothstep(midPoint - uBlend * 0.55, midPoint + uBlend * 0.55, intensity);
  float softGlow = smoothstep(-0.25, midPoint + uBlend, intensity) * uGlow * 0.42 + lowerBand;

  vec3 auroraColor = (max(intensity, 0.15) * rampColor * uBrightness) + (rampColor * softGlow);
  float finalAlpha = clamp((auroraAlpha + softGlow * 0.72) * uIntro, 0.0, 1.0);

  fragColor = vec4(auroraColor * finalAlpha, finalAlpha);
}
`;

  /**
   * Parses a 6-digit hex color string (e.g. "#EC4899") into normalized [r, g, b].
   */
  function hexToRgbNormalized(hex) {
    const clean = String(hex || '#000000').replace('#', '').trim();
    const num = parseInt(clean, 16);
    if (Number.isNaN(num)) {
      return [0, 0, 0];
    }
    return [
      ((num >> 16) & 255) / 255,
      ((num >> 8) & 255) / 255,
      (num & 255) / 255
    ];
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) {
      return null;
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('[Aurora] Shader compile error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function initAuroraBackground(container, customOptions) {
    if (!container || typeof window === 'undefined' || typeof document === 'undefined') {
      return null;
    }

    const config = Object.assign(
      {
        colorStops: ['#EC4899', '#7C3AED', '#5227FF'],
        amplitude: 1.0,
        blend: 0.5,
        height: 0.45,
        speed: 1.0,
        glow: 0.6,
        layers: 1,
        brightness: 1.0,
        mouseInteraction: true,
        intro: true,
        opacity: 0.8
      },
      customOptions || {}
    );

    container.style.opacity = String(config.opacity);

    const canvas = document.createElement('canvas');
    canvas.className = 'aurora-canvas';
    canvas.setAttribute('aria-hidden', 'true');

    let gl = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
        powerPreference: 'default'
      });
    } catch (err) {
      gl = null;
    }

    // Fallback gracefully if WebGL2 is not supported
    if (!gl) {
      container.classList.add('aurora-fallback');
      return {
        isFallback: true,
        destroy() {}
      };
    }

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
    if (!vertexShader || !fragmentShader) {
      container.classList.add('aurora-fallback');
      return {
        isFallback: true,
        destroy() {}
      };
    }

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('[Aurora] Program link error:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      container.classList.add('aurora-fallback');
      return {
        isFallback: true,
        destroy() {}
      };
    }

    container.appendChild(canvas);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    // Create full-screen triangle geometry
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    );

    const positionLoc = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    // Look up uniform locations
    const uniforms = {
      uTime: gl.getUniformLocation(program, 'uTime'),
      uAmplitude: gl.getUniformLocation(program, 'uAmplitude'),
      uColorStops: gl.getUniformLocation(program, 'uColorStops'),
      uResolution: gl.getUniformLocation(program, 'uResolution'),
      uBlend: gl.getUniformLocation(program, 'uBlend'),
      uHeight: gl.getUniformLocation(program, 'uHeight'),
      uGlow: gl.getUniformLocation(program, 'uGlow'),
      uBrightness: gl.getUniformLocation(program, 'uBrightness'),
      uLayers: gl.getUniformLocation(program, 'uLayers'),
      uMouse: gl.getUniformLocation(program, 'uMouse'),
      uIntro: gl.getUniformLocation(program, 'uIntro')
    };

    const flatColors = new Float32Array(9);
    for (let i = 0; i < 3; i++) {
      const rgb = hexToRgbNormalized(config.colorStops[i] || '#5227FF');
      flatColors[i * 3] = rgb[0];
      flatColors[i * 3 + 1] = rgb[1];
      flatColors[i * 3 + 2] = rgb[2];
    }

    let animationFrameId = null;
    let isDestroyed = false;
    let startTimeMs = null;

    const targetMouse = { x: 0.5, y: 0.5 };
    const currentMouse = { x: 0.5, y: 0.5 };

    const reducedMotionQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

    function isReducedMotionPreferred() {
      return Boolean(reducedMotionQuery && reducedMotionQuery.matches);
    }

    function resize() {
      if (isDestroyed || !container) {
        return;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.floor((container.clientWidth || window.innerWidth || 1280) * dpr));
      const height = Math.max(1, Math.floor((container.clientHeight || window.innerHeight || 720) * dpr));

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function renderFrame(timestampMs) {
      if (isDestroyed) {
        return;
      }

      if (startTimeMs === null) {
        startTimeMs = timestampMs;
      }

      const elapsedSeconds = (timestampMs - startTimeMs) * 0.001;
      const introProgress = config.intro
        ? Math.min(1.0, elapsedSeconds / 1.2)
        : 1.0;

      // Smoothly interpolate mouse coordinates
      currentMouse.x += (targetMouse.x - currentMouse.x) * 0.06;
      currentMouse.y += (targetMouse.y - currentMouse.y) * 0.06;

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.bindVertexArray(vao);

      gl.uniform1f(uniforms.uTime, elapsedSeconds * config.speed);
      gl.uniform1f(uniforms.uAmplitude, config.amplitude);
      gl.uniform3fv(uniforms.uColorStops, flatColors);
      gl.uniform2f(uniforms.uResolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.uBlend, config.blend);
      gl.uniform1f(uniforms.uHeight, config.height);
      gl.uniform1f(uniforms.uGlow, config.glow);
      gl.uniform1f(uniforms.uBrightness, config.brightness);
      gl.uniform1f(uniforms.uLayers, config.layers);
      gl.uniform2f(uniforms.uMouse, currentMouse.x, currentMouse.y);
      gl.uniform1f(
        uniforms.uIntro,
        isReducedMotionPreferred() ? 1.0 : introProgress
      );

      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Only schedule next frame if document is visible and reduced motion is not preferred
      if (!document.hidden && !isReducedMotionPreferred()) {
        animationFrameId = window.requestAnimationFrame(renderFrame);
      } else {
        animationFrameId = null;
      }
    }

    function startLoopIfEligible() {
      if (isDestroyed) {
        return;
      }
      if (isReducedMotionPreferred()) {
        if (animationFrameId !== null) {
          window.cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
        renderFrame(window.performance ? window.performance.now() : Date.now());
        return;
      }
      if (!document.hidden && animationFrameId === null) {
        animationFrameId = window.requestAnimationFrame(renderFrame);
      }
    }

    function handlePointerMove(event) {
      if (!config.mouseInteraction || isReducedMotionPreferred()) {
        return;
      }
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      targetMouse.x = Math.min(1, Math.max(0, event.clientX / w));
      targetMouse.y = Math.min(1, Math.max(0, 1.0 - event.clientY / h));
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        if (animationFrameId !== null) {
          window.cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
      } else {
        startLoopIfEligible();
      }
    }

    function handleResize() {
      resize();
      if (isReducedMotionPreferred()) {
        renderFrame(window.performance ? window.performance.now() : Date.now());
      }
    }

    window.addEventListener('resize', handleResize);
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (reducedMotionQuery && typeof reducedMotionQuery.addEventListener === 'function') {
      reducedMotionQuery.addEventListener('change', startLoopIfEligible);
    }

    resize();
    startLoopIfEligible();

    function destroy() {
      if (isDestroyed) {
        return;
      }
      isDestroyed = true;

      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }

      window.removeEventListener('resize', handleResize);
      window.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (reducedMotionQuery && typeof reducedMotionQuery.removeEventListener === 'function') {
        reducedMotionQuery.removeEventListener('change', startLoopIfEligible);
      }

      gl.deleteBuffer(positionBuffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);

      if (canvas.parentNode === container) {
        container.removeChild(canvas);
      }
    }

    window.addEventListener('pagehide', destroy, { once: true });

    return {
      isFallback: false,
      resize: handleResize,
      destroy
    };
  }

  window.initAuroraBackground = initAuroraBackground;
})();
