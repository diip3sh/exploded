# Harness: getting the component onto a page the runtime can read

The runtime needs three things:

1. **The real component, rendered.** Use the same markup, CSS and fonts it ships with, not a copy.
2. **Same-origin CSS.** `document.styleSheets[i].cssRules` must be readable. That is how `:hover`/`:focus`/`:active` are forced without a pointer, and how tokens are traced.
3. **Fonts loaded before mounting.** Text width changes when a web font swaps in.

## Next.js (App Router)

Make a docs route, for example `app/(docs)/spec/button/page.tsx`. Keep it a server component and render the client wrapper inside it:

```tsx
import { Exploded } from "@/components/exploded/react/Exploded";
import { Button } from "@/components/ui/button";

export default function Page() {
  return (
    <main className="mx-auto max-w-5xl p-12">
      <Exploded fig={1} title="Button · primary" states="pressable" parts={{ "[data-slot=kbd]": "Shortcut chip" }}>
        <Button>Deploy</Button>
      </Exploded>
    </main>
  );
}
```

- Copy `runtime/` into `components/exploded/`. The wrapper imports `../exploded.css` and `../exploded.js`.
- Tailwind v4 and CSS modules are bundled into same-origin stylesheets in dev and prod, so they work as they are.
- If the CSS comes from a CDN (a font CSS, a hosted design system), its rules can't be read. Self-host them for the docs route.
- Run `next dev`, then `node scripts/audit.mjs http://localhost:3000/spec/button`.

## Storybook

Add one story per figure next to the component's own stories:

```tsx
export const Spec = () => (
  <Exploded fig={1} title="Button · primary" states="pressable"><Button>Deploy</Button></Exploded>
);
Spec.parameters = { layout: "fullscreen" };
```

Storybook's `pseudo-states` addon isn't needed: the runtime forces pseudo-classes itself. Audit the story's iframe URL: `node scripts/audit.mjs "http://localhost:6006/iframe.html?id=button--spec"`.

## Vite, Vue, Svelte or any SPA

Mount from your own code after the component renders:

```js
await document.fonts.ready;
const figure = await Exploded.mount(document.querySelector("#figure"), { target: document.querySelector("#specimen > *"), title: "Select", states: "field", stateTarget: "button" });
```

Put the specimen in a hidden container. The runtime moves it into the figure's Live slot.

## Plain HTML

Copy `examples/gallery/index.html`. Inline the component's CSS in a `<style>` tag, or serve the folder (`python3 -m http.server`) so linked CSS is same-origin. On `file://`, Chrome treats every linked file as a different origin, so inline the CSS there.

## States that aren't pseudo-classes

```js
states: [
  { id: "rest", label: "Closed" },
  { id: "open", label: "Open", attrs: { "data-state": "open", "aria-expanded": "true" } },
  { id: "loading", label: "Loading", apply: (root) => { root.classList.add("is-loading"); return () => root.classList.remove("is-loading"); } },
  { id: "error", label: "Error", attrs: { "aria-invalid": "true" }, on: "input" },
]
```

If hover and press come from the component's own pointer handlers (React state, motion's `animate`, a spring) rather than CSS, use `states: "pointer"`: it fires real pointer and mouse events, and each state is captured once it has settled. Don't set a state's end values by hand.

If a state is driven by a React prop rather than an attribute, render one specimen per state instead. Mount a figure per variant, or expose the state as a `data-*` attribute in the component. Most headless libraries (Radix, Ark, React Aria) already do.

## Fluid components

A card that is `width: 100%` takes the width of the Live slot. Set `specimenWidth` to the width it really renders at in production (for example 360 for a mobile card), or the figure measures a width nobody ships.
