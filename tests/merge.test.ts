import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeVerdicts, postEventFor } from '../src/merge.js';

test('any REQUEST_CHANGES wins', () => {
  assert.equal(mergeVerdicts(['APPROVE', 'COMMENT', 'REQUEST_CHANGES']), 'REQUEST_CHANGES');
});

test('COMMENT beats APPROVE', () => {
  assert.equal(mergeVerdicts(['APPROVE', 'COMMENT', 'APPROVE']), 'COMMENT');
});

test('all APPROVE stays APPROVE', () => {
  assert.equal(mergeVerdicts(['APPROVE', 'APPROVE']), 'APPROVE');
});

test('postEventFor downgrades APPROVE/REQUEST_CHANGES on own PR to COMMENT', () => {
  assert.equal(postEventFor('APPROVE', true), 'COMMENT');
  assert.equal(postEventFor('REQUEST_CHANGES', true), 'COMMENT');
  assert.equal(postEventFor('COMMENT', true), 'COMMENT');
});

test('postEventFor leaves verdicts untouched on other-authored PRs', () => {
  assert.equal(postEventFor('APPROVE', false), 'APPROVE');
  assert.equal(postEventFor('REQUEST_CHANGES', false), 'REQUEST_CHANGES');
});
