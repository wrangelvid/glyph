import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { glyph } from '@pmndrs/glyph';

// headless-config:start
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
// headless-config:end

const guideUrl = new URL('../../../../.agents/docs/guides/headless-integration.md', import.meta.url);
const wasmUrl = new URL('../../dist/text-shaper.wasm', import.meta.url);
const fontUrl = new URL('../../../../apps/r3f-hello-world/assets/inter-latin.font.glb', import.meta.url);

const FONT_SIZE = 16;
const LINE_HEIGHT = 1.5;
const BOX_WIDTH = 120;

let handle;
let font;

before(async () => {
  await glyph.init({ wasm: await readFile(wasmUrl) });
  handle = glyph.handle('headless', headlessConfig);
  const face = glyph.fontFace(new Blob([await readFile(fontUrl)], { type: 'model/gltf-binary' }), {
    family: 'Inter',
    format: msdf,
  });
  await face.load();
  font = handle.fonts.acquire(face.msdf);
});

after(() => {
  font?.dispose();
  handle?.dispose();
});

function paragraphState(overrides = {}) {
  return {
    font,
    text: 'The quick brown fox jumps over the lazy dog',
    transform: {},
    style: { fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT },
    layout: { wrap: 'word', align: 'start', overflow: 'visible' },
    constraints: { width: { mode: 'exact', size: BOX_WIDTH }, height: { mode: 'unconstrained' } },
    ...overrides,
  };
}

function guideCodeBlock(markdown, heading) {
  const section = markdown.slice(markdown.indexOf(heading));
  const start = section.indexOf('```js\n') + '```js\n'.length;
  return section.slice(start, section.indexOf('```\n', start));
}

test('the config in this test is the code block in the headless guide', async () => {
  const guide = await readFile(guideUrl, 'utf8');
  const ownSource = await readFile(new URL(import.meta.url), 'utf8');
  const start = ownSource.indexOf('// headless-config:start\n') + '// headless-config:start\n'.length;
  const ownBlock = ownSource.slice(start, ownSource.indexOf('// headless-config:end\n'));
  assert.equal(ownBlock, guideCodeBlock(guide, '## Paste the minimal config'));
});

test('the handle and its named roots expose fonts and services', () => {
  assert.equal(typeof handle.services.createText, 'function');
  assert.equal(typeof handle.fonts.acquire, 'function');
  const labels = handle('labels');
  assert.equal(labels, handle('labels'));
  assert.equal(labels.services.createText.length, handle.services.createText.length);
  labels.dispose();
});

test('measure and inspect return the paragraph layout without glyph.shape()', () => {
  const state = paragraphState();
  const text = handle.services.createText(state);
  try {
    const summary = text.measure();
    assert.equal(summary.width, BOX_WIDTH);
    assert.ok(summary.lineCount > 1, `a ${BOX_WIDTH}-unit box wraps the sentence`);
    assert.equal(summary.lines.length, summary.lineCount);
    assert.equal(summary.lines[0].lineHeight, FONT_SIZE * LINE_HEIGHT, 'lineHeight multiplies fontSize');
    assert.equal(summary.height, summary.contentHeight, 'an unconstrained block axis fits every line');
    assert.equal(summary.height, summary.lineCount * FONT_SIZE * LINE_HEIGHT);
    assert.ok(summary.firstBaseline > 0 && summary.firstBaseline < summary.lines[0].lineHeight);
    assert.ok(summary.lastBaseline > summary.firstBaseline);
    assert.ok(summary.contentWidth > 0 && summary.contentWidth <= BOX_WIDTH);
    assert.ok(summary.minContentWidth > 0 && summary.minContentWidth <= summary.maxContentWidth);
    assert.equal(summary.overflowed, false);

    const layout = text.inspect();
    assert.equal(layout.glyphCount, state.text.length, 'one glyph per character, spaces included');
    assert.equal(layout.x.length, layout.glyphCount);
    assert.equal(layout.glyphAdvances.length, layout.glyphCount);
    assert.equal(layout.glyphInkX.length, layout.glyphCount);
    assert.equal(layout.lineGlyphStarts.length, summary.lineCount);
    assert.equal(layout.x[0], 0, 'the first glyph starts at the inline origin');
    assert.ok(layout.glyphAdvances[0] > 0);
    assert.equal(layout.lineCount, summary.lineCount);
    assert.equal(layout.width, summary.width);

    text.update({ ...state, text: 'Short' });
    const updated = text.measure();
    assert.equal(updated.lineCount, 1);
    assert.equal(updated.height, FONT_SIZE * LINE_HEIGHT);
    assert.equal(text.inspect().glyphCount, 'Short'.length);
  } finally {
    text.dispose();
  }
  assert.equal(text.disposed, true);
});

test('a bounded height culls lines even with overflow visible', () => {
  const state = paragraphState();
  const unconstrained = handle.services.createText(state);
  const bounded = handle.services.createText({
    ...state,
    constraints: { width: { mode: 'exact', size: BOX_WIDTH }, height: { mode: 'exact', size: 2 * FONT_SIZE } },
  });
  try {
    const full = unconstrained.measure();
    const clipped = bounded.measure();
    assert.ok(full.lineCount > 1);
    assert.ok(clipped.lineCount < full.lineCount, 'lines past the box are dropped');
    assert.equal(clipped.overflowed, true);
    assert.equal(clipped.height, 2 * FONT_SIZE);
  } finally {
    bounded.dispose();
    unconstrained.dispose();
  }
});

test('width modes resolve the box and report intrinsic widths', () => {
  const state = paragraphState();
  const exact = handle.services.createText(state);
  const atMost = handle.services.createText({
    ...state,
    constraints: { width: { mode: 'at-most', size: BOX_WIDTH }, height: { mode: 'unconstrained' } },
  });
  const unconstrained = handle.services.createText({
    ...state,
    constraints: { width: { mode: 'unconstrained' }, height: { mode: 'unconstrained' } },
  });
  try {
    const exactSummary = exact.measure();
    const atMostSummary = atMost.measure();
    const freeSummary = unconstrained.measure();
    assert.equal(exactSummary.width, BOX_WIDTH);
    assert.equal(atMostSummary.lineCount, exactSummary.lineCount);
    assert.ok(atMostSummary.width <= BOX_WIDTH && atMostSummary.width >= atMostSummary.contentWidth);
    assert.equal(freeSummary.lineCount, 1, 'an unconstrained width never soft-wraps');
    assert.ok(freeSummary.width >= freeSummary.contentWidth);
    assert.equal(freeSummary.maxContentWidth, exactSummary.maxContentWidth);
    assert.equal(freeSummary.minContentWidth, exactSummary.minContentWidth);
    assert.ok(freeSummary.minContentWidth < freeSummary.maxContentWidth);
  } finally {
    unconstrained.dispose();
    atMost.dispose();
    exact.dispose();
  }
});

test('a measure-only host creates, disposes, and replaces controllers without a publication', () => {
  const first = handle.services.createText(paragraphState({ text: 'first' }));
  const second = handle.services.createText(paragraphState({ text: 'second paragraph' }));
  const firstWidth = first.measure().contentWidth;
  const secondWidth = second.measure().contentWidth;
  assert.ok(firstWidth > 0 && secondWidth > firstWidth);

  first.dispose();
  assert.equal(second.inspect().glyphCount, 'second paragraph'.length, 'a sibling still inspects after a disposal');
  second.update(paragraphState({ text: 'second' }));
  assert.ok(second.measure().contentWidth < secondWidth, 'a dirty sibling still measures after a disposal');

  const third = handle.services.createText(paragraphState({ text: 'third' }));
  assert.ok(third.measure().contentWidth > 0);
  assert.equal(third.inspect().glyphCount, 'third'.length);
  third.dispose();
  second.dispose();
});

test('an empty program list is rejected when the handle is created', () => {
  assert.throws(
    () =>
      glyph.handle('headless:empty', {
        ...headlessConfig,
        encode: () => ({ descriptor: { capabilitySets: [capabilitySet], programs: [] } }),
      }),
    { name: 'RangeError', message: 'codec declares no programs' },
  );
  assert.throws(() => glyph.handle('headless', headlessConfig), { message: /already exists/ });
});
