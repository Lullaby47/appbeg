import { useEffect, useState } from 'react';

export function useVisualViewportMetrics(enabled: boolean) {
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setKeyboardInset(0);
      setViewportHeight(null);
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }

    const vv = window.visualViewport;
    if (!vv) {
      return;
    }

    const updateViewportMetrics = () => {
      const nextViewportHeight = Math.round(vv.height);
      const nextKeyboardInset = Math.max(
        0,
        Math.round(window.innerHeight - (vv.height + vv.offsetTop))
      );
      setViewportHeight(nextViewportHeight);
      setKeyboardInset(nextKeyboardInset);
    };

    updateViewportMetrics();
    vv.addEventListener('resize', updateViewportMetrics);
    vv.addEventListener('scroll', updateViewportMetrics);
    window.addEventListener('orientationchange', updateViewportMetrics);

    return () => {
      vv.removeEventListener('resize', updateViewportMetrics);
      vv.removeEventListener('scroll', updateViewportMetrics);
      window.removeEventListener('orientationchange', updateViewportMetrics);
    };
  }, [enabled]);

  return {
    keyboardInset,
    viewportHeight,
  };
}
