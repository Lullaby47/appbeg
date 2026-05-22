# Player page deeper split

This split keeps runtime behavior in `page.tsx` but moves isolated UI/side-effect systems into named files.

## Files

- `types.ts` — player page local TypeScript types.
- `constants.ts` — static config, nav lists, storage keys, splash class strings.
- `utils.ts` — pure helpers for formatting, timestamps, normalization, request status classes, alert parsing.
- `components/FloatingCasinoBackdrop.tsx` — visual-only casino backdrop component.
- `hooks/usePlayerHelpHint.ts` — player idle/help hint timer behavior.
- `hooks/usePlayerMusic.ts` — background casino music and notification sound behavior.
- `hooks/useMobileMenuScrollLock.ts` — body/page scroll locking when the mobile menu is open.
- `hooks/useVisualViewportMetrics.ts` — keyboard/visualViewport measurements for the active table splash.
- `page.tsx` — main page state, Firestore listeners, request handlers, and JSX.

## Why this is the next safe split

These hooks/components own isolated behavior and do not change app data flow:
- no Firestore listener moved
- no request/redeem/recharge/cashout handler moved
- no JSX view panel moved
- no Firebase auth flow moved

That makes this safer than splitting `PlayView`, `AgentsView`, or `UsernamesView` immediately.

## Next split after this works

After this compiles and works, the next best cut is:
1. `components/PlayerMusicToggle.tsx`
2. `components/PlayerBottomNav.tsx`
3. `components/PlayerRequestHistory.tsx`
4. then `views/PlayView.tsx`

Do not move all JSX views at once.
