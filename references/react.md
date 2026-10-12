# React and Next.js

`runtime/react/Exploded.tsx` is a `"use client"` component. It:

1. renders your child normally, inside a hidden holder, so React owns it and its props, context and theme apply;
2. waits for `document.fonts.ready`, then calls `Exploded.mount` with the child as `target`, which moves the child's DOM node into the figure's Live slot. Mounting is async: the component settles in the slot first (a component that measures itself with a ResizeObserver re-renders at its real size), then each state is captured once it has settled;
3. on unmount or when options change, calls `destroy()`, which moves the node back into the holder before React touches it. Reconciliation never sees a node in the wrong place.

## Rules

- **Pass one element as the child.** The figure measures `holder.firstElementChild`. Wrap fragments in a `div` only if that wrapper is part of what you're documenting.
- **The figure is a snapshot of the states, captured at mount.** If the child's props change, the Live slot updates (React still owns it) but the sheets don't. Change the `key` on `<Exploded>` to re-capture, or pass different options, which re-mounts.
- **Keep options serialisable where you can.** The wrapper re-mounts when `JSON.stringify` of the options changes. `apply` functions aren't compared, so give such states distinct `id`s.
- **Server components:** render `<Exploded>` from a server page, which is fine because it's a client boundary. The runtime touches `window` only inside `mount`, so importing it on the server is safe.
- **Strict mode** mounts, destroys and mounts again in development. That's expected, and `destroy()` makes it clean.

## Theming

Pass `theme="dark"` on dark docs. To match the host page, override tokens on a wrapper:

```css
.docs .xp { --xp-card: var(--background); --xp-text: var(--foreground); --xp-muted: var(--muted-foreground); --xp-lit: #e5484d; --xp-sans: var(--font-sans); }
```
