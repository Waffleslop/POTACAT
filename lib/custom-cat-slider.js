/**
 * Custom CAT sliders in the VFO pop-out (#526): a slider must stay where the
 * operator drags it.
 *
 * Main pushes vfo-radio-state several times a second and every push carries
 * the custom CAT list. The window used to tear down and rebuild every custom
 * control on every push, so a slider was replaced under the operator's finger
 * mid-drag, and the new one started at the saved value or, with none saved,
 * at its minimum. The rules here:
 *   - rebuild only when what a slot IS changed (name, type, command, range,
 *     ...), never because a saved value changed;
 *   - never rebuild while a slider is being dragged; defer it to the release;
 *   - a slider shows the last value moved here, else the saved value, else
 *     its minimum, clamped to its range;
 *   - a saved value that changes (the main window's own slider moved) is
 *     shown in place, without a rebuild, and not during a drag.
 *
 * Dual-mode: Node require() gets module.exports, a <script> gets
 * window.CustomCatSlider. Pure.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CustomCatSlider = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // The key a slot is known by in the window (customSliderTimers uses it too).
  function slotKey(b) {
    return (b && b.name || '') + '|' + (b && b.command || '');
  }

  function range(b) {
    const lo = b && Number.isFinite(b.min) ? b.min : 0;
    const hi = b && Number.isFinite(b.max) ? b.max : 255;
    return { lo, hi };
  }

  // What the slots ARE, without their saved values: the part that needs a
  // rebuild when it changes.
  function definitionSignature(list) {
    const shown = (Array.isArray(list) ? list : []).filter(b => b && b.name && b.command);
    return JSON.stringify(shown.map(b => [
      b.type || 'button', b.name, b.command, b.commandOff || '',
      Number.isFinite(b.min) ? b.min : null, Number.isFinite(b.max) ? b.max : null,
      b.follows || '', b.readCommand || '', b.onWhen || '',
    ]));
  }

  // The value a (re)built slider starts at.
  function startValue(b, lastMoved) {
    const { lo, hi } = range(b);
    let v = Number.isFinite(lastMoved) ? lastMoved : (b && Number.isFinite(b.value) ? b.value : lo);
    if (v < lo) v = lo;
    if (v > hi) v = hi;
    return v;
  }

  // What to do with a pushed list: 'rebuild', 'defer' (a slider is being
  // dragged; rebuild on release) or 'keep' (nothing a slot shows changed).
  function plan(prevSignature, list, dragging) {
    if (definitionSignature(list) === prevSignature) return 'keep';
    return dragging ? 'defer' : 'rebuild';
  }

  // Saved values that moved since the last push: key -> new value. The window
  // shows them in place (not during a drag) and remembers them as last moved.
  function savedValueChanges(list, seen) {
    const out = {};
    for (const b of (Array.isArray(list) ? list : [])) {
      if (!b || b.type !== 'slider' || !b.name || !b.command || !Number.isFinite(b.value)) continue;
      const key = slotKey(b);
      if (seen && Object.prototype.hasOwnProperty.call(seen, key) && seen[key] !== b.value) out[key] = b.value;
    }
    return out;
  }

  function savedValues(list) {
    const out = {};
    for (const b of (Array.isArray(list) ? list : [])) {
      if (b && b.type === 'slider' && b.name && b.command && Number.isFinite(b.value)) out[slotKey(b)] = b.value;
    }
    return out;
  }

  return { slotKey, range, definitionSignature, startValue, plan, savedValueChanges, savedValues };
});
