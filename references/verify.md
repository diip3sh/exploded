# Verify

Run the audit, then look at every picture. The audit proves the layers are honest. Your eyes check that the figure reads.

```
node scripts/audit.mjs <page.html | url> --out shots [--theme dark] [--width 390]
```

It must print `passed`. For each figure it prints the stack in every state, and saves `fig-N-apart.png`, `fig-N-together.png` and, for every state, the pixel pair `fig-N-pixels-<state>-live.png` / `-layers.png`. It runs on Chrome, Chromium, Edge, Brave or Aside (`CHROME_PATH` for anything else).

## What the audit proves

- **Conservation.** Every paint of every element in every state (fill, inset, stroke, outer shadow, ring, outline, text, icon) is claimed by exactly one layer. Nothing is lost and nothing is painted twice.
- **Fidelity.** In every state, on every layer, every element of the clone lays out within 0.5 px of the live component (offsets and sizes, measured at zoom 1).
- **Pixels.** In every state, the live component and its sheets stacked flat at zoom 1 are shot on the same backdrop and compared. A state fails when more than 0.5% and more than 200 device pixels differ. This is the check that catches paint the bookkeeping can't see: a canvas that cloned blank, a placeholder that lost its colour, a layer that went missing.
- **A clean page.** No exceptions and no `console.error`.

`⚠` lines are differences the sheets can't avoid, reported instead of failed: a state that **never settled** (it animates on its own, so the figure holds one moment of it) and a **3D** component (`preserve-3d`), whose sheets can't be restacked by depth. Tell the user about each one.

## Checklist for the PNGs

Read each one, apart and together.

1. **Together reads as the component.** The together shot should look exactly like the live specimen in iso. If a colour, shadow or text is missing, a paint was classified wrongly. Check `model()` for that state.
2. **Every state changes something.** In `model()`, every state's summaries must differ from rest somewhere. Hover with the same fill as rest usually means the `:hover` rule lives in a cross-origin sheet or behind a selector the forcing didn't reach.
3. **The focus ring sheet is dashed at rest and filled at focus.** If it's filled at rest, a ring shadow is always on. That's a component bug worth reporting.
4. **Light paint is legible.** White text and translucent chips sit on a backing in their surface's colour. If any sheet looks empty but isn't dashed, its paint is invisible on the sheet: check its colours.
5. **Names are human.** No "span", "div" or class soup in the margin. Add `parts` or `data-xp-name`.
6. **Labels are readable** at 1× and don't overlap glyphs. If a dense layer drops labels you need, split the figure.
7. **Readout in T mode shows tokens,** not raw values, wherever the CSS uses variables. Raw values in T mode mean the rule is cross-origin or the value is hard-coded. Both are worth telling the user.
8. **Phone.** Run with `--width 390` and check that the card still reads and the margin wraps underneath.
9. **Dark.** If the host page is dark, run with `--theme dark` and `theme: "dark"`.

## Faults seen while building it

- **A ring captured as transparent.** States were measured mid-transition. The runtime disables transitions while capturing (`[data-xp-capturing]`). If you see `rgba(0, 0, 0, 0) 0px 0px 0px 0px` in a state, something re-enabled them with `!important`.
- **Off by 1 px in the audit.** That was the zoom: the clone was measured while scaled. The audit measures at zoom 1. If you measure layout yourself, do the same.
- **White text vanished on white glass.** That's what backings are for. A backing is the surface under the paint, in its own shape, never a recolour of the paint.
- **A placeholder turned dark.** Freezing `-webkit-text-fill-color` inline overrode `::placeholder { color }`. It's frozen as `currentcolor` now. Only the pixel check saw it.
- **A gradient avatar backing turned black.** A transparent `background-color` under a gradient was read as black. Backings copy both the colour and the image of the surface.
