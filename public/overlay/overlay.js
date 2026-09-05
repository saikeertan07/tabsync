/**
 * TabSync Studio - Mac Screen Overlay Canvas Renderer
 * Ultra-low latency, crisp retina vector inking over any macOS application
 */
(function() {
  'use strict';

  const canvas = document.getElementById('overlay-canvas');
  const ctx = canvas.getContext('2d');

  let strokes = [];
  let activeStroke = null;
  let dpr = window.devicePixelRatio || 1;
  let ws = null;

  // Laser Pointer state
  let laserPoint = null; // { x, y, active }
  let laserTrail = [];   // [{ x, y, time }]
  let animFrameId = null;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    redrawAll();
  }

  window.addEventListener('resize', resize);
  resize();

  function toCanvas(nx, ny) {
    return {
      x: nx * canvas.width,
      y: ny * canvas.height
    };
  }

  function renderStroke(stroke, targetCtx = ctx) {
    if (!stroke || !stroke.points || stroke.points.length === 0) return;
    const pts = stroke.points;
    const c = targetCtx;

    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';

    const baseSize = (stroke.size || 6) * dpr;
    const color = stroke.color || '#0ea5e9';

    if (stroke.tool === 'eraser') {
      c.globalCompositeOperation = 'destination-out';
      c.strokeStyle = 'rgba(0,0,0,1)';
      c.lineWidth = baseSize * 3.5;
    } else if (stroke.tool === 'highlighter') {
      c.globalAlpha = 0.35;
      c.strokeStyle = color;
      c.lineWidth = baseSize * 3;
    } else {
      c.strokeStyle = color;
      c.globalAlpha = 1.0;
      c.lineWidth = baseSize;
    }

    if (pts.length === 1) {
      const p = toCanvas(pts[0].x, pts[0].y);
      const pr = pts[0].p !== undefined ? pts[0].p : 0.5;
      c.fillStyle = stroke.tool === 'eraser' ? 'rgba(0,0,0,1)' : color;
      c.beginPath();
      c.arc(p.x, p.y, Math.max(2, (c.lineWidth * (0.6 + 0.8 * pr)) / 2), 0, Math.PI * 2);
      c.fill();
      c.restore();
      return;
    }

    // High performance smooth Bézier curve
    const p0 = toCanvas(pts[0].x, pts[0].y);
    c.beginPath();
    c.moveTo(p0.x, p0.y);

    if (pts.length === 2) {
      const p1 = toCanvas(pts[1].x, pts[1].y);
      c.lineTo(p1.x, p1.y);
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        const pc = toCanvas(pts[i].x, pts[i].y);
        const pn = toCanvas(pts[i + 1].x, pts[i + 1].y);
        const midX = (pc.x + pn.x) / 2;
        const midY = (pc.y + pn.y) / 2;
        c.quadraticCurveTo(pc.x, pc.y, midX, midY);
      }
      const last = toCanvas(pts[pts.length - 1].x, pts[pts.length - 1].y);
      c.lineTo(last.x, last.y);
    }

    c.stroke();
    c.restore();
  }

  function renderSegment(pts, stroke) {
    if (!pts || pts.length < 2) return;
    const c = ctx;
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';

    const baseSize = (stroke.size || 6) * dpr;
    const color = stroke.color || '#0ea5e9';

    if (stroke.tool === 'eraser') {
      c.globalCompositeOperation = 'destination-out';
      c.strokeStyle = 'rgba(0,0,0,1)';
      c.lineWidth = baseSize * 3.5;
    } else if (stroke.tool === 'highlighter') {
      c.globalAlpha = 0.35;
      c.strokeStyle = color;
      c.lineWidth = baseSize * 3;
    } else {
      c.strokeStyle = color;
      c.globalAlpha = 1.0;
      c.lineWidth = baseSize;
    }

    const p0 = toCanvas(pts[pts.length - 2].x, pts[pts.length - 2].y);
    const p1 = toCanvas(pts[pts.length - 1].x, pts[pts.length - 1].y);

    c.beginPath();
    c.moveTo(p0.x, p0.y);
    c.lineTo(p1.x, p1.y);
    c.stroke();
    c.restore();
  }

  function renderLaser() {
    const now = Date.now();
    laserTrail = laserTrail.filter(pt => now - pt.time < 450);

    if (laserTrail.length > 1) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 0; i < laserTrail.length - 1; i++) {
        const p1 = toCanvas(laserTrail[i].x, laserTrail[i].y);
        const p2 = toCanvas(laserTrail[i + 1].x, laserTrail[i + 1].y);
        const age = now - laserTrail[i].time;
        const progress = 1 - (age / 450);
        ctx.strokeStyle = `rgba(244, 63, 94, ${progress * 0.75})`;
        ctx.lineWidth = 4 * dpr * progress;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (laserPoint && laserPoint.active) {
      const p = toCanvas(laserPoint.x, laserPoint.y);
      ctx.save();
      // Outer glow
      ctx.fillStyle = 'rgba(244, 63, 94, 0.4)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14 * dpr, 0, Math.PI * 2);
      ctx.fill();

      // Inner bright core
      ctx.fillStyle = '#f43f5e';
      ctx.shadowColor = '#f43f5e';
      ctx.shadowBlur = 12 * dpr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6 * dpr, 0, Math.PI * 2);
      ctx.fill();

      // Center white dot
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function redrawAll() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const stroke of strokes) {
      renderStroke(stroke);
    }
    if (activeStroke) {
      renderStroke(activeStroke);
    }

    renderLaser();
  }

  // Smooth animation loop for dynamic elements like laser trails
  function loop() {
    if (laserTrail.length > 0 || (laserPoint && laserPoint.active)) {
      redrawAll();
    }
    animFrameId = requestAnimationFrame(loop);
  }
  loop();

  function connectWS() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'register', role: 'overlay' }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {}
    };

    ws.onclose = () => {
      setTimeout(connectWS, 1500);
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'init':
        if (msg.history && Array.isArray(msg.history)) {
          strokes = msg.history;
          redrawAll();
        }
        break;

      case 'stroke_start':
        activeStroke = {
          id: msg.stroke.id,
          tool: msg.stroke.tool,
          color: msg.stroke.color,
          size: msg.stroke.size,
          points: [...msg.stroke.points]
        };
        if (activeStroke.points.length === 1) {
          renderStroke(activeStroke);
        }
        break;

      case 'stroke_point':
        if (activeStroke) {
          activeStroke.points.push(msg.point);
          renderSegment(activeStroke.points, activeStroke);
        }
        break;

      case 'stroke_end':
        if (msg.stroke) {
          strokes.push(msg.stroke);
        } else if (activeStroke) {
          strokes.push(activeStroke);
        }
        if (strokes.length > 800) strokes.shift();
        activeStroke = null;
        break;

      case 'laser_pointer':
        laserPoint = { x: msg.x, y: msg.y, active: msg.active !== false };
        if (laserPoint.active) {
          laserTrail.push({ x: msg.x, y: msg.y, time: Date.now() });
          if (laserTrail.length > 30) laserTrail.shift();
        }
        redrawAll();
        break;

      case 'clear':
        strokes = [];
        activeStroke = null;
        laserTrail = [];
        redrawAll();
        break;

      case 'sync_history':
        strokes = msg.history || [];
        redrawAll();
        break;

      case 'undo':
        strokes.pop();
        redrawAll();
        break;
    }
  }

  connectWS();
})();
