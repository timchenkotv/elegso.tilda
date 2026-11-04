(() => {
  'use strict';
  const hero = document.querySelector('.hero');
  const scene = document.querySelector('[data-hero-scene]');
  if (!hero || !scene) return;
  const canvas = scene.querySelector('.hero-scene__dust');
  const context = canvas?.getContext('2d', { alpha: true });
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = window.matchMedia('(pointer: coarse)');
  const button = document.querySelector('[data-motion-toggle]');
  const cards = [...document.querySelectorAll('.outcome-card,.route-card,.proof-card')];
  const root = document.documentElement;
  let enabled = true;
  try { enabled = localStorage.getItem('previewmotion') !== 'off'; } catch {}
  let visible = false;
  let frameId = 0;
  let previous = 0;
  let time = 0;
  let width = 1;
  let height = 1;
  let targetX = 0;
  let targetY = 0;
  let pointerX = 0;
  let pointerY = 0;
  let particles = [];
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const canAnimate = () => enabled && !reduced.matches && visible && !document.hidden;
  const airProperties = ['--scene-air-x', '--scene-air-y', '--scene-air-front-x', '--scene-air-opacity'];

  // Thin, cool air stays around the architecture and the statue's plinth.
  // It shares the scene clock; no second animation loop or moving sculpture.
  for (const depth of ['back', 'front']) {
    const air = document.createElement('span');
    air.className = `hero-scene__air hero-scene__air--${depth}`;
    air.setAttribute('aria-hidden', 'true');
    scene.append(air);
  }

  const glints = [[.67,.66], [.81,.39], [.89,.76], [.855,.31]].map(([x,y], i) => {
    const glint = document.createElement('span');
    glint.className = `hero-scene__glint${i === 3 ? ' hero-scene__glint--themis' : ''}`;
    glint.setAttribute('aria-hidden', 'true');
    glint.style.left = `${x * 100}%`;
    glint.style.top = `${y * 100}%`;
    glint.dataset.glint = String(i);
    scene.append(glint);
    return glint;
  });

  function resize() {
    const rect = scene.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (canvas && context) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const count = coarse.matches || width < 768 ? 9 : 21;
    particles = Array.from({ length: count }, () => ({
      x: Math.random() - .5,
      y: Math.random() * 2 - 1,
      z: .8 + Math.random() * 2.1,
      speed: .012 + Math.random() * .018,
      radius: .55 + Math.random() * .7,
      alpha: .07 + Math.random() * .12,
      phase: Math.random() * Math.PI * 2,
    }));
    if (!canAnimate()) clearCanvas();
  }

  function clearCanvas() {
    context?.clearRect(0, 0, width, height);
  }

  function drawDust(delta) {
    if (!context) return;
    context.clearRect(0, 0, width, height);
    for (const p of particles) {
      p.y -= delta * p.speed;
      if (p.y < -1) p.y = 1;
      const depth = 1 / (1 + p.z);
      const x = width * .77 + (p.x + Math.sin(time * .11 + p.phase) * .04) * width * depth * .85;
      const y = height * .53 + p.y * height * depth * .72;
      const opacity = p.alpha * (.72 + Math.sin(time * .17 + p.phase) * .18);
      context.beginPath();
      context.fillStyle = `rgba(197,171,116,${opacity.toFixed(3)})`;
      context.arc(x + pointerX * 3 * depth, y + pointerY * 2 * depth, p.radius * (.5 + depth), 0, Math.PI * 2);
      context.fill();
    }
  }

  function render(timestamp) {
    frameId = 0;
    if (!canAnimate()) return;
    if (timestamp - previous >= 1000 / 30) {
      const delta = Math.min((timestamp - previous) / 1000 || 0, .08);
      previous = timestamp;
      time += delta;
      pointerX += (targetX - pointerX) * .065;
      pointerY += (targetY - pointerY) * .065;
      hero.style.setProperty('--scene-x', `${(pointerX * 10 + Math.sin(time * .29) * .8).toFixed(2)}px`);
      hero.style.setProperty('--scene-y', `${(pointerY * 7 + Math.cos(time * .23) * .55).toFixed(2)}px`);
      hero.style.setProperty('--scene-rx', `${(-pointerY * .65).toFixed(3)}deg`);
      hero.style.setProperty('--scene-ry', `${(pointerX * .8).toFixed(3)}deg`);
      hero.style.setProperty('--scene-light-x', `${(74 + Math.sin(time * .16) * 9 + pointerX * 3).toFixed(2)}%`);
      hero.style.setProperty('--scene-light-y', `${(38 + Math.cos(time * .12) * 10 + pointerY * 3).toFixed(2)}%`);
      hero.style.setProperty('--scene-air-x', `${(Math.sin(time * .13) * 22 + pointerX * 3).toFixed(2)}px`);
      hero.style.setProperty('--scene-air-y', `${(Math.cos(time * .11) * 3 + pointerY).toFixed(2)}px`);
      hero.style.setProperty('--scene-air-front-x', `${(Math.sin(time * .1 + 1.6) * 30 + pointerX * 5).toFixed(2)}px`);
      hero.style.setProperty('--scene-air-opacity', ((coarse.matches || width < 768 ? .32 : .56) + Math.sin(time * .17) * .06).toFixed(3));
      glints.forEach((glint, index) => {
        const glow = Math.pow(Math.max(0, Math.sin(time * .48 + index * 2.1)), 5);
        const strength = index === 3 ? .18 : .3;
        glint.style.opacity = (glow * (coarse.matches ? strength * .43 : strength)).toFixed(3);
      });
      drawDust(delta);
    }
    frameId = requestAnimationFrame(render);
  }

  function resetCard(card) {
    card.removeAttribute('data-tilt-active');
    for (const name of ['--card-rx','--card-ry','--card-light-x','--card-light-y']) card.style.removeProperty(name);
  }

  function reconcile() {
    const active = canAnimate();
    root.dataset.previewMotion = enabled && !reduced.matches ? 'on' : 'off';
    scene.dataset.motion = active ? 'active' : 'paused';
    if (button) {
      button.setAttribute('aria-pressed', String(enabled && !reduced.matches));
      button.disabled = reduced.matches;
      button.title = reduced.matches ? 'Движение отключено настройками устройства' : enabled ? 'Остановить движение' : 'Включить движение';
      const label = button.querySelector('[data-motion-label]');
      if (label) label.textContent = enabled && !reduced.matches ? 'Движение: вкл.' : 'Движение: выкл.';
    }
    if (active && !frameId) { previous = performance.now(); frameId = requestAnimationFrame(render); }
    if (!active && frameId) { cancelAnimationFrame(frameId); frameId = 0; }
    if (!active) airProperties.forEach(name => hero.style.removeProperty(name));
    if (!enabled || reduced.matches) {
      targetX = targetY = pointerX = pointerY = 0;
      for (const name of ['--scene-x','--scene-y','--scene-rx','--scene-ry']) hero.style.removeProperty(name);
      glints.forEach(glint => { glint.style.opacity = '0'; });
      cards.forEach(resetCard);
      clearCanvas();
    }
  }

  hero.addEventListener('pointermove', event => {
    if (!enabled || reduced.matches || coarse.matches || event.pointerType === 'touch') return;
    const rect = hero.getBoundingClientRect();
    targetX = clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
    targetY = clamp((event.clientY - rect.top) / rect.height * 2 - 1, -1, 1);
  }, { passive: true });
  hero.addEventListener('pointerleave', () => { targetX = targetY = 0; });
  cards.forEach(card => {
    card.addEventListener('pointermove', event => {
      if (!enabled || reduced.matches || coarse.matches || event.pointerType === 'touch') return;
      const rect = card.getBoundingClientRect();
      const x = clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
      const y = clamp((event.clientY - rect.top) / rect.height * 2 - 1, -1, 1);
      card.setAttribute('data-tilt-active', '');
      card.style.setProperty('--card-rx', `${(-y * 2).toFixed(2)}deg`);
      card.style.setProperty('--card-ry', `${(x * 2).toFixed(2)}deg`);
      card.style.setProperty('--card-light-x', `${((x + 1) * 50).toFixed(1)}%`);
      card.style.setProperty('--card-light-y', `${((y + 1) * 50).toFixed(1)}%`);
    }, { passive: true });
    card.addEventListener('pointerleave', () => resetCard(card));
    card.addEventListener('pointercancel', () => resetCard(card));
    card.addEventListener('blur', () => resetCard(card), true);
  });
  button?.addEventListener('click', () => {
    enabled = !enabled;
    try { localStorage.setItem('previewmotion', enabled ? 'on' : 'off'); } catch {}
    reconcile();
  });
  document.addEventListener('visibilitychange', reconcile);
  reduced.addEventListener('change', reconcile);
  coarse.addEventListener('change', () => { cards.forEach(resetCard); resize(); reconcile(); });
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(scene);
  else window.addEventListener('resize', resize, { passive: true });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => { visible = entries[0].isIntersecting; reconcile(); }, { threshold: .02 }).observe(hero);
  } else {
    const check = () => { const r = hero.getBoundingClientRect(); visible = r.bottom > 0 && r.top < innerHeight; reconcile(); };
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check, { passive: true });
    check();
  }
  const rect = hero.getBoundingClientRect();
  visible = rect.bottom > 0 && rect.top < innerHeight;
  resize();
  reconcile();
})();
