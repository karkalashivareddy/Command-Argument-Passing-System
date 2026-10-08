/**
 * The ambient field behind every page.
 *
 * WHY THIS IS A COMPONENT AT ALL
 * ------------------------------
 * It renders exactly one fixed div, and all of its appearance lives in
 * `styles/field.css`. The component exists so that the field is mounted ONCE, at
 * the shell level, rather than per page: a per-page field would remount on every
 * navigation and flash, and there would be twenty copies of the same layer
 * competing for compositing.
 *
 * WHY IT HAS NO ANIMATION
 * -----------------------
 * A drifting or pulsing background was considered and rejected on evidence rather
 * than taste. This product's central claim is that a pixel means something: a
 * colour encodes provenance, a size encodes a metric, a position encodes time. A
 * decorative layer that moves independently of every one of those spends the
 * reader's attention budget on something that means nothing, which is precisely
 * the trust the rest of the interface is asking for. The field is therefore
 * completely static, and it is also `aria-hidden` because it carries no
 * information a screen reader should announce.
 *
 * It is `pointer-events: none` so it never intercepts a click: an invisible layer
 * that eats pointer events is the classic cause of "the button does nothing".
 */
export function AmbientField() {
  return <div className="caps-field" aria-hidden="true" />;
}
