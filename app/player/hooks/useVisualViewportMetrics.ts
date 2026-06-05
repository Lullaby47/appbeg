import { useEffect, useRef, useState } from 'react';

export function useVisualViewportMetrics(enabled: boolean) {
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const metricsRef = useRef({ keyboardInset: 0, viewportHeight: null as number | null });

  useEffect(() => {
    if (!enabled) {
      if (metricsRef.current.keyboardInset !== 0) {
        metricsRef.current.keyboardInset = 0;
        setKeyboardInset(0);
      }
      if (metricsRef.current.viewportHeight !== null) {
        metricsRef.current.viewportHeight = null;
        setViewportHeight(null);
      }
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }

    const vv = window.visualViewport;
    if (!vv) {
      return;
    }

    let rafId: number | null = null;

    const measureViewportMetrics = () => {
      rafId = null;
      const nextViewportHeight = Math.round(vv.height);
      const nextKeyboardInset = Math.max(
        0,
        Math.round(window.innerHeight - (vv.height + vv.offsetTop))
      );

      if (metricsRef.current.viewportHeight !== nextViewportHeight) {
        metricsRef.current.viewportHeight = nextViewportHeight;
        setViewportHeight(nextViewportHeight);
      }
      if (metricsRef.current.keyboardInset !== nextKeyboardInset) {
        metricsRef.current.keyboardInset = nextKeyboardInset;
        setKeyboardInset(nextKeyboardInset);
      }
    };

    const updateViewportMetrics = () => {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(measureViewportMetrics);
    };

    updateViewportMetrics();
    vv.addEventListener('resize', updateViewportMetrics, { passive: true });
    vv.addEventListener('scroll', updateViewportMetrics, { passive: true });
    window.addEventListener('orientationchange', updateViewportMetrics, { passive: true });

    return () => {
      vv.removeEventListener('resize', updateViewportMetrics);
      vv.removeEventListener('scroll', updateViewportMetrics);
      window.removeEventListener('orientationchange', updateViewportMetrics);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [enabled]);

  return {
    keyboardInset,
    viewportHeight,
  };
}
