/**
 * jsdom has no layout engine, so Recharts' ResponsiveContainer has nothing to
 * measure. This stub reports a fixed size, which is enough to render the
 * shared-cursor contract the component tests assert on.
 */
class FixedSizeResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    this.callback(
      [
        {
          target,
          contentRect: { x: 0, y: 0, width: 900, height: 300, top: 0, left: 0, right: 900, bottom: 300 } as DOMRectReadOnly,
          borderBoxSize: [{ blockSize: 300, inlineSize: 900 }],
          contentBoxSize: [{ blockSize: 300, inlineSize: 900 }],
        } as unknown as ResizeObserverEntry,
      ],
      this,
    );
  }

  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
}

globalThis.ResizeObserver = FixedSizeResizeObserver;
