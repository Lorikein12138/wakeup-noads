import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { applyPatchSpec } from '../scripts/patch.mjs';

const cache = path.resolve('tools/_cache/slim-v1-review/fixtures');

async function fixture(t, files, operations) {
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(path.join(cache, 'patch-engine-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  }
  const specPath = path.join(root, 'fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  return { root, specPath };
}

function operation(overrides = {}) {
  return {
    id: 'T-fixture', evidence: 'E01', relativePath: 'smali/X.smali',
    method: { classDescriptor: 'Ltest/X;', methodDescriptor: 'public value()Ljava/lang/String;' },
    expectedOriginal: 'const-string v0, "old"', replacement: 'const-string v0, "new"', expectedHits: 1,
    finalAssertions: [{ text: 'const-string v0, "new"' }, { text: 'const-string v0, "old"', present: false }],
    ...overrides,
  };
}

const smali = (body = '    const-string v0, "old"\n') => `.class public Ltest/X;\n.super Ljava/lang/Object;\n.method public value()Ljava/lang/String;\n${body}    return-object v0\n.end method\n`;

test('applies one minimal method patch and rejects a repeat', async (t) => {
  const f = await fixture(t, { 'smali/X.smali': smali() }, [operation()]);
  const result = await applyPatchSpec({ root: f.root, specPath: f.specPath });
  assert.equal(result.operations[0].count, 1);
  assert.match(await readFile(path.join(f.root, 'smali/X.smali'), 'utf8'), /"new"/);
  await assert.rejects(applyPatchSpec({ root: f.root, specPath: f.specPath }), /already been applied|expected 1 original/);
});

test('supports exact fragment deletion without broadening the match', async (t) => {
  const remove = operation({
    id: 'T-fixture-delete',
    expectedOriginal: '    const-string v0, "old"\n',
    replacement: '',
    finalAssertions: [{ text: 'const-string v0, "old"', present: false }],
  });
  const f = await fixture(t, { 'smali/X.smali': smali() }, [remove]);
  const result = await applyPatchSpec({ root: f.root, specPath: f.specPath });
  assert.equal(result.operations[0].count, 1);
  assert.doesNotMatch(await readFile(path.join(f.root, 'smali/X.smali'), 'utf8'), /const-string v0, "old"/);
});

test('validates all operations before writing any file', async (t) => {
  const f = await fixture(t, { 'smali/X.smali': smali() }, [operation(), operation({ id: 'T-invalid', expectedOriginal: 'missing', replacement: 'different' })]);
  await assert.rejects(applyPatchSpec({ root: f.root, specPath: f.specPath }), /expected 1 original/);
  assert.equal(await readFile(path.join(f.root, 'smali/X.smali'), 'utf8'), smali());
});

test('rejects too few or too many exact matches', async (t) => {
  for (const content of [smali('    return-object v0\n'), smali('    const-string v0, "old"\n    const-string v0, "old"\n')]) {
    const f = await fixture(t, { 'smali/X.smali': content }, [operation()]);
    await assert.rejects(applyPatchSpec({ root: f.root, specPath: f.specPath }), /expected 1 original/);
  }
});

test('rejects a different class, method, and changed upstream fragment', async (t) => {
  const badClass = await fixture(t, { 'smali/X.smali': smali().replace('Ltest/X;', 'Lwrong/X;') }, [operation()]);
  await assert.rejects(applyPatchSpec({ root: badClass.root, specPath: badClass.specPath }), /class descriptor mismatch/);
  const badMethod = await fixture(t, { 'smali/X.smali': smali().replace('value()', 'other()') }, [operation()]);
  await assert.rejects(applyPatchSpec({ root: badMethod.root, specPath: badMethod.specPath }), /method descriptor not found/);
  const upstream = await fixture(t, { 'smali/X.smali': smali().replace('"old"', '"upstream"') }, [operation()]);
  await assert.rejects(applyPatchSpec({ root: upstream.root, specPath: upstream.specPath }), /expected 1 original/);
});

test('rejects traversal, absolute paths, and symlinks outside root', async (t) => {
  for (const unsafe of ['../outside.smali', 'C:\\outside.smali', '/outside.smali']) {
    const f = await fixture(t, { 'smali/X.smali': smali() }, [operation({ relativePath: unsafe })]);
    await assert.rejects(applyPatchSpec({ root: f.root, specPath: f.specPath }), /relative path|unsafe segment/);
  }
  const f = await fixture(t, { 'smali/X.smali': smali() }, [operation({ relativePath: 'link/X.smali' })]);
  const outside = path.join(f.root, '..', 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'X.smali'), smali());
  await symlink(outside, path.join(f.root, 'link'), 'junction');
  await assert.rejects(applyPatchSpec({ root: f.root, specPath: f.specPath }), /symbolic links/);
  await rm(outside, { recursive: true, force: true });
});
