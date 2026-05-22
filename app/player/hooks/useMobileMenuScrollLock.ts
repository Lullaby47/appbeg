import { useEffect, type RefObject } from 'react';

export function useMobileMenuScrollLock(
  pageScrollRef: RefObject<HTMLElement | null>,
  mobileMenuOpen: boolean
) {
  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const pageNode = pageScrollRef.current;
    const bodyStyle = document.body.style;
    const docStyle = document.documentElement.style;
    const previousBodyOverflow = bodyStyle.overflow;
    const previousDocOverflow = docStyle.overflow;
    const previousPageOverflowY = pageNode?.style.overflowY ?? '';
    const previousPageTouchAction = pageNode?.style.touchAction ?? '';

    if (mobileMenuOpen) {
      bodyStyle.overflow = 'hidden';
      docStyle.overflow = 'hidden';
      if (pageNode) {
        pageNode.style.overflowY = 'hidden';
        pageNode.style.touchAction = 'none';
      }
    }

    return () => {
      bodyStyle.overflow = previousBodyOverflow;
      docStyle.overflow = previousDocOverflow;
      if (pageNode) {
        pageNode.style.overflowY = previousPageOverflowY;
        pageNode.style.touchAction = previousPageTouchAction;
      }
    };
  }, [mobileMenuOpen, pageScrollRef]);
}
