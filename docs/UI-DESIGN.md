# Hich Web interface

The shared visual system follows the visual direction of [Superlógica](https://superlogica.com/), inspected on 8 October 2026: vivid cobalt (`#2233ff` / `#1c2cff`), acid lime (`#d9ff00` / `#c3ff00`), white surfaces, rounded panels, large geometric headings and understated motion.

The reference loads Adobe Paralucent and Argumentum. Hich uses the openly licensed **Plus Jakarta Sans** variable font, self-hosted under `frontend/public/fonts`, with its SIL Open Font License included. The original `hich.png` is used for every shared brand component and the favicon; it is not replaced by a generated mark.

Shared styles cover the website, collections, administrator login, dashboard, clients, agreements, invoices, operations, signing and client approval portals. Features include responsive navigation, keyboard focus rings, focus-contained dialogs, a skip link, reduced-motion support, readable agreement clauses, and print styles that preserve Hich branding and invoice payment instructions.

The public hero contains an original interactive development model built from HTML/CSS: layered 3D software blocks, design swatches and a pointer, a code view, and a launch view. Its Design/Build/Launch controls work with clicks and arrow/Home/End keys. Motion stops when the operating system requests reduced motion. There are no public links into the administrator portal.

## Browser review

`scripts/ui-smoke.cjs` reviews the application against isolated synthetic API fixtures; no connected database is modified. Screenshots in `docs/ui-review` are design review examples, not records of real clients or payments.

Start Vite on port 5174, then run `node scripts/ui-smoke.cjs` with Puppeteer available to Node. `UI_BASE_URL` can select another local port; `UI_REVIEW_FILTER` limits screenshots to matching route names. The script verifies desktop/mobile overflow and logo loading, search shortcut/navigation and dialog focus, signature payload fields, print visibility and browser JavaScript errors.
