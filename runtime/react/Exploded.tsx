"use client";
// React / Next.js wrapper for the Exploded runtime.
//
//   import { Exploded } from "@/components/exploded/react/Exploded";
//   <Exploded fig={1} title="Button · primary" states="pressable" parts={{ ".btn-kbd": "Shortcut chip" }}>
//     <Button>Deploy</Button>
//   </Exploded>
//
// The child is rendered by React as usual, measured once fonts are ready, then
// moved into the figure's "Live" slot. On unmount it is moved back before React
// removes it, so reconciliation never sees a missing node.
import * as React from "react";
import "../exploded.css";
import "../exploded.js";

type State = {
  id: string;
  label: string;
  pseudo?: Array<"hover" | "active" | "focus" | "focus-visible" | "focus-within">;
  attrs?: Record<string, string>;
  on?: string;
  apply?: (root: HTMLElement, target: HTMLElement) => void | (() => void);
};

export type ExplodedProps = {
  children: React.ReactElement;
  title: string;
  fig?: number | string;
  states?: "pressable" | "pointer" | "field" | State[];
  stateTarget?: string;
  parts?: Record<string, string>;
  theme?: "light" | "dark";
  splitStroke?: "root" | "all" | "none";
  specimenWidth?: number;
  settle?: number;
  azimuth?: number;
  tilt?: number;
  className?: string;
};

type Api = { destroy: () => void };
declare global {
  interface Window { Exploded: { mount: (host: HTMLElement, opts: Record<string, unknown>) => Promise<Api> } }
}

export function Exploded({ children, className, ...opts }: ExplodedProps) {
  const host = React.useRef<HTMLDivElement>(null);
  const holder = React.useRef<HTMLDivElement>(null);
  const key = JSON.stringify({ ...opts, states: typeof opts.states === "string" ? opts.states : opts.states?.map((s) => s.id) });

  React.useEffect(() => {
    let api: Api | null = null;
    let cancelled = false;
    const ready = (document as Document & { fonts?: FontFaceSet }).fonts?.ready ?? Promise.resolve();
    ready.then(() => {
      if (cancelled || !host.current || !holder.current) return;
      const target = holder.current.firstElementChild as HTMLElement | null;
      if (!target) return;
      // Capture is async (each state settles first): if we unmounted meanwhile, undo it.
      window.Exploded.mount(host.current, { ...opts, target }).then((a) => { if (cancelled) a.destroy(); else api = a; });
    });
    return () => { cancelled = true; api?.destroy(); };
    // Re-mount only when the options really change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <>
      <div ref={host} className={className} />
      <div ref={holder} hidden>{children}</div>
    </>
  );
}
