import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const baseline = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const fixtures = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const fragmentPath = 'smali_classes5/com/suda/yzune/wakeupschedule/aaa/fragment/MineFragment.smali';
const layoutPath = 'res/layout/fragment_mine_tab_content_view_new.xml';
const fragmentClass = 'Lcom/suda/yzune/wakeupschedule/aaa/fragment/MineFragment;';

async function patchedFixture(t) {
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(path.join(fixtures, 'mine-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of [fragmentPath, layoutPath]) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(baseline, relative), target);
  }
  const fullSpec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = fullSpec.operations.filter((operation) => operation.id.startsWith('T10-E'));
  assert.equal(operations.length, 15, 'the XML and all lifecycle/listener patches are present');
  const specPath = path.join(root, 'mine-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root, specPath });
  return root;
}

test('T10 layout has only the two settings rows and supports enlarged text', async (t) => {
  const root = await patchedFixture(t);
  const xml = await readFile(path.join(root, layoutPath), 'utf8');
  const ids = [...xml.matchAll(/android:id="@id\/([^\"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ['mine_user_nested_scrollview', 'll_mine_tab_content_view_new_course_setting', 'll_mine_tab_content_view_global_setting']);
  assert.equal((xml.match(/<View\b/g) ?? []).length, 1, 'the two rows use one middle divider');
  assert.equal((xml.match(/android:minHeight="52dp"/g) ?? []).length, 2);
  assert.equal((xml.match(/android:layout_height="wrap_content"/g) ?? []).length, 8);
  assert.match(xml, /android:paddingTop="12dp"/);
  assert.match(xml, /android:layout_marginStart="12dp"/);
  assert.match(xml, /android:layout_marginEnd="12dp"/);
  assert.match(xml, /android:layout_marginStart="16dp"/);
  assert.match(xml, /@drawable\/shape_solid_ffffffff_radius_16dp/);
  assert.doesNotMatch(xml, /MineNewUserLoginView|ComposeView|Banner|bannerLayout|mine_user_login_view|ll_mine_vip_card|ll_mine_tab_content_view_(?!new_course_setting|global_setting)/);
});

test('T10 binds only the two settings listeners and cuts login, Compose, banner, and remote Flow setup', async (t) => {
  const root = await patchedFixture(t);
  const bind = await readSmaliMethod(root, fragmentPath, fragmentClass, 'private final oo000o()V');
  assert.equal((bind.match(/setOnClickListener\(/g) ?? []).length, 2);
  assert.match(bind, /OoooOo0\(\)Landroid\/view\/View;/);
  assert.match(bind, /OoooOoO\(\)Landroid\/view\/View;/);
  assert.doesNotMatch(bind, /MineNewUserLoginView|ComposeView|setContent|Banner|updateData/);

  const create = await readSmaliMethod(root, fragmentPath, fragmentClass, 'public onCreateView(Landroid/view/LayoutInflater;Landroid/view/ViewGroup;Landroid/os/Bundle;)Landroid/view/View;');
  assert.match(create, /inflate\(ILandroid\/view\/ViewGroup;Z\)Landroid\/view\/View;/);
  assert.match(create, /oo000o\(\)V/);
  assert.match(create, /ViewCompat;->setOnApplyWindowInsetsListener\(Landroid\/view\/View;Landroidx\/core\/view\/OnApplyWindowInsetsListener;\)V/);
  assert.doesNotMatch(create, /o00O0O\(|o0OO00O\(|o00Oo0\(\)V/);

  for (const [signature, forbidden] of [
    ['public onResume()V', /MineViewModel|OooooO0/],
    ['public OooOoo()V', /MineViewModel|Banner|Ooooo00/],
    ['public OooOoo0()V', /Banner/],
    ['public onActivityResult(IILandroid/content/Intent;)V', /o0OO00O|o0ooOOo|QRScanActivity/],
  ]) {
    assert.doesNotMatch(await readSmaliMethod(root, fragmentPath, fragmentClass, signature), forbidden, signature);
  }
  assert.match(await readSmaliMethod(root, fragmentPath, fragmentClass, 'private final o00ooo()V'), /OoooooO\(\)Landroidx\/core\/widget\/NestedScrollView;/);
});

test('T10 click routing preserves both host callbacks and ends every removed menu route', async (t) => {
  const root = await patchedFixture(t);
  const click = await readSmaliMethod(root, fragmentPath, fragmentClass, 'public onClick(Landroid/view/View;)V');
  assert.match(click, /const v1, 0x7f0906e6\s+if-ne v0, v1, :cond_1/);
  assert.match(click, /const v1, 0x7f0906e2\s+if-ne v0, v1, :cond_0/);
  assert.equal((click.match(/ScheduleActivity;->o0000O0O\(\)/g) ?? []).length, 2);
  for (const call of [
    'ScheduleFragment;->o00oOOO0()Lkotlin/jvm/functions/Function0;',
    'ScheduleFragment;->o00OOOo0()Lkotlin/jvm/functions/Function0;',
    'MineActivity;->o00Oo0()V',
    'MineActivity;->ooOO()V',
  ]) assert.equal((click.match(new RegExp(call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1, call);
  assert.doesNotMatch(click, /CommonCacheHybridActivity|VipExclusiveActivity|QRScanActivity|startActivity|o0ooOOo\(/);
});
