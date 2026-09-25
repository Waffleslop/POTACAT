// renderer/waterfall.js
//
// Waterfall — a source-agnostic, GPU-accelerated spectrum waterfall.
//
// Consumes a stream of FFT magnitude frames via pushFrame() from ANY source
// (audio-passband FFT for conventional radios, wideband panadapter FFT for a
// Flex) and renders them as a scrolling heat-map on a WebGL2 canvas.
//
// Rendering technique — borrowed in concept from AetherSDR's QRhi waterfall,
// reimplemented in WebGL: the scrollback history is a fixed ring-buffer
// texture. Each pushFrame() writes ONE row via texSubImage2D and advances a
// rowOffset uniform; the fragment shader wraps the vertical UV with
// fract(uv.y + rowOffset), so the whole display scrolls with no per-frame
// redraw and no pixel copying.
//
// Loaded via <script> (POTACAT's renderer has no ES modules) — defines the
// global `Waterfall` class. See docs/waterfall-plan.md.

(function (global) {
  'use strict';

  const WF_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

  // Newest row sits near the top and the display scrolls down: as a frame is
  // pushed, rowOffset grows, so a fixed screen pixel samples a row 1/H lower.
  const WF_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
uniform float u_rowOffset;
uniform int u_colormap;
// Crop mode (opts.crop): one history row per CSS pixel row, newest at the
// top, so a shorter window shows LESS history instead of squeezing all of it
// (Scott 2026-09-25: "if I make the window smaller, I just lose the bottom
// part ... currently it is scrunched up to fit").
uniform int u_crop;
uniform float u_viewRows;   // canvas height in CSS px
uniform float u_histRows;   // texture rows
uniform float u_writeRow;   // next row to be written (newest = writeRow - 1)

vec3 cmClassic(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.2) return mix(vec3(0.0),              vec3(0.0,0.0,0.5), t/0.2);
  if (t < 0.4) return mix(vec3(0.0,0.0,0.5),      vec3(0.0,0.8,1.0), (t-0.2)/0.2);
  if (t < 0.6) return mix(vec3(0.0,0.8,1.0),      vec3(0.0,1.0,0.0), (t-0.4)/0.2);
  if (t < 0.8) return mix(vec3(0.0,1.0,0.0),      vec3(1.0,1.0,0.0), (t-0.6)/0.2);
  return            mix(vec3(1.0,1.0,0.0),        vec3(1.0,1.0,1.0), (t-0.8)/0.2);
}
vec3 cmTurbo(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.25) return mix(vec3(0.12,0.06,0.28), vec3(0.0,0.42,0.86),  t/0.25);
  if (t < 0.50) return mix(vec3(0.0,0.42,0.86),  vec3(0.0,0.86,0.70),  (t-0.25)/0.25);
  if (t < 0.70) return mix(vec3(0.0,0.86,0.70),  vec3(0.62,0.95,0.22), (t-0.50)/0.20);
  if (t < 0.88) return mix(vec3(0.62,0.95,0.22), vec3(0.98,0.73,0.05), (t-0.70)/0.18);
  return            mix(vec3(0.98,0.73,0.05),    vec3(0.96,0.16,0.10), (t-0.88)/0.12);
}
void main() {
  float tv;
  if (u_crop == 1) {
    float k = floor((1.0 - v_uv.y) * u_viewRows);   // rows down from the top
    if (k >= u_histRows) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    tv = fract((u_writeRow - 1.0 - k + 0.5) / u_histRows);   // row centre
  } else {
    tv = fract(v_uv.y + u_rowOffset);
  }
  float m = texture(u_tex, vec2(v_uv.x, tv)).r;
  vec3 c = (u_colormap == 1) ? cmTurbo(m) : cmClassic(m);
  fragColor = vec4(c, 1.0);
}`;

  const LINE_VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  const LINE_FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec4 u_color;
void main() { fragColor = u_color; }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('shader compile: ' + log);
    }
    return s;
  }
  function buildProgram(gl, vsSrc, fsSrc) {
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('program link: ' + log);
    }
    return p;
  }

  class Waterfall {
    /**
     * @param {HTMLCanvasElement} canvas - a canvas with no prior 2D context.
     * @param {object} opts - { bins, historyRows, colormap, gamma, crop }
     *   crop: true = one history row per CSS pixel (resizing crops old rows
     *   off the bottom); false (default) = all history spread over the height.
     */
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.bins = Math.max(16, opts.bins || 1024);
      this.historyRows = Math.max(16, opts.historyRows || 512);
      this.crop = !!opts.crop;
      this.gamma = opts.gamma || 0.5;
      this._cmIndex = opts.colormap === 'turbo' ? 1 : 0;
      this._markers = [];
      this._clickCb = null;

      // Adaptive range — slow noise floor, fast-attack / slow-decay peak.
      this._floor = 0;
      this._peak = 1;
      this._rangeInit = false;

      // Ring buffer.
      this._writeRow = 0;
      this._rowU8 = new Uint8Array(this.bins);

      const gl = canvas.getContext('webgl2', {
        antialias: false, depth: false, premultipliedAlpha: false,
      });
      this.supported = !!gl;
      if (!gl) {
        console.warn('[Waterfall] WebGL2 unavailable — waterfall disabled');
        return;
      }
      this.gl = gl;
      try {
        this._initGL();
      } catch (e) {
        console.warn('[Waterfall] init failed:', e.message);
        this.supported = false;
        this.gl = null;
        return;
      }
      this._onClick = (e) => this._handleClick(e);
      canvas.addEventListener('click', this._onClick);
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(canvas);
      }
      this.resize();
    }

    _initGL() {
      const gl = this.gl;
      this._wfProg = buildProgram(gl, WF_VERT, WF_FRAG);
      this._lineProg = buildProgram(gl, LINE_VERT, LINE_FRAG);

      // Fullscreen quad (two triangles).
      this._quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,  1, -1,  -1, 1,
        -1,  1,  1, -1,   1, 1,
      ]), gl.STATIC_DRAW);
      this._lineBuf = gl.createBuffer();

      // Ring-buffer history texture: R8, bins wide x historyRows tall.
      this._tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.bins, this.historyRows, 0,
                    gl.RED, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT); // wraps the ring

      this._uTex = gl.getUniformLocation(this._wfProg, 'u_tex');
      this._uRowOffset = gl.getUniformLocation(this._wfProg, 'u_rowOffset');
      this._uColormap = gl.getUniformLocation(this._wfProg, 'u_colormap');
      this._uCrop = gl.getUniformLocation(this._wfProg, 'u_crop');
      this._uViewRows = gl.getUniformLocation(this._wfProg, 'u_viewRows');
      this._uHistRows = gl.getUniformLocation(this._wfProg, 'u_histRows');
      this._uWriteRow = gl.getUniformLocation(this._wfProg, 'u_writeRow');
      this._wfPos = gl.getAttribLocation(this._wfProg, 'a_pos');
      this._uLineColor = gl.getUniformLocation(this._lineProg, 'u_color');
      this._linePos = gl.getAttribLocation(this._lineProg, 'a_pos');
    }

    /** Feed one FFT frame. `mags` — Float32Array of bin magnitudes, any scale.
     *  Frames of any length are resampled to `bins`; the component auto-ranges. */
    pushFrame(mags) {
      if (!this.supported || !mags || !mags.length) return;
      const n = this.bins;
      const step = mags.length / n;
      const tmp = this._frameTmp || (this._frameTmp = new Float32Array(n));
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = mags[(i * step) | 0];
        tmp[i] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!isFinite(lo) || !isFinite(hi)) return;

      if (!this._rangeInit) {
        this._floor = lo; this._peak = hi; this._rangeInit = true;
      } else {
        this._floor += 0.05 * (lo - this._floor);
        this._peak = Math.max(this._peak * 0.97 + hi * 0.03, hi);
      }
      const range = Math.max(1e-6, this._peak - this._floor);
      const g = this.gamma;
      for (let i = 0; i < n; i++) {
        let t = (tmp[i] - this._floor) / range;
        t = t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(t, g);
        this._rowU8[i] = (t * 255) | 0;
      }

      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, this._writeRow, n, 1,
                       gl.RED, gl.UNSIGNED_BYTE, this._rowU8);
      this._writeRow = (this._writeRow + 1) % this.historyRows;
      this._render();
    }

    _render() {
      const gl = this.gl;
      if (!gl) return;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // Waterfall.
      gl.useProgram(this._wfProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
      gl.enableVertexAttribArray(this._wfPos);
      gl.vertexAttribPointer(this._wfPos, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.uniform1i(this._uTex, 0);
      gl.uniform1i(this._uColormap, this._cmIndex);
      gl.uniform1f(this._uRowOffset, this._writeRow / this.historyRows);
      gl.uniform1i(this._uCrop, this.crop ? 1 : 0);
      gl.uniform1f(this._uViewRows, Math.max(1, this.canvas.clientHeight || this.canvas.height));
      gl.uniform1f(this._uHistRows, this.historyRows);
      gl.uniform1f(this._uWriteRow, this._writeRow);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // RX/TX marker lines.
      if (this._markers.length) {
        gl.useProgram(this._lineProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._lineBuf);
        gl.enableVertexAttribArray(this._linePos);
        gl.vertexAttribPointer(this._linePos, 2, gl.FLOAT, false, 0, 0);
        for (const m of this._markers) {
          const x = (m.pos || 0) * 2 - 1;
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x, -1, x, 1]), gl.DYNAMIC_DRAW);
          const c = m.color || [1, 1, 1, 1];
          gl.uniform4f(this._uLineColor, c[0], c[1], c[2], c[3] == null ? 1 : c[3]);
          gl.drawArrays(gl.LINES, 0, 2);
        }
      }
    }

    /** markers: [{ pos: 0..1, color: [r,g,b,a] }] — e.g. RX/TX cursors. */
    setMarkers(markers) {
      this._markers = Array.isArray(markers) ? markers : [];
      this._render();
    }

    setColormap(name) {
      this._cmIndex = name === 'turbo' ? 1 : 0;
      this._render();
    }

    /** Register a click-to-tune callback. cb receives the click x as 0..1. */
    onClick(cb) { this._clickCb = cb; }

    _handleClick(e) {
      if (!this._clickCb) return;
      const r = this.canvas.getBoundingClientRect();
      if (r.width <= 0) return;
      let p = (e.clientX - r.left) / r.width;
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      this._clickCb(p);
    }

    /** Match the canvas backing store to its CSS size x devicePixelRatio. */
    resize() {
      if (!this.supported) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this._render();
    }

    destroy() {
      if (this._onClick) this.canvas.removeEventListener('click', this._onClick);
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      const gl = this.gl;
      if (gl) {
        gl.deleteTexture(this._tex);
        gl.deleteBuffer(this._quad);
        gl.deleteBuffer(this._lineBuf);
        gl.deleteProgram(this._wfProg);
        gl.deleteProgram(this._lineProg);
      }
      this.gl = null;
      this.supported = false;
    }
  }

  global.Waterfall = Waterfall;
})(typeof window !== 'undefined' ? window : this);
