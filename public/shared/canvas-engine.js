/**
 * TabSync Studio - Vector Canvas Engine
 * High performance, rock-solid coordinate math, guaranteed zero-NaN.
 */

class CanvasEngine {
  constructor(canvasElement, options = {}) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.isReadOnly = options.isReadOnly || false;
    this.backgroundStyle = options.backgroundStyle || 'dark-dots';

    this.currentTool = 'pen';
    this.currentColor = '#38bdf8';
    this.currentSize = 4;
    this.currentOpacity = 1.0;

    this.history = [];
    this.redoStack = [];
    this.activeStroke = null;

    this.laserPointer = null;
    this.laserTrail = [];

    this.dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;

    // Offscreen background caching for 120Hz high-efficiency rendering
    this.bgCanvas = (typeof document !== 'undefined' && document.createElement) ? document.createElement('canvas') : null;
    this.bgDirty = true;

    if (typeof ResizeObserver !== 'undefined' && this.canvas) {
      this.setupResizeObserver();
    }
    if (typeof requestAnimationFrame !== 'undefined') {
      this.startLaserAnimationLoop();
    }
  }

  setupResizeObserver() {
    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(this.canvas.parentElement || document.body);
    this.resize();
  }

  resize() {
    const parent = this.canvas.parentElement || document.body;
    const rect = parent.getBoundingClientRect();
    
    this.width = Math.max(rect.width || window.innerWidth, 300);
    this.height = Math.max(rect.height || window.innerHeight, 300);
    this.dpr = window.devicePixelRatio || 1;

    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.bgDirty = true;
    this.redrawAll();
  }

  setBackground(style) {
    this.backgroundStyle = style;
    this.bgDirty = true;
    this.redrawAll();
  }

  drawBackground(targetCtx = this.ctx) {
    // Utilize offscreen cached canvas buffer to prevent repetitive arc/stroke loops during pen moves
    if (this.bgCanvas) {
      if (this.bgDirty || this.bgCanvas.width !== this.canvas.width || this.bgCanvas.height !== this.canvas.height) {
        this.bgCanvas.width = this.canvas.width;
        this.bgCanvas.height = this.canvas.height;
        const bCtx = this.bgCanvas.getContext('2d');
        this.renderBackgroundToContext(bCtx);
        this.bgDirty = false;
      }
      targetCtx.drawImage(this.bgCanvas, 0, 0);
      return;
    }

    this.renderBackgroundToContext(targetCtx);
  }

  renderBackgroundToContext(ctx) {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dpr = this.dpr;

    ctx.save();
    let bgFill = '#0b0f19';
    switch (this.backgroundStyle) {
      case 'light-dots':
      case 'light-grid':
      case 'pure-white':
        bgFill = '#ffffff';
        break;
      case 'paper':
        bgFill = '#f7f4ed';
        break;
      case 'pure-black':
        bgFill = '#000000';
        break;
      case 'dark-dots':
      case 'dark-grid':
      default:
        bgFill = '#0b0f19';
        break;
    }
    ctx.fillStyle = bgFill;
    ctx.fillRect(0, 0, w, h);

    const isLight = this.backgroundStyle.startsWith('light') || this.backgroundStyle === 'paper';
    const dotColor = isLight ? 'rgba(0, 0, 0, 0.14)' : 'rgba(255, 255, 255, 0.12)';
    const gridColor = isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.07)';
    const gridSize = 28 * dpr;

    if (this.backgroundStyle.includes('dots')) {
      ctx.fillStyle = dotColor;
      for (let x = gridSize / 2; x < w; x += gridSize) {
        for (let y = gridSize / 2; y < h; y += gridSize) {
          ctx.beginPath();
          ctx.arc(x, y, 1.4 * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } else if (this.backgroundStyle.includes('grid')) {
      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      for (let x = 0; x <= w; x += gridSize) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = 0; y <= h; y += gridSize) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
    } else if (this.backgroundStyle === 'paper') {
      ctx.strokeStyle = 'rgba(70, 130, 180, 0.2)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      const lineSpacing = 32 * dpr;
      for (let y = lineSpacing; y <= h; y += lineSpacing) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  addPoint(stroke, pt) {
    if (!stroke || !pt) return false;
    if (!stroke.points || stroke.points.length === 0) {
      stroke.points = [pt];
      return true;
    }
    const last = stroke.points[stroke.points.length - 1];
    // Decimate sub-pixel micro-jitter (< 1.5 pixels delta) to prevent curve bloat
    const dx = (pt.x - last.x) * (this.width || 1000);
    const dy = (pt.y - last.y) * (this.height || 1000);
    const distSq = dx * dx + dy * dy;
    if (distSq < 2.25) {
      return false;
    }
    stroke.points.push(pt);
    return true;
  }

  toNorm(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width > 0 ? rect.width : (this.width || window.innerWidth || 1);
    const h = rect.height > 0 ? rect.height : (this.height || window.innerHeight || 1);

    const relX = clientX - rect.left;
    const relY = clientY - rect.top;

    const nx = relX / w;
    const ny = relY / h;

    return {
      x: isFinite(nx) ? Math.min(Math.max(nx, 0), 1) : 0,
      y: isFinite(ny) ? Math.min(Math.max(ny, 0), 1) : 0
    };
  }

  toCanvas(nx, ny) {
    const validNx = isFinite(nx) ? nx : 0;
    const validNy = isFinite(ny) ? ny : 0;
    return {
      x: validNx * this.canvas.width,
      y: validNy * this.canvas.height
    };
  }

  startStroke(strokeData) {
    return {
      id: strokeData.id || 'str-' + Math.random().toString(36).substr(2, 9),
      tool: strokeData.tool || this.currentTool,
      color: strokeData.color || this.currentColor,
      size: strokeData.size || this.currentSize,
      opacity: strokeData.opacity || this.currentOpacity,
      points: strokeData.points ? [...strokeData.points] : []
    };
  }

  renderStroke(stroke, targetCtx = this.ctx) {
    if (!stroke || !stroke.points || stroke.points.length === 0) return;
    const points = stroke.points;
    const ctx = targetCtx;
    const dpr = this.dpr;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const tool = stroke.tool;
    const baseColor = stroke.color;
    const baseSize = stroke.size * dpr;

    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth = baseSize * 3;
    } else if (tool === 'highlighter') {
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = baseColor;
      ctx.lineWidth = baseSize * 3;
      ctx.lineCap = 'square';
    } else if (tool === 'neon') {
      ctx.strokeStyle = baseColor;
      ctx.shadowColor = baseColor;
      ctx.shadowBlur = 14 * dpr;
      ctx.lineWidth = baseSize;
    } else {
      ctx.strokeStyle = baseColor;
      ctx.globalAlpha = stroke.opacity || 1.0;
    }

    if (['line', 'arrow', 'rect', 'circle'].includes(tool)) {
      if (points.length >= 2) {
        const start = this.toCanvas(points[0].x, points[0].y);
        const end = this.toCanvas(points[points.length - 1].x, points[points.length - 1].y);
        ctx.lineWidth = baseSize;

        if (tool === 'line') {
          ctx.beginPath();
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
          ctx.stroke();
        } else if (tool === 'rect') {
          ctx.beginPath();
          ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
        } else if (tool === 'circle') {
          const rx = Math.abs(end.x - start.x) / 2;
          const ry = Math.abs(end.y - start.y) / 2;
          const cx = Math.min(start.x, end.x) + rx;
          const cy = Math.min(start.y, end.y) + ry;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.stroke();
        } else if (tool === 'arrow') {
          this.drawArrow(ctx, start.x, start.y, end.x, end.y, baseSize);
        }
      }
      ctx.restore();
      return;
    }

    if (points.length === 1) {
      const p = this.toCanvas(points[0].x, points[0].y);
      const pressure = points[0].p !== undefined ? points[0].p : 0.5;
      const radius = Math.max(1.5, (baseSize * (0.35 + 1.2 * pressure)) / 2);
      ctx.fillStyle = tool === 'eraser' ? 'rgba(0,0,0,1)' : baseColor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    for (let i = 0; i < points.length - 1; i++) {
      const p0 = this.toCanvas(points[i].x, points[i].y);
      const p1 = this.toCanvas(points[i + 1].x, points[i + 1].y);

      const pressure = points[i].p !== undefined ? points[i].p : 0.5;
      let strokeWidth = baseSize;
      if (tool === 'brush' || tool === 'pen') {
        strokeWidth = baseSize * (0.35 + 1.3 * pressure);
      } else if (tool === 'eraser') {
        strokeWidth = baseSize * 3;
      }

      ctx.lineWidth = strokeWidth;
      ctx.beginPath();

      if (i === 0) {
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
      } else {
        const prev = this.toCanvas(points[i - 1].x, points[i - 1].y);
        ctx.moveTo((prev.x + p0.x) / 2, (prev.y + p0.y) / 2);
        ctx.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  drawArrow(ctx, fromx, fromy, tox, toy, width) {
    const headlen = Math.max(width * 4, 14 * this.dpr);
    const angle = Math.atan2(toy - fromy, tox - fromx);

    ctx.beginPath();
    ctx.moveTo(fromx, fromy);
    ctx.lineTo(tox, toy);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(tox, toy);
    ctx.lineTo(tox - headlen * Math.cos(angle - Math.PI / 6), toy - headlen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(tox - headlen * Math.cos(angle + Math.PI / 6), toy - headlen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  }

  // Safe composite & commit methods
  composite() {
    this.redrawAll();
  }

  commitActiveStroke() {
    if (this.activeStroke) {
      this.history.push(this.activeStroke);
      this.activeStroke = null;
    }
    this.redrawAll();
  }

  redrawAll() {
    this.drawBackground();
    for (const stroke of this.history) {
      this.renderStroke(stroke);
    }
    if (this.activeStroke) {
      this.renderStroke(this.activeStroke);
    }
  }

  updateLaser(nx, ny, active = true) {
    this.laserPointer = { nx, ny, active, timestamp: Date.now() };
    if (active) {
      this.laserTrail.push({ nx, ny, time: Date.now() });
      if (this.laserTrail.length > 20) this.laserTrail.shift();
    }
  }

  hideLaser() {
    if (this.laserPointer) this.laserPointer.active = false;
  }

  startLaserAnimationLoop() {
    const animate = () => {
      const now = Date.now();
      this.laserTrail = this.laserTrail.filter(p => now - p.time < 600);

      if (this.laserPointer && (this.laserPointer.active || this.laserTrail.length > 0)) {
        this.redrawAll();
        this.drawLaserEffect();
      }

      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  drawLaserEffect() {
    const ctx = this.ctx;
    const now = Date.now();
    ctx.save();

    for (let i = 0; i < this.laserTrail.length; i++) {
      const pt = this.laserTrail[i];
      const age = now - pt.time;
      const alpha = Math.max(0, 1 - age / 600);
      const canvasPt = this.toCanvas(pt.nx, pt.ny);

      ctx.beginPath();
      ctx.arc(canvasPt.x, canvasPt.y, (8 + (1 - alpha) * 4) * this.dpr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(239, 68, 68, ${alpha * 0.45})`;
      ctx.fill();
    }

    if (this.laserPointer && this.laserPointer.active) {
      const p = this.toCanvas(this.laserPointer.nx, this.laserPointer.ny);
      ctx.shadowColor = '#ef4444';
      ctx.shadowBlur = 18 * this.dpr;

      ctx.beginPath();
      ctx.arc(p.x, p.y, 7 * this.dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3 * this.dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
    ctx.restore();
  }

  exportImage(type = 'image/png') {
    return this.canvas.toDataURL(type);
  }

  clear() {
    this.history = [];
    this.redoStack = [];
    this.activeStroke = null;
    this.redrawAll();
  }

  undo() {
    if (this.history.length > 0) {
      const stroke = this.history.pop();
      this.redoStack.push(stroke);
      this.redrawAll();
      return stroke;
    }
    return null;
  }

  redo() {
    if (this.redoStack.length > 0) {
      const stroke = this.redoStack.pop();
      this.history.push(stroke);
      this.redrawAll();
      return stroke;
    }
    return null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CanvasEngine;
} else {
  window.CanvasEngine = CanvasEngine;
}
