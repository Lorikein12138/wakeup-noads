import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const activityPath = 'smali_classes6/com/suda/yzune/wakeupschedule/schedule/ScheduleActivity.smali';
const tabsPath = 'smali_classes6/com/suda/yzune/wakeupschedule/widget/MainAiTitleTabView.smali';
const adapterPath = 'smali_classes5/o0O0OOoo.2/OooOOO.smali';
const activityClass = 'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity;';
const tabsClass = 'Lcom/suda/yzune/wakeupschedule/widget/MainAiTitleTabView;';
const adapterClass = 'Lo0O0OOoo/OooOOO;';
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function patchedFixture(t) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'navigation-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of [activityPath, tabsPath, adapterPath]) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baseline, relative), target);
  }
  const spec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = spec.operations.filter((operation) => operation.id.startsWith('T07-E05-'));
  assert.equal(operations.length, 6, 'banner, removed page entries, unknown-tab sentinel, and fallback operations are present');
  const specPath = path.join(root, 'navigation-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root, specPath });
  return root;
}

test('home adapter contains schedule, optional calendar, and mine only', async (t) => {
  const root = await patchedFixture(t);
  const onCreate = await readSmaliMethod(root, activityPath, activityClass, 'public onCreate(Landroid/os/Bundle;)V');
  assert.match(onCreate, /invoke-static \{\}, Lo0O0o0O\/o00oO0o;->OooOOo0\(\)Z[\s\S]*?if-eqz v4, :cond_b[\s\S]*?const-string v6, "calendar"/);
  assert.match(onCreate, /const-string v5, "schedule"/);
  assert.match(onCreate, /const-string v5, "mine"/);
  assert.doesNotMatch(onCreate, /AssistantFragment|const-string v5, "assistant"|const-string v5, "learn"|aaa\/learn\/Oooo000/);

  const assemble = (calendarEnabled) => [...(calendarEnabled ? ['calendar'] : []), 'schedule', 'mine'];
  assert.deepEqual(assemble(false), ['schedule', 'mine']);
  assert.deepEqual(assemble(true), ['calendar', 'schedule', 'mine']);
});

test('restored bottom_banner cannot select the HomeBannerController branch', async (t) => {
  const root = await patchedFixture(t);
  const onCreate = await readSmaliMethod(root, activityPath, activityClass, 'public onCreate(Landroid/os/Bundle;)V');
  const assignedFalse = onCreate.indexOf('iput-boolean v0, p0, Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity;->o00OOOO:Z');
  const bannerBranch = onCreate.indexOf('iget-boolean v1, p0, Lcom/suda/yzune/wakeupschedule/schedule/ScheduleActivity;->o00OOOO:Z');
  const bannerCreate = onCreate.indexOf('new-instance p1, Lcom/suda/yzune/wakeupschedule/schedule/home/HomeBannerController;');
  assert.ok(assignedFalse >= 0 && bannerBranch > assignedFalse && bannerCreate > bannerBranch);
  assert.match(onCreate.slice(bannerBranch, bannerCreate), /if-eqz v1, :cond_8/);
  assert.match(onCreate, /invoke-virtual \{p1\}, Lo0O0oOOO\/o00000OO;->OooO0O0\(\)Landroid\/widget\/FrameLayout;/);
});

test('retained page IDs resolve by the current adapter; removed and unknown IDs fall back to schedule', async (t) => {
  const root = await patchedFixture(t);
  const adapter = await readSmaliMethod(root, adapterPath, adapterClass, 'public final OooO00o(Ljava/lang/String;)I');
  const route = await readSmaliMethod(root, activityPath, activityClass, 'public final o0000oO0(Ljava/lang/String;)V');
  assert.match(adapter, /Iterable;->iterator\(\)[\s\S]*?const\/4 v1, -0x1[\s\S]*?const\/4 v2, 0x0/);
  assert.match(adapter, /OooOOOO;->OooO0O0\(\)Ljava\/lang\/String;[\s\S]*?if-eqz v3, :cond_1[\s\S]*?return v1/);
  assert.match(route, /OooOOO;->OooO00o\(Ljava\/lang\/String;\)I[\s\S]*?if-gez p1, :slim_v1_schedule_tab_resolved[\s\S]*?const-string p1, "schedule"[\s\S]*?setCurrentItem\(I\)V/);
  for (const ids of [['schedule', 'mine'], ['calendar', 'schedule', 'mine']]) {
    const resolve = (id) => {
      const found = ids.indexOf(id);
      return found >= 0 ? found : ids.indexOf('schedule');
    };
    for (const id of ids) assert.equal(resolve(id), ids.indexOf(id));
    for (const id of ['learn', 'assistant', 'unknown']) assert.equal(ids[resolve(id)], 'schedule');
  }
});

test('tab labels and page callbacks continue to use the adapter list and dynamic positions', async (t) => {
  const root = await patchedFixture(t);
  const loadTabs = await readSmaliMethod(root, tabsPath, tabsClass, 'private final loadTabs(Ljava/util/List;)V');
  const setViewPager = await readSmaliMethod(root, tabsPath, tabsClass, 'public final setViewPager(Landroidx/viewpager/widget/ViewPager;Lcom/suda/yzune/wakeupschedule/schedule/ScheduleViewModel;)V');
  assert.match(loadTabs, /List;->size\(\)I[\s\S]*?div-int\/2addr v1, v0[\s\S]*?Iterable;->iterator\(\)/);
  assert.match(loadTabs, /add-int\/lit8 v4, v3, 0x1[\s\S]*?OooOOOO;->OooO0OO\(\)Ljava\/lang\/String;[\s\S]*?MainAiTitleTabView\$OooO0O0;-><init>\(Lcom\/suda\/yzune\/wakeupschedule\/widget\/MainAiTitleTabView;ILjava\/lang\/String;\)V/);
  assert.match(setViewPager, /OooOOO;->OooO0O0\(\)Ljava\/util\/List;[\s\S]*?loadTabs\(Ljava\/util\/List;\)V[\s\S]*?getCount\(\)I/);

  const baselineOnNewIntent = await readSmaliMethod(baseline, activityPath, activityClass, 'public onNewIntent(Landroid/content/Intent;)V');
  const patchedOnNewIntent = await readSmaliMethod(root, activityPath, activityClass, 'public onNewIntent(Landroid/content/Intent;)V');
  assert.equal(hash(patchedOnNewIntent), hash(baselineOnNewIntent), 'date, course, component, and import-result intent handling stays unchanged');
});
