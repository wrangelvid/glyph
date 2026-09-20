---
type: How-to guide
title: Measure and inspect text without a renderer
description: Builds the smallest GlyphConfig that shapes and lays out text for a host that keeps its own renderer or only needs metrics.
tags: [headless, glyph-config, measure, inspect, layout, node]
sources:
  - id: glyph-config-contract
    resource: ../../../packages/glyph/src/config/glyph.ts
    title: Public GlyphConfig, root, and text-controller contracts
  - id: codec-contract
    resource: ../../../packages/glyph/src/config/codec.ts
    title: Codec descriptor validation
  - id: layout-summary
    resource: ../../../packages/glyph/src/layout.ts
    title: ParagraphLayoutSummary and GlyphLayoutInspection
  - id: text-properties
    resource: ../../../packages/glyph/src/text-properties.ts
    title: Constraints, ParagraphLayout, and TextStyle
  - id: headless-config-test
    resource: ../../../packages/glyph/tests/integration/headless-config.test.mjs
    title: Executable copy of this guide's config
  - id: renderer-guide
    resource: renderer-integration.md
    title: Full renderer integration guide
generated:
  by: anthropic/claude-fable-5-1
  at: '2026-09-20T00:00:00Z'
---

# Measure and inspect text without a renderer

A `GlyphConfig` does not have to draw anything. A layout engine that keeps its own renderer, a server that measures
labels, or a test that checks line breaks only needs shaping and layout. This guide builds that config: every renderer
hook is inert, the root exposes `fonts` and `services`, and the host reads `measure()` and `inspect()` from a text
controller without ever calling `glyph.shape()`.

The config below is copied verbatim into
[`packages/glyph/tests/integration/headless-config.test.mjs`](../../../packages/glyph/tests/integration/headless-config.test.mjs),
which fails when the two drift.

## Paste the minimal config

```js
import { msdf } from '@pmndrs/glyph';
import {
  createRasterCodecProgram,
  defineCodecBuffers,
  defineGlyphConfig,
  defineGlyphSchema,
  id,
  msdfCodec,
  resourceLease,
} from '@pmndrs/glyph/core';

const INERT = Object.freeze({});

const schema = defineGlyphSchema({
  program: () => INERT,
  buffer: () => INERT,
  material: () => INERT,
  transform: () => INERT,
  batch: () => INERT,
  instance: () => INERT,
  instanceSpan: () => INERT,
});

const capabilitySet = Object.freeze({
  capabilities: Object.freeze(['alias-vec2', 'alias-vec4', 'ordered-direct']),
  maxBufferBytes: 16 * 1024 * 1024,
  updateAlignment: 4,
  coalesceGapBytes: 128,
  rangeCallPenaltyBytes: 256,
  maxBuffersPerDraw: 8,
  maxResourcesPerDraw: 4,
  maxIndirectDraws: 0,
  fragmentationBudget: 8,
  wholeBufferThresholdBasisPoints: 7_500,
});

const system = defineCodecBuffers({
  stableGlyphId: { id: id.buffer('headless/stable-glyph'), scalar: 'u32', lanes: ['stableGlyphId'] },
  placementSlot: { id: id.buffer('headless/placement-slot'), scalar: 'u32', lanes: ['placementSlot'] },
});

export const headlessConfig = defineGlyphConfig({
  schema,
  fonts: { default: 'msdf', formats: { msdf } },
  encode: ({ ids }) => ({
    descriptor: {
      capabilitySets: [capabilitySet],
      programs: [
        createRasterCodecProgram(msdfCodec, {
          namespace: 'headless',
          system,
          capabilitySet,
          transformMode: 'direct',
          ids,
        }),
      ],
    },
  }),
  resolve: () => resourceLease(INERT, () => undefined),
  renderer: () => ({
    decode: () => ({ result: undefined, commit: () => undefined, discard: () => undefined }),
    syncTransforms: () => undefined,
    dispose: () => undefined,
  }),
  root: {
    create: (context) => {
      if (context.fonts === undefined) throw new TypeError('the headless config declares font formats');
      return context.create({ fonts: context.fonts, services: context.services }, { boundary: undefined });
    },
  },
});
```

What each field does here:

| Field      | Headless value                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `schema`   | Every callback returns the same frozen object. Nothing reads the bindings because nothing decodes a command buffer.     |
| `fonts`    | Declares the raster format the handle binds. Shaping needs the font's shaping tables, which every baked format carries. |
| `encode`   | Must return a real Codec program. `programs: []` throws `RangeError: codec declares no programs` at `glyph.handle()`.   |
| `resolve`  | Returns an inert lease. It runs only during publication, which a headless host never triggers.                          |
| `renderer` | `decode()` returns an empty transaction; `syncTransforms()` and `dispose()` do nothing.                                 |
| `root`     | Exposes `context.fonts` and `context.services` so the host can acquire fonts and create text controllers.               |

The Codec program is the one non-trivial part. Shaping and layout run inside the same engine call that packs command
buffers, so the engine needs a program even when the output is discarded. `createRasterCodecProgram(msdfCodec, ...)`
with the `msdf` format is the smallest one that exists; `system` must declare both the `stableGlyphId` and the
`placementSlot` lanes, and the capability set must include `ordered-direct` so `transformMode: 'direct'` is accepted.

In TypeScript, type the root as `GlyphRoot & { fonts: GlyphHandleFonts; services: GlyphRootServices<...> }` and the
config as `GlyphConfigFor<typeof schema, HeadlessRoot, undefined, Codec, { msdf: typeof msdf }>`. All of those names
come from `@pmndrs/glyph`.

## Bootstrap in Node

```js
import { readFile } from 'node:fs/promises';
import { glyph, msdf } from '@pmndrs/glyph';
import { headlessConfig } from './headless-config.mjs';

await glyph.init();
const handle = glyph.handle('headless', headlessConfig);

const face = glyph.fontFace(new URL('./Inter.font.glb', import.meta.url), { family: 'Inter', format: msdf });
await face.load();
const font = handle.fonts.acquire(face.msdf);
```

`glyph.init()` reads `text-shaper.wasm` next to the installed module through `node:fs` and fetches it in a browser.
When a bundler or test harness has moved the file, pass the bytes instead: `glyph.init({ wasm: await readFile(url) })`.
`init()` is idempotent and must settle before `glyph.handle()`.

`glyph.handle(name, config)` needs a unique nonempty name; a second `glyph.handle('headless', ...)` throws while the
first handle is alive. Calling the handle with a name, `handle('labels')`, returns an idempotent named root with the
same `fonts` and `services` members; the handle itself fronts the anonymous root.

`glyph.fontFace(source, { family, format: msdf })` accepts a URL, a path string, or a `Blob` of a baked `.font.glb`.
`await face.load()` loads the declared format, and `handle.fonts.acquire(face.msdf)` returns the immutable `Font`
lease that a text state names. The lease is independent of the FontFace: dispose it when the last text using it is
gone.

## Measure and inspect

```js
const state = {
  font,
  text: 'The quick brown fox jumps over the lazy dog',
  transform: {},
  style: { fontSize: 16, lineHeight: 1.5 },
  layout: { wrap: 'word', align: 'start', overflow: 'visible' },
  constraints: { width: { mode: 'exact', size: 120 }, height: { mode: 'unconstrained' } },
};

const text = handle.services.createText(state);

const summary = text.measure();
summary.width; // 120, the resolved box width.
summary.height; // contentHeight, since the block axis is unconstrained.
summary.lineCount; // 4 at this width.
summary.lines[0].ascent; // per-line baseline metrics.
summary.firstBaseline; // distance from the box top to the first baseline.

const layout = text.inspect();
layout.glyphCount; // one entry per positioned glyph, spaces included.
layout.x[0]; // paragraph-local origin of the first glyph, +X right, +Y down.
layout.glyphAdvances[0]; // pen advance, the basis for carets and selections.
layout.glyphInkX[0]; // ink box, the basis for hit testing and bounds.

text.update({ ...state, text: 'Short' });
text.measure().lineCount; // 1.

text.dispose();
```

`createText(state)` returns a `GlyphTextController`. `measure()` returns a `ParagraphLayoutSummary`: the box size,
content extents, per-paragraph and per-line baseline metrics, and the intrinsic `minContentWidth` and
`maxContentWidth`. `inspect()` returns a `GlyphLayoutInspection`, which extends the summary with typed-array columns
for every glyph and every line. Both calls are synchronous, run shaping and layout on demand, and never require
`glyph.shape()`.

`transform` is required by the state contract, but the inert schema never reads it. Pass any object. `material` and
`style.color` are optional and also unread.

`update(state)` takes a complete desired state, not a patch. Keep the last state in the host and spread it. Repeated
`measure()` calls on unchanged state are cached inside the controller.

## Constrain the box and align vertically

Send `height: { mode: 'unconstrained' }` for measurement. A bounded height (`exact` or `at-most`) drops the lines that do
not fit, even with `overflow: 'visible'`; the summary reports `overflowed: true` and fewer lines. Vertical alignment
inside a taller box is host work: offset the paragraph by `boxHeight - summary.height` for bottom alignment or half of
that for centre alignment.

`style.lineHeight` is a multiplier of `style.fontSize`. `fontSize: 16` with `lineHeight: 1.5` lays out 24-unit lines.
A host that stores an absolute line height divides it by the font size before sending it.

Width modes:

- `{ mode: 'exact', size }` resolves `summary.width` to `size` and wraps at it.
- `{ mode: 'at-most', size }` wraps at `size` and shrinks `summary.width` to the widest line.
- `{ mode: 'unconstrained' }` never soft-wraps; `summary.width` is the widest line.

`minContentWidth` and `maxContentWidth` describe the intrinsic inline extents of the content: `maxContentWidth` is the
widest run between forced breaks and `minContentWidth` the widest run after every soft break too. Every measure reports
the same pair whatever the box, so a layout engine can read both from one unconstrained measure before it picks the
box.

## Manage the lifecycle

A measure-only host follows this order:

1. `await glyph.init()` once per process.
2. `glyph.handle(name, headlessConfig)` once per configuration.
3. `glyph.fontFace(...).load()` and `handle.fonts.acquire(...)` once per font.
4. `handle.services.createText(state)` once per paragraph; `update(state)` when its content, style, or constraints
   change; `measure()` and `inspect()` whenever the host needs numbers.
5. `text.dispose()` when the paragraph goes away, then `font.dispose()` when its last paragraph is gone, then
   `handle.dispose()` at shutdown.

Nothing in that list calls `glyph.shape()`. Controllers can be created, measured, disposed, and replaced in any order
without a publication; the integration test creates two paragraphs, disposes one, inspects and re-measures the other,
and creates a third.

`glyph.shape()` exists to publish retained state to the renderer. A host that also renders, through its own decoder
attached to `renderer` as in the [uikit integration plan](../planning/uikit-integration.md), does call it, and today
two ordering rules apply. Both fail with a `GlyphEngineStatusError` whose `statusCode` is `'invalid-request'`
(status 6), and the next `glyph.shape()` succeeds again:

- Disposing a controller that was measured but never published, and then calling `glyph.shape()`, fails that
  `shape()`. A controller that was never measured can be disposed freely.
- After a publication, disposing a controller and then running an engine-backed query on a published sibling before
  the next `shape()` fails that query: `inspect()`, or `measure()` after an `update()`. A cached `measure()` and a
  sibling created after the disposal are unaffected.

A publishing host therefore retires controllers right after a publication: call `glyph.shape()`, dispose the retired
controllers, and call `glyph.shape()` again so the removal is published before the next query.

## When you need a renderer

The moment the host wants Glyph to produce draw data, the inert hooks become real: `schema` returns host bindings,
`resolve` realizes atlases and geometry, and `renderer.decode()` stages buffers from the `CommandBufferView`.
[Integrate a renderer with Glyph](renderer-integration.md) walks through that path with the TypeGPU example; the
config there has the same shape as this one with those three fields filled in.
