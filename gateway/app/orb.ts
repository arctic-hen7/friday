/* Friday Orb — real-time iridescent sphere renderer (Canvas 2D).
   A glossy dark-glass core wrapped in iridescent particles that orbit, pulse,
   rearrange and react to audio amplitude. State-driven; no external deps. */

export type OrbState =
    | "idle"
    | "connecting"
    | "error"
    | "listening"
    | "userSpeaking"
    | "processing"
    | "responding"
    | "muted"
    | "ending";

export type OrbRing =
    | { mode: "sweep" }
    | { mode: "progress"; p: number };

export type OrbMotion = { spin: number; flow: number; wander: number };

export type OrbPalette = {
    name: string;
    glow: string;
    stops: Array<[number, string]>;
};

type RGB = [number, number, number];

type StateParams = {
    brightness: number;
    spin: number;
    energy: number;
    contract: number;
    mono: number;
    tint: RGB | null;
    tintAmt: number;
    glow: number;
};

type Particle = {
    x: number;
    y: number;
    z: number;
    s: number;
    a: number;
    r: number;
    g: number;
    b: number;
};

function hexToRgb(hex: string): RGB {
    const h = hex.replace("#", "");
    return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
    ];
}

function lerp(a: number, b: number, t: number) {
    return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number) {
    return v < lo ? lo : v > hi ? hi : v;
}

function buildLut(stops: Array<[number, string]>): Float32Array {
    const pts = stops.map(([pos, hex]) => [pos, hexToRgb(hex)] as const);
    const lut = new Float32Array(256 * 3);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let j = 0;
        while (j < pts.length - 1 && t > pts[j + 1][0]) j++;
        const a = pts[j];
        const b = pts[Math.min(j + 1, pts.length - 1)];
        const span = b[0] - a[0] || 1;
        const k = clamp((t - a[0]) / span, 0, 1);
        lut[i * 3] = lerp(a[1][0], b[1][0], k);
        lut[i * 3 + 1] = lerp(a[1][1], b[1][1], k);
        lut[i * 3 + 2] = lerp(a[1][2], b[1][2], k);
    }
    return lut;
}

const RAW_PALETTES: Record<string, OrbPalette> = {
    spectra: { name: "Spectra", glow: "#6a7bff", stops: [[0, "#3b5bff"], [0.28, "#36e2ff"], [0.5, "#7bd0ff"], [0.66, "#9b6bff"], [0.84, "#ff5bd0"], [1, "#3b5bff"]] },
    aurora:  { name: "Aurora",  glow: "#43e6b8", stops: [[0, "#1fe0b0"], [0.3, "#7bffb0"], [0.55, "#48d8ff"], [0.78, "#9b8bff"], [1, "#1fe0b0"]] },
    pearl:   { name: "Pearl",   glow: "#cdb8e0", stops: [[0, "#ffd9ec"], [0.3, "#e0fff4"], [0.58, "#dbe6ff"], [0.82, "#fff0dc"], [1, "#ffd9ec"]] },
    nebula:  { name: "Nebula",  glow: "#9b6bff", stops: [[0, "#5b6bff"], [0.3, "#b15bff"], [0.58, "#ff5bb0"], [0.82, "#8b6bff"], [1, "#5b6bff"]] },
    solar:   { name: "Solar",   glow: "#ff9a5b", stops: [[0, "#ffd24b"], [0.3, "#ff9a5b"], [0.58, "#ff5b8f"], [0.82, "#c98bff"], [1, "#ffd24b"]] },
};

const LUTS: Record<string, Float32Array> = Object.fromEntries(
    Object.entries(RAW_PALETTES).map(([key, palette]) => [key, buildLut(palette.stops)]),
);

export const PALETTES: Record<string, OrbPalette> = RAW_PALETTES;

// brightness, spin (rad/s base), energy (0..1 base agitation), contract (pull particles inward),
// mono (0 full color .. 1 greyscale), tint overlay rgb, glow halo strength.
const STATES: Record<OrbState, StateParams> = {
    idle:         { brightness: 0.42, spin: 0.07, energy: 0.06, contract: 0,     mono: 0.55, tint: null,            tintAmt: 0,    glow: 0.22 },
    connecting:   { brightness: 0.72, spin: 0.55, energy: 0.14, contract: 0.04,  mono: 0.18, tint: null,            tintAmt: 0,    glow: 0.4  },
    error:        { brightness: 0.62, spin: 0.04, energy: 0.05, contract: 0,     mono: 0.1,  tint: [255, 72, 72],   tintAmt: 0.92, glow: 0.42 },
    listening:    { brightness: 0.96, spin: 0.13, energy: 0.1,  contract: 0,     mono: 0,    tint: null,            tintAmt: 0,    glow: 0.5  },
    userSpeaking: { brightness: 1.0,  spin: 0.3,  energy: 0.55, contract: -0.04, mono: 0,    tint: null,            tintAmt: 0,    glow: 0.72 },
    processing:   { brightness: 0.9,  spin: 1.15, energy: 0.5,  contract: 0.16,  mono: 0.05, tint: null,            tintAmt: 0,    glow: 0.55 },
    responding:   { brightness: 1.0,  spin: 0.2,  energy: 0.4,  contract: -0.02, mono: 0,    tint: null,            tintAmt: 0,    glow: 0.66 },
    muted:        { brightness: 0.3,  spin: 0.05, energy: 0.05, contract: 0.03,  mono: 0.78, tint: null,            tintAmt: 0,    glow: 0.14 },
    ending:       { brightness: 0.85, spin: 0.5,  energy: 0.2,  contract: 0.22,  mono: 0.1,  tint: null,            tintAmt: 0,    glow: 0.45 },
};

export type OrbOptions = {
    palette?: keyof typeof PALETTES | string;
    count?: number;
    dprCap?: number;
    fps?: number;
    seed?: number;
    motion?: Partial<OrbMotion>;
};

export class Orb {
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly count: number;
    private readonly dprCap: number;
    private readonly fps: number;
    private readonly seed: number;

    private paletteKey: string;
    private motion: OrbMotion;
    private state: OrbState = "idle";
    private cur: StateParams = { ...STATES.idle };
    private tgt: StateParams = STATES.idle;
    private amp = 0;
    private ampSmooth = 0;
    // listening + user-speaking collapse into one mic-reactive state visually
    private aY = 0;
    private aX = -0.32;
    private aZ = 0;
    private readonly t0: number;
    private tPrev: number;
    private ring: OrbRing | null = null;
    private running = false;

    private pts!: Float32Array;
    private phase!: Float32Array;
    private w = 1;
    private h = 1;
    private dpr = 1;
    private R = 1;

    private sheen!: HTMLCanvasElement;
    private sctx!: CanvasRenderingContext2D;
    private scratch: Particle[] = [];
    private rafId: number | null = null;
    private readonly onResize: () => void;

    constructor(canvas: HTMLCanvasElement, opts: OrbOptions = {}) {
        this.canvas = canvas;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Orb: 2D canvas context unavailable");
        this.ctx = ctx;
        this.count = opts.count ?? 720;
        this.paletteKey = opts.palette ?? "spectra";
        this.dprCap = opts.dprCap ?? 2;
        this.fps = opts.fps ?? 0;
        this.seed = opts.seed ?? Math.random() * 100;
        this.motion = { spin: 1.8, flow: 0.65, wander: 1.2, ...opts.motion };
        this.t0 = performance.now();
        this.tPrev = this.t0;
        this.buildPoints();
        this.resize();
        this.onResize = () => this.resize();
        window.addEventListener("resize", this.onResize);
    }

    setPalette(key: string) {
        if (PALETTES[key]) this.paletteKey = key;
    }

    setAmplitude(amp: number) {
        this.amp = clamp(amp, 0, 1);
    }

    setRing(ring: OrbRing | null) {
        this.ring = ring;
    }

    setMotion(motion: Partial<OrbMotion>) {
        Object.assign(this.motion, motion);
    }

    setState(state: OrbState) {
        // listening + user-speaking are one mic-reactive state
        const s = state === "userSpeaking" ? "listening" : state;
        if (!STATES[s]) return;
        this.state = s;
        this.tgt = STATES[s];
    }

    getState(): OrbState {
        return this.state;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.tPrev = performance.now();
        const tick = (t: number) => {
            if (!this.running) return;
            this.frame(t);
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    stop() {
        this.running = false;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    destroy() {
        this.stop();
        window.removeEventListener("resize", this.onResize);
    }

    private buildPoints() {
        const n = this.count;
        const pts = new Float32Array(n * 3);
        const ph = new Float32Array(n);
        const ga = Math.PI * (3 - Math.sqrt(5));
        for (let i = 0; i < n; i++) {
            const y = 1 - (i / (n - 1)) * 2;
            const r = Math.sqrt(Math.max(0, 1 - y * y));
            const th = ga * i;
            pts[i * 3] = Math.cos(th) * r;
            pts[i * 3 + 1] = y;
            pts[i * 3 + 2] = Math.sin(th) * r;
            ph[i] = Math.random() * Math.PI * 2;
        }
        this.pts = pts;
        this.phase = ph;
    }

    private resize() {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
        this.w = Math.max(1, Math.round(rect.width));
        this.h = Math.max(1, Math.round(rect.height));
        this.canvas.width = this.w * dpr;
        this.canvas.height = this.h * dpr;
        this.dpr = dpr;
        this.R = Math.min(this.w, this.h) * 0.3;
        if (!this.sheen) this.sheen = document.createElement("canvas");
        this.sheen.width = this.canvas.width;
        this.sheen.height = this.canvas.height;
        const sctx = this.sheen.getContext("2d");
        if (!sctx) throw new Error("Orb: sheen context unavailable");
        this.sctx = sctx;
    }

    private frame(now: number) {
        if (this.fps) {
            const min = 1000 / this.fps;
            if (now - this.tPrev < min) return;
        }
        const dt = Math.min(0.05, (now - this.tPrev) / 1000);
        this.tPrev = now;
        const time = (now - this.t0) / 1000;

        const c = this.cur;
        const g = this.tgt;
        const k = 1 - Math.pow(0.001, dt);
        c.brightness = lerp(c.brightness, g.brightness, k);
        c.spin = lerp(c.spin, g.spin, k);
        c.energy = lerp(c.energy, g.energy, k);
        c.contract = lerp(c.contract, g.contract, k);
        c.mono = lerp(c.mono, g.mono, k);
        c.glow = lerp(c.glow, g.glow, k);
        c.tintAmt = lerp(c.tintAmt, g.tint ? g.tintAmt : 0, k);
        this.ampSmooth = lerp(this.ampSmooth, this.amp, 1 - Math.pow(0.002, dt));

        const energy = clamp(c.energy + this.ampSmooth * 0.9, 0, 1.3);
        const m = this.motion;
        const sd = this.seed;
        // incommensurate sine drivers => organic, non-repeating tumble
        const w0 = (c.spin + energy * 0.4) * m.spin;
        const dX = Math.sin(time * 0.19 + sd * 1.7) + 0.6 * Math.sin(time * 0.073 + sd * 2.3);
        const dY = Math.sin(time * 0.11 + sd * 0.7);
        const dZ = Math.sin(time * 0.151 + sd * 1.1) + 0.6 * Math.sin(time * 0.061 + sd * 3.1);
        this.aY += dt * (w0 * (1 + 0.6 * m.flow * dY) + m.wander * 0.30 * dY);
        this.aX += dt * (w0 * 0.6 * m.flow * dX + m.wander * 0.34 * dX);
        this.aZ += dt * (w0 * 0.5 * m.flow * dZ + m.wander * 0.22 * dZ);

        this.draw(time, energy, c);
    }

    private draw(time: number, energy: number, c: StateParams) {
        const ctx = this.ctx;
        const dpr = this.dpr;
        const cx = this.w * 0.5 * dpr;
        const cy = this.h * 0.5 * dpr;
        const breath = Math.sin(time * 1.5) * 0.018 + Math.sin(time * 0.7) * 0.01;
        const pulse = 1 + breath + this.ampSmooth * 0.12 + energy * 0.03;
        const R = this.R * dpr * pulse;
        const lut = LUTS[this.paletteKey];
        const palette = PALETTES[this.paletteKey];
        const glowHex = palette.glow;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // ambient halo
        const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 2.6);
        let gc = hexToRgb(glowHex);
        // tinted states (e.g. error) push the halo toward the tint color for a coherent look
        if (this.tgt.tint) {
            const ta = c.tintAmt;
            gc = [
                lerp(gc[0], this.tgt.tint[0], ta),
                lerp(gc[1], this.tgt.tint[1], ta),
                lerp(gc[2], this.tgt.tint[2], ta),
            ];
        }
        const ga = c.glow * (0.55 + this.ampSmooth * 0.5);
        halo.addColorStop(0, `rgba(${gc[0]},${gc[1]},${gc[2]},${ga * 0.5})`);
        halo.addColorStop(0.5, `rgba(${gc[0]},${gc[1]},${gc[2]},${ga * 0.14})`);
        halo.addColorStop(1, `rgba(${gc[0]},${gc[1]},${gc[2]},0)`);
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // 3-axis rotation trig
        const cY = Math.cos(this.aY), sY = Math.sin(this.aY);
        const cX = Math.cos(this.aX), sX = Math.sin(this.aX);
        const cZ = Math.cos(this.aZ), sZ = Math.sin(this.aZ);
        const Lraw = [-0.5, -0.62, 0.6];
        const Ln = Math.hypot(Lraw[0], Lraw[1], Lraw[2]);
        const L: [number, number, number] = [Lraw[0] / Ln, Lraw[1] / Ln, Lraw[2] / Ln];

        const pts = this.pts;
        const n = this.count;
        const ph = this.phase;
        const shellR = R * (1.0 - c.contract);
        const tint = this.tgt.tint;
        const tintAmt = c.tintAmt;
        const bright = c.brightness;

        const P = this.scratch;
        for (let i = 0; i < n; i++) {
            const x = pts[i * 3];
            const y = pts[i * 3 + 1];
            const z = pts[i * 3 + 2];
            const x1 = x * cY + z * sY;
            const z1 = -x * sY + z * cY;
            const y1 = y;
            const y2 = y1 * cX - z1 * sX;
            const z2 = y1 * sX + z1 * cX;
            const x2 = x1;
            const x3 = x2 * cZ - y2 * sZ;
            const y3 = x2 * sZ + y2 * cZ;
            const z3 = z2;
            const nz = z3;
            const depth = (z3 + 1) * 0.5;
            const diffuse = clamp(x3 * L[0] + y3 * L[1] + z3 * L[2], 0, 1);
            const fres = Math.pow(1 - clamp(nz, 0, 1), 3);
            // iridescence parameter — wide mapping so hue flows across the surface as it turns
            let s = x3 * 0.7 + y3 * 0.45 + fres * 0.6 + time * 0.02;
            s = s - Math.floor(s);
            const li = ((s * 255) | 0) * 3;
            let cr = lut[li];
            let cg = lut[li + 1];
            let cb = lut[li + 2];
            const shade = (0.22 + diffuse * 0.7 + fres * 0.55) * bright;
            cr *= shade; cg *= shade; cb *= shade;
            if (c.mono > 0) {
                const lum = cr * 0.3 + cg * 0.59 + cb * 0.11;
                cr = lerp(cr, lum, c.mono);
                cg = lerp(cg, lum, c.mono);
                cb = lerp(cb, lum, c.mono);
            }
            if (tint && tintAmt > 0) {
                cr = lerp(cr, tint[0] * shade, tintAmt);
                cg = lerp(cg, tint[1] * shade, tintAmt);
                cb = lerp(cb, tint[2] * shade, tintAmt);
            }
            // gentle breathing + amplitude-driven vertical ripple — dots flow with speech
            const ripple = Math.sin(time * 5.0 - y3 * 5.2 + ph[i] * 0.6);
            const breathe = Math.sin(time * 2.2 + ph[i]) * 0.5 + 0.5;
            const disp = 1 + breathe * c.energy * 0.07 + (0.5 + 0.5 * ripple) * (this.ampSmooth * 0.26 + c.energy * 0.05);
            const rr = shellR * disp;
            const px = cx + x3 * rr;
            const py = cy + y3 * rr;
            const size = R * (0.004 + depth * 0.0095) * (1 + this.ampSmooth * 0.3);
            const alpha = (0.08 + depth * 0.92) * (0.5 + fres * 0.5) * (1 + c.tintAmt * 0.6);
            const slot = P[i] ?? (P[i] = { x: 0, y: 0, z: 0, s: 0, a: 0, r: 0, g: 0, b: 0 });
            slot.x = px; slot.y = py; slot.z = z3; slot.s = size; slot.a = clamp(alpha, 0, 1);
            slot.r = clamp(cr, 0, 255) | 0;
            slot.g = clamp(cg, 0, 255) | 0;
            slot.b = clamp(cb, 0, 255) | 0;
        }

        // BACK hemisphere particles — dim
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < n; i++) {
            const p = P[i];
            if (p.z >= 0) continue;
            ctx.globalAlpha = p.a * 0.5;
            ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0.4, p.s * 0.85), 0, 6.2832);
            ctx.fill();
        }

        // CORE glossy dark-glass sphere
        ctx.globalCompositeOperation = "source-over";
        const coreR = R * 0.9;
        const core = ctx.createRadialGradient(cx - coreR * 0.32, cy - coreR * 0.4, coreR * 0.05, cx, cy, coreR);
        core.addColorStop(0, "rgba(40,43,54,0.96)");
        core.addColorStop(0.45, "rgba(20,21,28,0.97)");
        core.addColorStop(0.82, "rgba(9,9,13,0.98)");
        core.addColorStop(1, "rgba(6,6,9,0.7)");
        ctx.globalAlpha = 1;
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(cx, cy, coreR, 0, 6.2832);
        ctx.fill();

        // iridescent oil-slick sheen on the rim (conic spectrum masked to a thin band)
        const sc = this.sctx;
        sc.setTransform(1, 0, 0, 1, 0, 0);
        sc.clearRect(0, 0, this.canvas.width, this.canvas.height);
        sc.globalCompositeOperation = "source-over";
        if (sc.createConicGradient) {
            const cgi = sc.createConicGradient(this.aZ + this.aY * 0.5, cx, cy);
            const SN = 24;
            for (let sgi = 0; sgi <= SN; sgi++) {
                const st = sgi / SN;
                // exactly one cycle of the cyclic palette around the circle => start == end => seamless
                const sl = (((st + time * 0.03) % 1) * 255 | 0) * 3;
                cgi.addColorStop(st, `rgb(${lut[sl] | 0},${lut[sl + 1] | 0},${lut[sl + 2] | 0})`);
            }
            sc.fillStyle = cgi;
        } else {
            sc.fillStyle = `rgb(${gc[0]},${gc[1]},${gc[2]})`;
        }
        sc.beginPath();
        sc.arc(cx, cy, coreR, 0, 6.2832);
        sc.fill();
        sc.globalCompositeOperation = "destination-in";
        const smask = sc.createRadialGradient(cx, cy, coreR * 0.5, cx, cy, coreR);
        smask.addColorStop(0, "rgba(0,0,0,0)");
        smask.addColorStop(0.7, "rgba(0,0,0,0.05)");
        smask.addColorStop(0.92, "rgba(0,0,0,0.7)");
        smask.addColorStop(0.99, "rgba(0,0,0,0.98)");
        smask.addColorStop(1, "rgba(0,0,0,0.2)");
        sc.fillStyle = smask;
        sc.beginPath();
        sc.arc(cx, cy, coreR, 0, 6.2832);
        sc.fill();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = (0.33 + this.ampSmooth * 0.25) * bright * (1 - c.mono * 0.7) * (1 - c.tintAmt * 0.9);
        ctx.drawImage(this.sheen, 0, 0);
        ctx.globalAlpha = 1;

        // FRONT hemisphere particles
        for (let i = 0; i < n; i++) {
            const q = P[i];
            if (q.z < 0) continue;
            ctx.globalAlpha = q.a;
            ctx.fillStyle = `rgb(${q.r},${q.g},${q.b})`;
            ctx.beginPath();
            ctx.arc(q.x, q.y, Math.max(0.4, q.s), 0, 6.2832);
            ctx.fill();
        }

        // specular highlight (top-left, cool white)
        const spec = ctx.createRadialGradient(cx - coreR * 0.34, cy - coreR * 0.42, 1, cx - coreR * 0.34, cy - coreR * 0.42, coreR * 0.55);
        spec.addColorStop(0, `rgba(255,255,255,${0.5 * bright})`);
        spec.addColorStop(0.4, `rgba(220,230,255,${0.12 * bright})`);
        spec.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = spec;
        ctx.beginPath();
        ctx.arc(cx - coreR * 0.34, cy - coreR * 0.42, coreR * 0.55, 0, 6.2832);
        ctx.fill();

        ctx.globalAlpha = 1;
        if (this.ring) this.drawRing(ctx, cx, cy, R, gc, time);
        ctx.globalCompositeOperation = "source-over";
    }

    private drawRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, gc: RGB, time: number) {
        const dpr = this.dpr;
        const ring = this.ring!;
        const rad = R * 1.32;
        ctx.lineCap = "round";
        if (ring.mode === "sweep") {
            ctx.globalCompositeOperation = "lighter";
            ctx.lineWidth = 2 * dpr;
            ctx.strokeStyle = `rgba(${gc[0]},${gc[1]},${gc[2]},0.1)`;
            ctx.beginPath();
            ctx.arc(cx, cy, rad, 0, 6.2832);
            ctx.stroke();
            const a0 = (time * 3.2) % 6.2832;
            ctx.lineWidth = 3 * dpr;
            ctx.strokeStyle = `rgba(${gc[0]},${gc[1]},${gc[2]},0.95)`;
            ctx.shadowBlur = 16 * dpr;
            ctx.shadowColor = `rgba(${gc[0]},${gc[1]},${gc[2]},0.9)`;
            ctx.beginPath();
            ctx.arc(cx, cy, rad, a0, a0 + 1.5);
            ctx.stroke();
            ctx.shadowBlur = 0;
        } else {
            const p = clamp(ring.p, 0, 1);
            ctx.globalCompositeOperation = "source-over";
            ctx.lineWidth = 3 * dpr;
            ctx.strokeStyle = "rgba(255,255,255,0.1)";
            ctx.beginPath();
            ctx.arc(cx, cy, rad, 0, 6.2832);
            ctx.stroke();
            ctx.globalCompositeOperation = "lighter";
            ctx.lineWidth = 4 * dpr;
            ctx.strokeStyle = "rgba(255,90,90,0.95)";
            ctx.shadowBlur = 14 * dpr;
            ctx.shadowColor = "rgba(255,90,90,0.8)";
            ctx.beginPath();
            ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + p * 6.2832);
            ctx.stroke();
            ctx.shadowBlur = 0;
        }
        ctx.globalCompositeOperation = "source-over";
    }
}
