# Chart First frontend evidence

Captured on 2026-07-21 from the fixture-mode Next.js application at `127.0.0.1:3210`.

- `chart-first-desktop.png`: 1440×900 desktop price arena and right-side `Your Plays` rail.
- `chart-first-mobile.png`: 390×844 responsive arena, sticky command deck, and full-width plays rail.

The temporary browser harness verified:

- `$25` updates the amount field;
- `Play Up` adds exactly one fixture play;
- clicking the chart adds no play and cannot submit a transaction;
- the help dialog opens and closes by accessible role/name;
- desktop and mobile have no horizontal document overflow;
- the primary mobile action remains visible;
- the reduced-motion stylesheet exists; and
- no browser console or page errors were emitted.

Harness result:

```json
{
  "initialCards": 3,
  "cardsAfterPlay": 4,
  "cardsAfterChartClick": 4,
  "desktop": { "bodyWidth": 1440, "viewportWidth": 1440 },
  "mobile": { "bodyWidth": 390, "viewportWidth": 390, "playUpVisible": true, "railWidth": 390 },
  "consoleErrors": []
}
```

This is implementation evidence for the first vertical slice, not completion of the pending
five-user comprehension test, full WCAG audit, or visual-regression gate.
