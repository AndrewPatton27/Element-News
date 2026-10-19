import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INCREASE_JUDGED, NUMBERS_LEGEND, changeToneColor, numberTone, toneWords, withToneLabel } from '../numbers/numberTone.ts';
import { light } from '../theme/theme.ts';

test('increase bad: inflation, unemployment, jobless claims, gas', () => {
  for (const id of ['CPIAUCSL', 'UNRATE', 'ICSA', 'GASREGW']) {
    assert.equal(numberTone(id, 'up'), 'bad', id);
    assert.equal(numberTone(id, 'down'), 'good', id);
  }
});

test('increase good: payrolls, retail sales, housing starts, GDP growth', () => {
  for (const id of ['PAYEMS', 'RSAFS', 'HOUST', 'A191RL1Q225SBEA']) {
    assert.equal(numberTone(id, 'up'), 'good', id);
    assert.equal(numberTone(id, 'down'), 'bad', id);
  }
});

test('rates, oil and unknown series are neutral', () => {
  for (const id of ['DGS10', 'DGS2', 'DFF', 'DCOILWTICO', 'SOMETHING_NEW', '__proto__', 'toString']) {
    assert.equal(numberTone(id, 'up'), 'neutral', id);
    assert.equal(numberTone(id, 'down'), 'neutral', id);
  }
});

test('flat, null and missing direction are always gray', () => {
  for (const id of Object.keys(INCREASE_JUDGED)) {
    assert.equal(numberTone(id, 'flat'), 'neutral', id);
    assert.equal(numberTone(id, null), 'neutral', id);
    assert.equal(numberTone(id, undefined), 'neutral', id);
    assert.equal(changeToneColor(light, id, 'flat'), light.flat);
  }
});

test('colours: green good, red bad, gray neutral', () => {
  assert.equal(changeToneColor(light, 'UNRATE', 'down'), light.good);
  assert.equal(changeToneColor(light, 'UNRATE', 'up'), light.bad);
  assert.equal(changeToneColor(light, 'DGS10', 'up'), light.flat);
});

test('accessible text names the tone only when there is one', () => {
  assert.equal(toneWords('good'), 'generally favorable');
  assert.equal(toneWords('bad'), 'generally unfavorable');
  assert.equal(toneWords('neutral'), '');
  assert.match(withToneLabel('Unemployment rate 4.1%, down -0.1 pts.', 'UNRATE', 'down'), /generally favorable/);
  assert.match(withToneLabel('CPI 3.1%, up +0.2.', 'CPIAUCSL', 'up'), /generally unfavorable/);
  assert.equal(withToneLabel('10-yr Treasury 4%, up.', 'DGS10', 'up'), '10-yr Treasury 4%, up.');
  assert.equal(withToneLabel('x', 'UNRATE', 'flat'), 'x');
});

test('legend text is the agreed line', () => {
  assert.equal(NUMBERS_LEGEND, 'Green: generally good for households. Red: generally bad. Gray: no change or neither.');
});

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('green and red meet WCAG AA (4.5:1) on page, white and the data panel', () => {
  for (const bg of [light.bg, light.surface, light.dataPanel]) {
    assert.ok(contrast(light.good, bg) >= 4.5, `good on ${bg}`);
    assert.ok(contrast(light.bad, bg) >= 4.5, `bad on ${bg}`);
    assert.ok(contrast(light.flat, bg) >= 4.5, `flat on ${bg}`);
  }
});
