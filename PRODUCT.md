# FBL explicit product pairing — scoped facts

Sources: repository README, existing extension popup, and the explicit pairing-page task. This is an implementation context record, not user-approved product strategy.

- Fast-browser-link provides controlled browser execution. This page is its local, trusted connection settings surface at `chrome-extension://FBLID/product-connections.html` (replace FBLID with the loaded FBL extension ID).
- The operator copies the already-loaded Fast-Backlink extension’s actual ID from the connection area of its sidebar, manually enters exactly 32 lowercase letters a–p, and submits this form. Display names are not identities. Changed IDs require new pairing.
- The primary action is explicit pairing. Merely opening the page, receiving URL parameters, or reading page text must never initiate pairing. This page does not directly execute browser work.
- Initial status is unknown/reading. Only a valid runtime receipt can establish connected/offline entries. Pairing registration alone is not a connected claim. Failures and unknown outcomes are not automatically retried.
- Each registered ID offers reconnect and unpair. Unpair stops that product’s subsequent control after confirmation, keeps the original page and entered data, and does not promise to cancel already-dispatched work. Failure keeps the displayed registration.
- Use concise Chinese or English according to the browser UI language. Errors come from a fixed code-to-copy map, never arbitrary error bodies. Keep current inputs on every failure.
- Scope: local settings UI and tests only. Controller, background, manifest, build, and product-side integration are owned by the parent task. Mock-message page tests do not establish a live product connection.
