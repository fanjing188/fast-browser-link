# FBL product connection page — observed design facts

This narrow record is extracted from `native-extension/brand.css`, `popup.html`, and `popup.css`. It is not a user-approved redesign or a specification for other surfaces.

## Colors

Use the shared `brand.css` variables, not a second palette. Light: `--brand: #315fc7`, `--paper: #ffffff`, `--bg: #f4f6f9`, `--ink: #1d2430`, `--ink-2: #4d5868`. Dark: `--brand: #99b6ff`, `--paper: #1b2029`, `--bg: #12161d`, `--ink: #e8ecf3`, `--ink-2: #b0b9c8`. Borders, success, warning, and errors use `--line`, `--ok`, `--warn`, and `--bad`. Follow the system color scheme and existing `data-theme` overrides.

## Typography

The system UI stack is `--ui`; extension IDs use `--mono`. No downloaded fonts. Existing popup text is compact; this standalone settings page uses readable 16px body and inputs, 24px heading, and 18px section headings.

## Layout and components

The existing popup uses left-aligned rows, dividers, brand lockup, and 44px controls. Preserve this vocabulary: one brand-blue primary action, neutral secondary actions, visible keyboard focus, and `--rc` (7px) control corners. The pairing page is a single column with a form followed by a flat registry list, not stacked cards. Mobile order is heading → ID label/help → input → pair action → receipt → registry. Desktop keeps this order with a restrained reading width. Long IDs wrap in the registry.

## Scope

Only `product-connections.html` and its page module/styles are covered. No popup, sidebar, global token, or brand redesign is authorized. Status wording must carry meaning without relying on color. Do not invent a product name as verified identity.
