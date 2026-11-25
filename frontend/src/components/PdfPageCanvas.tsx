import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { Rnd } from 'react-rnd';
import {
  clampSquarePlacement,
  computeClampedCanvasBackingScale,
  getMaxQrPrintPt,
  getMinQrPrintPt,
  type PdfPageGeometry,
  type PdfPlacement,
} from '../lib/pdfEditor';

interface PdfPageCanvasProps {
  pdfDocument: PDFDocumentProxy;
  pageGeom: PdfPageGeometry;
  zoom: number;
  scrollRoot: HTMLElement | null;
  placements: PdfPlacement[];
  selectedPlacementId: string | null;
  generatedQrDataUrl: string | null;
  disabled?: boolean;
  onSelectPlacement: (id: string) => void;
  onUpdatePlacement: (id: string, next: Pick<PdfPlacement, 'x' | 'y' | 'w' | 'h'>) => void;
  onLiveSizeChange?: (id: string, liveWidthPx: number, pageCssWidth: number) => void;
}

function DummyQrPlaceholder({ active }: { active: boolean }) {
  return (
    <div
      aria-label="QR preview placeholder"
      className={`w-full h-full bg-white p-[10%] flex flex-col items-center justify-center relative select-none pointer-events-none border-2 ${
        active ? 'border-[#D9A441]' : 'border-slate-400 border-dashed'
      }`}
    >
      <svg
        viewBox="0 0 29 29"
        className="w-full h-full text-slate-400/85"
        aria-hidden="true"
        shapeRendering="crispEdges"
      >
        {/* Top-left finder */}
        <path
          fill="currentColor"
          d="M1 1h7v7H1V1zm1 1v5h5V2H2zm1 1h3v3H3V3z"
        />
        {/* Top-right finder */}
        <path
          fill="currentColor"
          d="M21 1h7v7h-7V1zm1 1v5h5V2h-5zm1 1h3v3h-3V3z"
        />
        {/* Bottom-left finder */}
        <path
          fill="currentColor"
          d="M1 21h7v7H1v-7zm1 1v5h5v-5H2zm1 1h3v3H3v-3z"
        />
        {/* Decorative placeholder modules */}
        <path
          fill="currentColor"
          d="M10 2h2v2h-2zM14 2h3v2h-3zM11 6h2v3h-2zM16 5h2v2h-2zM2 10h2v2H2zM6 11h3v2H6zM12 11h5v5h-5zM20 10h2v3h-2zM25 11h2v2h-2zM3 15h3v2H3zM19 16h3v2h-3zM24 16h3v3h-3zM10 19h2v3h-2zM15 20h4v2h-4zM21 21h2v2h-2zM25 22h3v3h-3zM11 25h3v2h-3zM17 25h3v3h-3zM23 26h2v2h-2z"
        />
      </svg>
      <span className="absolute inset-x-1 bottom-1 mx-auto w-fit px-1.5 py-0.5 rounded bg-[#0A1832]/85 text-white text-[9px] font-bold tracking-wide uppercase">
        QR Preview
      </span>
    </div>
  );
}

const CORNER_HANDLE_STYLE = {
  width: '12px',
  height: '12px',
  borderRadius: '9999px',
  backgroundColor: '#D9A441',
  border: '2px solid #0A1832',
  boxShadow: '0 1px 3px rgba(10,24,50,0.35)',
};

export function PdfPageCanvas({
  pdfDocument,
  pageGeom,
  zoom,
  scrollRoot,
  placements,
  selectedPlacementId,
  generatedQrDataUrl,
  disabled = false,
  onSelectPlacement,
  onUpdatePlacement,
  onLiveSizeChange,
}: PdfPageCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const cssScale = (96 / 72) * zoom;
  const cssWidth = Math.max(120, Math.round(pageGeom.displayedWidthPt * cssScale));
  const cssHeight = Math.max(120, Math.round(pageGeom.displayedHeightPt * cssScale));

  const [isVisible, setIsVisible] = useState(pageGeom.pageIndex === 0);
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number }>({
    width: cssWidth,
    height: cssHeight,
  });

  // Track actual CSS box via getBoundingClientRect (never canvas backing width or devicePixelRatio)
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const syncRect = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setMeasuredSize({ width: rect.width, height: rect.height });
      }
    };

    syncRect();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(syncRect);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cssWidth, cssHeight]);

  // Lazy visibility tracking to keep 100+ page documents lightweight
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === el) {
            setIsVisible(entry.isIntersecting);
          }
        }
      },
      { root: scrollRoot, rootMargin: '450px 0px', threshold: 0.01 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRoot]);

  // Render PDF page offscreen and swap onto display canvas to prevent flicker during zoom
  useEffect(() => {
    const displayCanvas = canvasRef.current;
    if (!displayCanvas) return;

    if (!isVisible) {
      displayCanvas.width = 0;
      displayCanvas.height = 0;
      return;
    }

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let loadedPage: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null;

    const renderPage = async () => {
      try {
        loadedPage = await pdfDocument.getPage(pageGeom.pageIndex + 1);
        if (cancelled) return;

        const baseViewport = loadedPage.getViewport({ scale: 1 });
        const desiredCssWidth = pageGeom.displayedWidthPt * cssScale;
        const desiredCssHeight = pageGeom.displayedHeightPt * cssScale;
        const backingDpr = computeClampedCanvasBackingScale({
          cssWidth: desiredCssWidth,
          cssHeight: desiredCssHeight,
          desiredDpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
          maxDpr: 3,
        });

        // Account for /UserUnit when computing pdf.js scale against physical points
        const baseScale = desiredCssWidth / Math.max(1, baseViewport.width);
        const renderViewport = loadedPage.getViewport({ scale: baseScale * backingDpr });

        const offscreen = document.createElement('canvas');
        offscreen.width = Math.max(1, Math.floor(renderViewport.width));
        offscreen.height = Math.max(1, Math.floor(renderViewport.height));

        const offCtx = offscreen.getContext('2d');
        if (!offCtx) return;

        renderTask = loadedPage.render({
          canvasContext: offCtx,
          viewport: renderViewport,
          canvas: offscreen,
        });

        await renderTask.promise;
        if (cancelled) {
          offscreen.width = 0;
          offscreen.height = 0;
          return;
        }

        const displayCtx = displayCanvas.getContext('2d');
        if (displayCtx) {
          displayCanvas.width = offscreen.width;
          displayCanvas.height = offscreen.height;
          displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
          displayCtx.drawImage(offscreen, 0, 0);
        }
        offscreen.width = 0;
        offscreen.height = 0;
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          'name' in err &&
          (err as { name?: string }).name === 'RenderingCancelledException'
        ) {
          return;
        }
      } finally {
        try {
          loadedPage?.cleanup();
        } catch {
          // ignore cleanup errors
        }
      }
    };

    void renderPage();

    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // ignore cancel error
        }
      }
    };
  }, [pdfDocument, pageGeom, zoom, isVisible]);

  const pageRectW = measuredSize.width || cssWidth;
  const pageRectH = measuredSize.height || cssHeight;
  const pxPerPt = pageRectW / Math.max(1, pageGeom.displayedWidthPt);
  const minCssPx = Math.max(24, Math.round(getMinQrPrintPt(pageGeom) * pxPerPt));
  const maxCssPx = Math.max(minCssPx, Math.floor(getMaxQrPrintPt(pageGeom) * pxPerPt));

  const cornerHandles = useMemo(
    () => ({
      topLeft: CORNER_HANDLE_STYLE,
      topRight: CORNER_HANDLE_STYLE,
      bottomLeft: CORNER_HANDLE_STYLE,
      bottomRight: CORNER_HANDLE_STYLE,
    }),
    []
  );

  const commitFromCssBox = (
    id: string,
    xPx: number,
    yPx: number,
    sidePx: number
  ) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const wCss = rect && rect.width > 0 ? rect.width : pageRectW;
    const hCss = rect && rect.height > 0 ? rect.height : pageRectH;

    const clamped = clampSquarePlacement(
      {
        x: xPx / wCss,
        y: yPx / hCss,
        w: sidePx / wCss,
        h: sidePx / hCss,
      },
      pageGeom
    );
    onUpdatePlacement(id, clamped);
  };

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="text-[11px] font-semibold text-slate-500">
        Page {pageGeom.pageIndex + 1}
        {pageGeom.rotation !== 0 ? ` (${pageGeom.rotation}° rotated)` : ''}
      </div>

      <div
        ref={wrapperRef}
        data-page-index={pageGeom.pageIndex}
        style={{ width: `${cssWidth}px`, height: `${cssHeight}px` }}
        className="relative bg-white shadow-md border border-slate-300 select-none overflow-hidden"
      >
        <canvas
          ref={canvasRef}
          style={{ width: `${cssWidth}px`, height: `${cssHeight}px` }}
          className="block w-full h-full pointer-events-none"
        />

        {placements.map((placement) => {
          const boxX = placement.x * pageRectW;
          const boxY = placement.y * pageRectH;
          const boxSide = Math.max(minCssPx, Math.round(placement.w * pageRectW));
          const active = placement.id === selectedPlacementId;

          return (
            <Rnd
              key={`${placement.id}-${Math.round(pageRectW)}`}
              size={{ width: boxSide, height: boxSide }}
              position={{ x: boxX, y: boxY }}
              minWidth={minCssPx}
              minHeight={minCssPx}
              maxWidth={maxCssPx}
              maxHeight={maxCssPx}
              bounds="parent"
              lockAspectRatio={true}
              disableDragging={disabled}
              enableResizing={
                disabled
                  ? false
                  : {
                      topLeft: true,
                      topRight: true,
                      bottomLeft: true,
                      bottomRight: true,
                      top: false,
                      right: false,
                      bottom: false,
                      left: false,
                    }
              }
              resizeHandleStyles={cornerHandles}
              onDragStart={() => onSelectPlacement(placement.id)}
              onDragStop={(_e, data) => {
                commitFromCssBox(placement.id, data.x, data.y, boxSide);
              }}
              onResizeStart={() => onSelectPlacement(placement.id)}
              onResize={(_e, _dir, ref) => {
                if (onLiveSizeChange) {
                  const rect = wrapperRef.current?.getBoundingClientRect();
                  const wCss = rect && rect.width > 0 ? rect.width : pageRectW;
                  onLiveSizeChange(placement.id, ref.offsetWidth, wCss);
                }
              }}
              onResizeStop={(_e, _dir, ref, _delta, position) => {
                const side = Math.min(ref.offsetWidth, ref.offsetHeight);
                commitFromCssBox(placement.id, position.x, position.y, side);
              }}
              style={{ zIndex: active ? 20 : 10, touchAction: 'none' }}
              className={`group ${active ? 'ring-2 ring-[#D9A441]/60' : ''}`}
            >
              {generatedQrDataUrl ? (
                <div className="w-full h-full bg-white border border-slate-200 pointer-events-none">
                  <img
                    src={generatedQrDataUrl}
                    alt="Placed QR Code"
                    className="w-full h-full object-contain block"
                    style={{ imageRendering: 'pixelated' }}
                  />
                </div>
              ) : (
                <DummyQrPlaceholder active={active} />
              )}
            </Rnd>
          );
        })}
      </div>
    </div>
  );
}
