// 캔버스 배경 씬 — 이미지 파일 0개
//
// 밤새 도는 그림이라 배터리가 우선이다. 입자 수를 낮게 잡고,
// 화면이 숨겨지거나 딤 상태가 되면 렌더를 완전히 멈춘다.

const SCENES = {
  stars: {
    label: '별하늘',
    sky: ['#0B0A14', '#141026', '#1B1533'],
    init(w, h) {
      return {
        stars: Array.from({ length: 90 }, () => ({
          x: Math.random() * w,
          y: Math.random() * h * 0.78,
          r: Math.random() * 1.3 + 0.35,
          p: Math.random() * Math.PI * 2,
          s: 0.4 + Math.random() * 0.8,
        })),
      };
    },
    draw(ctx, w, h, st, t) {
      for (const s of st.stars) {
        const a = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.0007 * s.s + s.p));
        ctx.globalAlpha = a;
        ctx.fillStyle = '#E7DFF2';
        ctx.beginPath();
        ctx.arc(s.x, s.y + Math.sin(t * 0.00004 + s.p) * 3, s.r, 0, 7);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
  },

  rain: {
    label: '창밖 비',
    sky: ['#080A10', '#0F131C', '#151A26'],
    init(w, h) {
      return {
        drops: Array.from({ length: 110 }, () => ({
          x: Math.random() * w,
          y: Math.random() * h,
          l: 8 + Math.random() * 22,
          v: 1.4 + Math.random() * 2.6,
          a: 0.06 + Math.random() * 0.16,
        })),
      };
    },
    draw(ctx, w, h, st) {
      ctx.strokeStyle = '#9FB4D8';
      ctx.lineWidth = 1;
      for (const d of st.drops) {
        ctx.globalAlpha = d.a;
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - 1.5, d.y + d.l);
        ctx.stroke();
        d.y += d.v * 2.4;
        if (d.y > h) { d.y = -d.l; d.x = Math.random() * w; }
      }
      ctx.globalAlpha = 1;
    },
  },

  waves: {
    label: '파도',
    sky: ['#080B14', '#0D1422', '#122032'],
    init() { return {}; },
    draw(ctx, w, h, st, t) {
      for (let i = 0; i < 5; i++) {
        const base = h * (0.55 + i * 0.09);
        const amp = 9 + i * 5;
        const sp = 0.00016 + i * 0.00007;
        ctx.beginPath();
        ctx.moveTo(0, base);
        for (let x = 0; x <= w; x += 6) {
          ctx.lineTo(x, base + Math.sin(x * 0.011 + t * sp + i) * amp);
        }
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.fillStyle = `rgba(90,130,180,${0.05 + i * 0.022})`;
        ctx.fill();
      }
    },
  },

  fire: {
    label: '모닥불',
    sky: ['#0C0806', '#160E09', '#1E120A'],
    init(w, h) {
      return {
        embers: Array.from({ length: 34 }, () => ({
          x: w / 2 + (Math.random() - 0.5) * w * 0.32,
          y: h * 0.78 + Math.random() * 60,
          r: Math.random() * 1.6 + 0.6,
          v: 0.3 + Math.random() * 0.8,
          d: (Math.random() - 0.5) * 0.35,
          a: Math.random(),
        })),
      };
    },
    draw(ctx, w, h, st, t) {
      const cx = w / 2;
      const cy = h * 0.8;
      const pulse = 0.82 + 0.18 * Math.sin(t * 0.0014) + 0.06 * Math.sin(t * 0.0051);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.62 * pulse);
      g.addColorStop(0, 'rgba(226,140,58,0.30)');
      g.addColorStop(0.4, 'rgba(180,88,36,0.12)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      for (const e of st.embers) {
        ctx.globalAlpha = Math.max(0, e.a) * 0.75;
        ctx.fillStyle = '#F0A24A';
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r, 0, 7);
        ctx.fill();
        e.y -= e.v;
        e.x += e.d;
        e.a -= 0.004;
        if (e.a <= 0 || e.y < h * 0.28) {
          e.y = cy + Math.random() * 40;
          e.x = cx + (Math.random() - 0.5) * w * 0.32;
          e.a = 1;
        }
      }
      ctx.globalAlpha = 1;
    },
  },
};

export const sceneList = Object.entries(SCENES).map(([id, s]) => ({ id, label: s.label }));

export class SceneRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.id = 'stars';
    this.state = null;
    this.raf = null;
    this.running = false;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._pause();
      else if (this.running) this._loop();
    });
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    this.state = SCENES[this.id].init(w, h);
  }

  set(id) {
    if (!SCENES[id]) return;
    this.id = id;
    this.resize();
    const [a, b, c] = SCENES[id].sky;
    this.canvas.style.background = `linear-gradient(#0000,#0000), radial-gradient(120% 80% at 50% 0%, ${c} 0%, ${b} 45%, ${a} 100%)`;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.set(this.id);
    this._loop();
  }

  _loop() {
    cancelAnimationFrame(this.raf);
    const step = (t) => {
      const { ctx, w, h } = this;
      ctx.clearRect(0, 0, w, h);
      SCENES[this.id].draw(ctx, w, h, this.state, t);
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  _pause() {
    cancelAnimationFrame(this.raf);
  }

  stop() {
    this.running = false;
    this._pause();
    this.ctx.clearRect(0, 0, this.w, this.h);
  }
}
