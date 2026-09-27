/**
 * TabSync Studio - AI Shape & Geometry Recognition Engine
 * Fast, deterministic geometric classification and curve beautification.
 * Recognizes straight lines, circles/ellipses, rectangles/squares, and arrows from human freehand strokes.
 */

(function(global) {
  'use strict';

  class AIShapeRecognizer {
    /**
     * Recognize whether a sequence of normalized points forms a geometric shape.
     * @param {Array<{x: number, y: number, p?: number}>} points 
     * @param {Object} options 
     * @returns {{ matched: boolean, shape?: string, confidence?: number, points?: Array, tool?: string }}
     */
    static recognize(points, options = {}) {
      if (!points || points.length < 5) {
        return { matched: false };
      }

      const minConfidence = options.minConfidence || 0.75;
      const n = points.length;

      // 1. Calculate path length and chord distance
      let totalLength = 0;
      for (let i = 1; i < n; i++) {
        const dx = points[i].x - points[i - 1].x;
        const dy = points[i].y - points[i - 1].y;
        totalLength += Math.hypot(dx, dy);
      }

      if (totalLength < 0.02) {
        return { matched: false }; // Too small to be a shape
      }

      const p0 = points[0];
      const pEnd = points[n - 1];
      const chord = Math.hypot(pEnd.x - p0.x, pEnd.y - p0.y);
      const linearity = chord / totalLength;

      // 2. Bounding Box & Centroid
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let sumX = 0, sumY = 0;

      for (let i = 0; i < n; i++) {
        const pt = points[i];
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
        sumX += pt.x;
        sumY += pt.y;
      }

      const width = maxX - minX;
      const height = maxY - minY;
      const cx = sumX / n;
      const cy = sumY / n;
      const bboxPerimeter = 2 * (width + height);

      // Check for closed loop: endpoints are close relative to dimensions
      const endpointGap = chord;
      const maxDim = Math.max(width, height);
      const isClosedLoop = endpointGap < Math.max(0.04, maxDim * 0.28);

      // -------------------------------------------------------------
      // SHAPE A: STRAIGHT LINE
      // -------------------------------------------------------------
      if (linearity > 0.93 && !isClosedLoop) {
        let pStartSnap = { x: p0.x, y: p0.y };
        let pEndSnap = { x: pEnd.x, y: pEnd.y };

        // Snap to perfect horizontal / vertical if within small threshold (~2 degrees)
        const dx = Math.abs(pEndSnap.x - pStartSnap.x);
        const dy = Math.abs(pEndSnap.y - pStartSnap.y);
        if (dy < 0.025 && dx > 0.08) {
          pEndSnap.y = pStartSnap.y; // Snap horizontal
        } else if (dx < 0.025 && dy > 0.08) {
          pEndSnap.x = pStartSnap.x; // Snap vertical
        }

        const confidence = Math.min(0.99, linearity);
        if (confidence >= minConfidence) {
          return {
            matched: true,
            shape: 'line',
            tool: 'line',
            confidence: Math.round(confidence * 100) / 100,
            points: [pStartSnap, pEndSnap]
          };
        }
      }

      // -------------------------------------------------------------
      // SHAPE B: CIRCLE OR ELLIPSE
      // -------------------------------------------------------------
      if (isClosedLoop && width > 0.03 && height > 0.03) {
        // Measure radial deviation from centroid
        let sumR = 0;
        const radii = [];
        for (let i = 0; i < n; i++) {
          const r = Math.hypot(points[i].x - cx, points[i].y - cy);
          radii.push(r);
          sumR += r;
        }
        const meanR = sumR / n;

        let varR = 0;
        for (let i = 0; i < n; i++) {
          varR += Math.pow(radii[i] - meanR, 2);
        }
        const stdR = Math.sqrt(varR / n);
        const coeffVar = stdR / (meanR + 1e-6);

        // Circularity metric: perimeter vs expected circle circumference
        const expectedCircumference = 2 * Math.PI * meanR;
        const circRatio = Math.abs(totalLength - expectedCircumference) / expectedCircumference;

        if (coeffVar < 0.18 && circRatio < 0.35) {
          const confidence = Math.min(0.98, Math.max(0.70, 1.0 - coeffVar * 2));
          if (confidence >= minConfidence) {
            // Snap to symmetrical circle if aspect ratio is close to 1
            const aspect = width / (height + 1e-6);
            let finalStart, finalEnd;

            if (aspect >= 0.85 && aspect <= 1.18) {
              // Perfect Circle
              const r = Math.max(width, height) / 2;
              finalStart = { x: cx - r, y: cy - r };
              finalEnd = { x: cx + r, y: cy + r };
            } else {
              // Ellipse
              finalStart = { x: minX, y: minY };
              finalEnd = { x: maxX, y: maxY };
            }

            return {
              matched: true,
              shape: 'circle',
              tool: 'circle',
              confidence: Math.round(confidence * 100) / 100,
              points: [finalStart, finalEnd]
            };
          }
        }
      }

      // -------------------------------------------------------------
      // SHAPE C: RECTANGLE / SQUARE
      // -------------------------------------------------------------
      if (isClosedLoop && width > 0.04 && height > 0.04) {
        // Compare path perimeter to bounding box perimeter
        const perimeterDiff = Math.abs(totalLength - bboxPerimeter) / bboxPerimeter;

        // Check corner distribution: points should be near the 4 bbox segments
        let boundaryDivergence = 0;
        for (let i = 0; i < n; i++) {
          const pt = points[i];
          const distToLeft = Math.abs(pt.x - minX);
          const distToRight = Math.abs(pt.x - maxX);
          const distToTop = Math.abs(pt.y - minY);
          const distToBottom = Math.abs(pt.y - maxY);
          const minEdgeDist = Math.min(distToLeft, distToRight, distToTop, distToBottom);
          boundaryDivergence += minEdgeDist;
        }
        const avgDivergence = boundaryDivergence / n;
        const divergenceRatio = avgDivergence / maxDim;

        if (perimeterDiff < 0.28 && divergenceRatio < 0.14) {
          const confidence = Math.min(0.97, Math.max(0.70, 1.0 - divergenceRatio * 3));
          if (confidence >= minConfidence) {
            // Check for Square snap
            const aspect = width / (height + 1e-6);
            let start = { x: minX, y: minY };
            let end = { x: maxX, y: maxY };

            if (aspect >= 0.88 && aspect <= 1.14) {
              const side = (width + height) / 2;
              end = { x: minX + side, y: minY + side };
            }

            return {
              matched: true,
              shape: 'rect',
              tool: 'rect',
              confidence: Math.round(confidence * 100) / 100,
              points: [start, end]
            };
          }
        }
      }

      // -------------------------------------------------------------
      // SHAPE D: ARROW
      // -------------------------------------------------------------
      if (!isClosedLoop && totalLength > 0.10 && points.length > 8) {
        // Test if last 25% of stroke turns back sharply to form an arrowhead
        const splitIdx = Math.floor(n * 0.70);
        const shaftPts = points.slice(0, splitIdx);
        const headPts = points.slice(splitIdx);

        let shaftLen = 0;
        for (let i = 1; i < shaftPts.length; i++) {
          shaftLen += Math.hypot(shaftPts[i].x - shaftPts[i-1].x, shaftPts[i].y - shaftPts[i-1].y);
        }
        const shaftChord = Math.hypot(shaftPts[shaftPts.length - 1].x - shaftPts[0].x, shaftPts[shaftPts.length - 1].y - shaftPts[0].y);

        if (shaftChord / (shaftLen + 1e-6) > 0.90) {
          // Shaft is straight, now test if head diverges and returns
          const startPt = shaftPts[0];
          const tipPt = shaftPts[shaftPts.length - 1];
          const endPt = headPts[headPts.length - 1];
          const headReversal = Math.hypot(endPt.x - tipPt.x, endPt.y - tipPt.y);

          if (headReversal > 0.02 && headReversal < shaftChord * 0.45) {
            return {
              matched: true,
              shape: 'arrow',
              tool: 'arrow',
              confidence: 0.82,
              points: [{ x: startPt.x, y: startPt.y }, { x: tipPt.x, y: tipPt.y }]
            };
          }
        }
      }

      return { matched: false };
    }
  }

  // Export for CommonJS (Node tests), ES modules, and Browser window
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AIShapeRecognizer;
  }
  if (typeof global !== 'undefined') {
    global.AIShapeRecognizer = AIShapeRecognizer;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
