# Fast-browser-link brand

The mark connects a pointer with a distinct agent node. It represents user-directed work in a signed-in browser. The geometry is original; it does not borrow a browser vendor's mark.

Use [brand-logo.svg](../native-extension/brand-logo.svg) at 48px and above and [brand-logo-small.svg](../native-extension/brand-logo-small.svg) at 16–32px. The small version uses a 16-unit grid and removes the thin connector. Keep a quarter of the mark's width clear on every side; minimum display size is 16px. Keep the square tile intact on light and dark toolbars. A [one-color mark](../native-extension/brand-mark.svg) may use the pointer and node paths in one contrasting ink, without the tile. Do not stretch, rotate, add effects or combine the mark with a calling agent's brand.

The only primary brand hue is blue `#315fc7` (dark UI primary control: `#99b6ff`). Green, amber, red and gray mean success, waiting, failure and disconnected. They are not alternate brand colors. The tile remains blue in both themes. [brand.css](../native-extension/brand.css) defines neutral surfaces, foregrounds, state colors, 10px panels, 7px controls and the system font stack. Popup, sidebar, floating button, task overlay and result page consume these tokens. Dark mode follows the browser's system preference; reduced motion disables UI transitions and animation.

Generate icons using Python 3 and the standard library:

```sh
python3 scripts/generate-brand.py
```

The script accepts `--source`, `--small-source` and `--output`. Replace the two SVG sources to select a different design, then regenerate. It supports only explicit solid-fill rectangle and M/L/H/V/Z path geometry, rejects unsupported SVG features, and generates 16/32/48/128px RGBA PNGs with four-sample antialiasing per axis. There is no runtime or development dependency. The shadow-layer module is generated from the same CSS and source SVG; edit the sources rather than the generated module.

Only Fast-browser-link's name and mark belong in UI brand positions. Caller/model identifiers may remain in operational details. See [popup and task controls](popup-controls.md) for connection and security semantics.
