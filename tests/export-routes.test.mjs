import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const files = [
  'res/layout/share_schedule_popup_window.xml',
  'smali_classes5/o0O0ooOO.9/oo0o0O0.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule/ScheduleFragment.smali',
];

async function patchedFixture(t) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'export-routes-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of files) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baseline, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T09-'));
  assert.equal(operations.length, 3, 'layout, menu binding, and removed-route guard operations are present');
  const specPath = path.join(root, 'export-routes-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root, specPath });
  return root;
}

test('export menu and click binding retain only local iCalendar', async (t) => {
  const root = await patchedFixture(t);
  const xml = await readFile(path.join(root, files[0]), 'utf8');
  assert.deepEqual([...xml.matchAll(/android:id="@id\/([^"]+)"/g)].map((match) => match[1]), ['export_as_cal_file']);
  const binding = await readSmaliMethod(root, files[1], 'Lo0O0ooOO/oo0o0O0;', 'public OooO0o0()V');
  assert.match(binding, /0x7f09027b/);
  assert.doesNotMatch(binding, /0x7f0908fa|0x7f0908fb/);
});

test('removed share routes return before online helper or viewmodel calls while iCalendar export remains', async (t) => {
  const root = await patchedFixture(t);
  const route = await readSmaliMethod(root, files[2], 'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleFragment;', 'public static final o00Ooo0o(Lcom/suda/yzune/wakeupschedule/schedule/ScheduleFragment;Landroid/content/Context;Ljava/lang/Integer;)Lkotlin/o0ooOOo;');
  const guard = route.slice(0, route.indexOf('sget-object v0, Lkotlin/LazyThreadSafetyMode;'));
  assert.match(guard, /0x7f0908fa[\s\S]*0x7f0908fb[\s\S]*return-object p0/);
  assert.match(route, /0x7f09027b[\s\S]*o00OooO\(Lkotlin\/OooOOO0;\)Ljava\/lang\/String;[\s\S]*o00O0o0O\(Ljava\/lang\/String;\)V/);
  assert.match(route, /o000O0;->OooOOo\(Landroidx\/fragment\/app\/FragmentActivity;\)V/);
  assert.match(route, /ScheduleViewModel;->o00000O0\(Landroid\/content\/Context;\)Lkotlinx\/coroutines\/o00O0OOO;/);
});
