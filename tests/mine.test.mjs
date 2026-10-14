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
  assert.equal(operations.length, 16, 'the XML and all lifecycle/listener patches are present');
  const specPath = path.join(root, 'mine-fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }));
  await applyPatchSpec({ root, specPath });
  return root;
}

test('T10 layout has two settings rows and a tagged logs row, all supporting enlarged text', async (t) => {
  const root = await patchedFixture(t);
  const xml = await readFile(path.join(root, layoutPath), 'utf8');
  const ids = [...xml.matchAll(/android:id="@id\/([^\"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ['mine_user_nested_scrollview', 'll_mine_tab_content_view_new_course_setting', 'll_mine_tab_content_view_global_setting']);
  assert.equal((xml.match(/<View\b/g) ?? []).length, 2, 'three rows use two dividers');
  assert.equal((xml.match(/android:tag="wakeup_noads_logs_entry"/g) ?? []).length, 1, 'the logs row has one stable non-resource tag');
  assert.equal((xml.match(/android:minHeight="52dp"/g) ?? []).length, 3);
  assert.equal((xml.match(/android:layout_height="wrap_content"/g) ?? []).length, 11);
  assert.match(xml, /android:paddingTop="12dp"/);
  assert.match(xml, /android:layout_marginStart="12dp"/);
  assert.match(xml, /android:layout_marginEnd="12dp"/);
  assert.match(xml, /android:layout_marginStart="16dp"/);
  assert.match(xml, /@drawable\/shape_solid_ffffffff_radius_16dp/);
  assert.doesNotMatch(xml, /android:id="@\+id\//, 'logs adds no numeric resource ID');
  assert.doesNotMatch(xml, /MineNewUserLoginView|ComposeView|Banner|bannerLayout|mine_user_login_view|ll_mine_vip_card|ll_mine_tab_content_view_(?!new_course_setting|global_setting)/);
});

test('T10 binds both settings and the local log entry while cutting login, Compose, banner, and remote Flow setup', async (t) => {
  const root = await patchedFixture(t);
  const bind = await readSmaliMethod(root, fragmentPath, fragmentClass, 'private final oo000o()V');
  assert.equal((bind.match(/setOnClickListener\(/g) ?? []).length, 2);
  assert.match(bind, /OoooOo0\(\)Landroid\/view\/View;/);
  assert.match(bind, /OoooOoO\(\)Landroid\/view\/View;/);
  assert.match(bind, /OooO0o\(\)Landroid\/view\/View;[\s\S]*?LogPage;->bind\(Ljava\/lang\/Object;Ljava\/lang\/Object;\)V/);
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
  const result = await readSmaliMethod(root, fragmentPath, fragmentClass, 'public onActivityResult(IILandroid/content/Intent;)V');
  assert.match(result, /invoke-super \{p0, p1, p2, p3\}, Landroidx\/fragment\/app\/Fragment;->onActivityResult\(IILandroid\/content\/Intent;\)V[\s\S]*?LogPage;->onActivityResult\(Ljava\/lang\/Object;IILjava\/lang\/Object;\)V/);
  assert.equal((result.match(/LogPage;->onActivityResult/g) ?? []).length, 1);
  const destroy = await readSmaliMethod(root, fragmentPath, fragmentClass, 'public onDestroy()V');
  assert.match(destroy, /LogPage;->close\(Ljava\/lang\/Object;\)V[\s\S]*?invoke-super \{p0\}, Lo000O00O\/OooO00o;->onDestroy\(\)V[\s\S]*?sput-object v0, Lcom\/suda\/yzune\/wakeupschedule\/aaa\/utils\/o000OOo0;->OooO00o/);
  assert.equal((destroy.match(/LogPage;->close\(Ljava\/lang\/Object;\)V/g) ?? []).length, 1);
  const bridge = await readFile('runtime/src/com/suda/yzune/wakeupschedule/slim/LogPage.java', 'utf8');
  for (const signature of [
    /public static void bind\(Object fragment, Object rootView\)/,
    /public static void show\(Object fragment\)/,
    /public static void onActivityResult\(Object fragment, int requestCode, int resultCode, Object intent\)/,
    /public static void close\(Object fragment\)/,
  ]) assert.match(bridge, signature, 'public Java method matches the Smali bridge ABI');
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

test('LogPage toolbar and five text controls grow with SP text and keep minimum touch sizes', async () => {
  const source = await readFile('runtime/src/com/suda/yzune/wakeupschedule/slim/LogPage.java', 'utf8');
  const buildDialog = source.slice(source.indexOf('private void buildDialog('), source.indexOf('private void renderList('));
  const renderDetail = source.slice(source.indexOf('private void renderDetail('), source.indexOf('private void addLabel('));
  const textHelper = source.slice(source.indexOf('private static Object text('), source.indexOf('private static void setClick('));
  const controls = [
    /styleTextControl\(back, context, 56, 17\)/,
    /styleTextControl\(title, context, 56, 16\)/,
    /styleTextControl\(refreshButton, context, 56, 17\)/,
    /styleTextControl\(copy, activity\.get\(\), 48, 17\)/,
    /styleTextControl\(export, activity\.get\(\), 48, 17\)/,
  ];
  for (const control of controls) assert.match(`${buildDialog}\n${renderDetail}`, control);
  assert.match(buildDialog, /add\(root, bar, linearParams\(context, -1, -2, 0\)\)/, 'toolbar height is WRAP_CONTENT');
  assert.match(buildDialog, /add\(bar, title, linearParams\(context, 0, -2, 1\)\)/, 'title keeps width weight and WRAP_CONTENT height');
  assert.match(renderDetail, /linearParams\(activity\.get\(\), 0, -2, 1\)/, 'actions grow with their text controls');
  assert.match(source, /private static void styleTextControl[\s\S]*?setMinHeight[\s\S]*?dp\(context, 8\)[\s\S]*?dp\(context, 8\)[\s\S]*?dp\(context, 8\)[\s\S]*?dp\(context, 8\)[\s\S]*?setGravity/);
  assert.match(textHelper, /setTextSize[\s\S]*?new Object\[\] \{ 2, \(float\) size \}/, 'text uses Android COMPLEX_UNIT_SP');
  assert.doesNotMatch(`${buildDialog}\n${renderDetail}`, /linearParams\([^\n]*,\s*dp\(\s*\w+\s*,\s*(?:48|56)\s*\)\s*,/,
    'control and toolbar heights are not fixed dp values');
  assert.doesNotMatch(`${buildDialog}\n${renderDetail}`, /setSingleLine|setMaxLines|setLines\(/, 'title and controls have no fixed line-count override');
});
