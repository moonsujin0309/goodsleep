// 캔버스 배경 씬 — 이미지 파일 0개
//
// 밤새 도는 그림이라 배터리가 우선이다. 움직이지 않는 것(은하수·성운·달무리)은
// init 에서 오프스크린 캔버스에 한 번만 그려 두고 매 프레임 블릿만 한다.
// 입자 수는 낮게, 화면이 숨겨지거나 딤 상태면 렌더를 완전히 멈춘다.

/** 정적 레이어용 오프스크린 캔버스 */
function still(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  return c;
}

const SCENES = {
  stars: {
    label: '별하늘',
    sky: ['#0B0A14', '#141026', '#1B1533'],
    photo: 'assets/scenes/stars.jpg',   // 진짜 은하수. 캔버스는 반짝임·유성만 얹는다
    video: 'assets/scenes/stars.mp4',
    init(w, h) {
      return {
        stars: Array.from({ length: 70 }, () => ({
          x: Math.random() * w,
          y: Math.random() * h * 0.8,
          r: Math.random() * 1.3 + 0.35,
          p: Math.random() * Math.PI * 2,
          s: 0.4 + Math.random() * 0.8,
          warm: Math.random() < 0.22,            // 몇 개는 따뜻한 별
        })),
        shoot: null,
        nextShoot: 9000 + Math.random() * 18000, // 첫 유성은 9~27초 뒤
      };
    },
    draw(ctx, w, h, st, t) {
      for (const s of st.stars) {
        const a = 0.22 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.0007 * s.s + s.p));
        ctx.globalAlpha = a;
        ctx.fillStyle = s.warm ? '#EFDDC0' : '#E7DFF2';
        ctx.beginPath();
        ctx.arc(s.x, s.y + Math.sin(t * 0.00004 + s.p) * 3, s.r, 0, 7);
        ctx.fill();
      }
      // 유성 — 드물게 하나. 자주 나오면 특별하지 않다.
      if (!st.shoot && t > st.nextShoot) {
        st.shoot = {
          x: w * (0.15 + Math.random() * 0.6),
          y: h * (0.06 + Math.random() * 0.2),
          vx: 2.6 + Math.random() * 1.6,
          vy: 1.3 + Math.random() * 0.9,
          life: 1,
        };
      }
      if (st.shoot) {
        const m = st.shoot;
        ctx.globalAlpha = Math.max(0, m.life) * 0.85;
        const tail = 46;
        const g = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * tail * 0.22, m.y - m.vy * tail * 0.22);
        g.addColorStop(0, 'rgba(240, 236, 255, 0.9)');
        g.addColorStop(1, 'rgba(240, 236, 255, 0)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(m.x - m.vx * tail * 0.22, m.y - m.vy * tail * 0.22);
        ctx.stroke();
        m.x += m.vx; m.y += m.vy; m.life -= 0.022;
        if (m.life <= 0 || m.x > w + 60) {
          st.shoot = null;
          st.nextShoot = t + 18000 + Math.random() * 26000;
        }
      }
      ctx.globalAlpha = 1;
    },
  },

  rain: {
    label: '창밖 비',
    sky: ['#080A10', '#0F131C', '#151A26'],
    photo: 'assets/scenes/rain.jpg',    // 유리에 맺힌 빗방울. 떨어지는 빗줄기는 캔버스가
    video: 'assets/scenes/rain.mp4',
    init(w, h) {
      const mk = (n, far) => Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        l: far ? 6 + Math.random() * 12 : 12 + Math.random() * 22,
        v: far ? 1.0 + Math.random() * 1.2 : 2.2 + Math.random() * 2.4,
        a: far ? 0.05 + Math.random() * 0.08 : 0.1 + Math.random() * 0.16,
      }));
      return {
        far: mk(60, true),                       // 먼 비 — 가늘고 느리다. 깊이가 생긴다
        near: mk(60, false),
        ripples: [],
        mist: still(w, h, (ctx) => {             // 낮게 깔린 물안개
          const g = ctx.createLinearGradient(0, h * 0.6, 0, h);
          g.addColorStop(0, 'rgba(140, 165, 205, 0)');
          g.addColorStop(1, 'rgba(140, 165, 205, 0.07)');
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, w, h);
        }),
      };
    },
    draw(ctx, w, h, st, t) {
      ctx.drawImage(st.mist, 0, 0, w, h);
      ctx.lineWidth = 1;
      for (const list of [st.far, st.near]) {
        ctx.strokeStyle = list === st.far ? '#7E93B8' : '#A9BEDF';
        for (const d of list) {
          ctx.globalAlpha = d.a;
          ctx.beginPath();
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(d.x - 1.5, d.y + d.l);
          ctx.stroke();
          d.y += d.v * 2.2;
          if (d.y > h) {
            // 굵은 비만 바닥에 파문을 남긴다
            if (list === st.near && Math.random() < 0.3 && st.ripples.length < 7) {
              st.ripples.push({ x: d.x, y: h - 4 - Math.random() * 10, r: 1, life: 1 });
            }
            d.y = -d.l;
            d.x = Math.random() * w;
          }
        }
      }
      ctx.strokeStyle = '#9FB4D8';
      for (const r of st.ripples) {
        ctx.globalAlpha = r.life * 0.16;
        ctx.beginPath();
        ctx.ellipse(r.x, r.y, r.r * 2.6, r.r, 0, 0, 7);
        ctx.stroke();
        r.r += 0.5;
        r.life -= 0.03;
      }
      st.ripples = st.ripples.filter((r) => r.life > 0);
      ctx.globalAlpha = 1;
      void t;
    },
  },

  waves: {
    label: '파도',
    sky: ['#080B14', '#0D1422', '#122032'],
    photo: 'assets/scenes/waves.jpg',   // 진짜 달빛 바다. 물결 띠만 캔버스가 얹는다
    video: 'assets/scenes/waves.mp4',
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
        // 물마루의 달빛 하이라이트 — 맨 위 두 겹만
        if (i < 2) {
          ctx.beginPath();
          for (let x = 0; x <= w; x += 6) {
            const y = base + Math.sin(x * 0.011 + t * sp + i) * amp;
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = `rgba(170, 200, 230, ${0.06 - i * 0.02})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    },
  },

  fire: {
    label: '모닥불',
    sky: ['#0C0806', '#160E09', '#1E120A'],
    photo: 'assets/scenes/fire.jpg',    // 진짜 모닥불. 불빛 맥동·불티·연기는 캔버스가
    video: 'assets/scenes/fire.mp4',
    init(w, h) {
      return {
        embers: Array.from({ length: 30 }, () => ({
          x: w / 2 + (Math.random() - 0.5) * w * 0.32,
          y: h * 0.78 + Math.random() * 60,
          r: Math.random() * 1.6 + 0.6,
          v: 0.3 + Math.random() * 0.8,
          d: (Math.random() - 0.5) * 0.35,
          a: Math.random(),
        })),
        wisps: Array.from({ length: 3 }, (_, i) => ({  // 연기 — 느리게 올라가 흩어진다
          x: w / 2 + (i - 1) * 30,
          y: h * (0.55 - i * 0.1),
          r: 26 + i * 14,
          p: i * 2.1,
        })),
      };
    },
    draw(ctx, w, h, st, t) {
      const cx = w / 2;
      const cy = h * 0.8;
      // 불빛 — 두 주기가 겹쳐 살아 있는 것처럼 흔들린다
      const pulse = 0.82 + 0.18 * Math.sin(t * 0.0014) + 0.06 * Math.sin(t * 0.0051);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.62 * pulse);
      g.addColorStop(0, 'rgba(226,140,58,0.30)');
      g.addColorStop(0.4, 'rgba(180,88,36,0.12)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      for (const s of st.wisps) {
        const drift = Math.sin(t * 0.0003 + s.p) * 18;
        const sg = ctx.createRadialGradient(s.x + drift, s.y, 0, s.x + drift, s.y, s.r);
        sg.addColorStop(0, 'rgba(120, 96, 80, 0.05)');
        sg.addColorStop(1, 'rgba(120, 96, 80, 0)');
        ctx.fillStyle = sg;
        ctx.fillRect(s.x + drift - s.r, s.y - s.r, s.r * 2, s.r * 2);
        s.y -= 0.12;
        if (s.y < h * 0.16) s.y = h * 0.6;
      }

      for (const e of st.embers) {
        ctx.globalAlpha = Math.max(0, e.a) * 0.75;
        ctx.fillStyle = e.r > 1.6 ? '#F6C06A' : '#F0A24A';
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r, 0, 7);
        ctx.fill();
        e.y -= e.v;
        e.x += e.d + Math.sin(t * 0.002 + e.y * 0.02) * 0.18;   // 상승 기류에 흔들린다
        e.a -= 0.004;
        if (e.a <= 0 || e.y < h * 0.28) {
          e.y = cy + Math.random() * 40;
          e.x = cx + (Math.random() - 0.5) * w * 0.32;
          e.a = 1;
          e.v = 0.3 + Math.random() * (Math.random() < 0.12 ? 1.8 : 0.8);  // 가끔 세게 튄다
        }
      }
      ctx.globalAlpha = 1;
    },
  },
};

export const sceneList = Object.entries(SCENES).map(([id, s]) => ({ id, label: s.label }));

export class SceneRenderer {
  constructor(canvas, video = null, back = null) {
    this.canvas = canvas;
    this.video = video;
    this.back = back;
    this.id = 'stars';
    this.ctx = canvas.getContext('2d');
    this.state = null;
    this.raf = null;
    this.running = false;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this._pause(); this.video?.pause(); }
      else if (this.running) { this._loop(); this._videoSync(); }
    });
    if (video) {
      // 실제로 첫 프레임이 나올 때만 떠오른다 — 로딩 중엔 사진 배경이 그대로 보인다
      video.addEventListener('playing', () => video.classList.add('is-on'));
      video.addEventListener('error', () => video.classList.remove('is-on'));
      // 딤 상태(나레이션 끝, 화면 어둡게)면 비디오를 멈춘다 — 밤새 디코딩은 배터리를 먹는다.
      // 앱 코드를 고치지 않으려고 클래스 변화를 여기서 감시한다.
      const app = document.getElementById('app');
      if (app) new MutationObserver(() => this._videoSync()).observe(app, {
        attributes: true, attributeFilter: ['class'],
      });
    }
  }

  /** 지금 상태(세션 중인가·딤인가·씬에 비디오가 있는가)에 맞춰 비디오를 켜고 끈다. */
  _videoSync() {
    const v = this.video;
    if (!v) return;
    const src = SCENES[this.id].video;
    const dim = document.getElementById('app')?.classList.contains('is-dim');
    if (!this.running || !src || dim || document.hidden) {
      v.pause();                       // 일시정지 프레임은 CSS 가 흐리게 남긴다
      return;
    }
    if (v.getAttribute('src') !== src) {
      v.classList.remove('is-on');
      v.setAttribute('src', src);
    }
    v.play().catch(() => { /* 자동재생 거부 등 — 사진 배경이 받친다 */ });
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
    // 바닥층: 사진, 못 받으면 그라데이션 — 깨진 이미지 층은 그냥 건너뛰어진다.
    // 스크림은 캔버스(CSS)가 항상 덮으므로 여기선 밝기를 걱정하지 않는다.
    const photo = SCENES[id].photo ? `url("${SCENES[id].photo}") center / cover no-repeat, ` : '';
    const bg = photo + `radial-gradient(120% 80% at 50% 0%, ${c} 0%, ${b} 45%, ${a} 100%)`;
    if (this.back) this.back.style.background = bg;
    else this.canvas.style.background = bg;
    this._videoSync();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.set(this.id);
    this._loop();
    this._videoSync();
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
    this.video?.pause();
    this.video?.classList.remove('is-on');
    this.ctx.clearRect(0, 0, this.w, this.h);
  }
}
