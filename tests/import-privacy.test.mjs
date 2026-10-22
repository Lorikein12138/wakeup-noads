import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { applyPatchSpec } from '../scripts/patch.mjs';
import { readSmaliMethod } from './smali-helpers.mjs';

const root = path.resolve(process.env.SLIM_BASELINE_DECODED_ROOT ?? 'tools/_cache/slim-v1-decoded');
const cache = path.resolve('tools/_cache/slim-v1-review/fixtures/round-2');
const relativePaths = [
  'res/layout/fragment_excel_import.xml',
  'res/layout/fragment_html_import.xml',
  'smali_classes6/com/suda/yzune/wakeupschedule/utils/o000O0.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/SchoolListActivity.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule/ScheduleFragment.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/ImportViewModel.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/schedule_import/LoginWebFragment.smali',
  'res/layout/layout_permission_privacy.xml',
  'smali_classes6/com/suda/yzune/wakeupschedule/utils/o000000O.smali',
  'smali_classes6/com/suda/yzune/wakeupschedule/utils/o000000O$OooO00o.smali',
];
const hash = (value) => createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex').toUpperCase();

async function makePatchedFixture(t) {
  await mkdir(cache, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(cache, 'import-privacy-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  for (const relative of relativePaths) {
    const target = path.join(fixtureRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, relative), target);
  }
  const spec = JSON.parse(await readFile('patches/slim-v1/patch-spec.json', 'utf8'));
  const operations = spec.operations.filter((operation) => operation.id.startsWith('T12-'));
  assert.equal(operations.length, 12, 'the T12 import controls, help, privacy, adaptation, feedback, and Job operations are present');
  const specPath = path.join(fixtureRoot, 'fixture-spec.json');
  await writeFile(specPath, JSON.stringify({ schemaVersion: 1, applicationId: 'io.github.wakeupnoads', operations }, null, 2));
  const result = await applyPatchSpec({ root: fixtureRoot, specPath });
  return { fixtureRoot, result };
}

test('E27 keeps local import controls and permanently hides online help/template controls', async (t) => {
  const { fixtureRoot, result } = await makePatchedFixture(t);
  assert.equal(result.operations.length, 12);
  const excel = await readFile(path.join(fixtureRoot, relativePaths[0]), 'utf8');
  const html = await readFile(path.join(fixtureRoot, relativePaths[1]), 'utf8');
  for (const id of ['tv_template', 'tv_guide']) {
    const element = excel.split(/\r?\n/).find((line) => line.includes(`android:id="@id/${id}"`));
    assert.match(element, /android:visibility="gone"/);
    assert.match(element, /android:clickable="false"/);
  }
  const way = html.split(/\r?\n/).find((line) => line.includes('android:id="@id/tv_way"'));
  assert.match(way, /android:visibility="gone"/);
  assert.match(way, /android:clickable="false"/);
  for (const preserved of ['tv_self', 'tv_type', 'cp_utf', 'cp_gbk']) {
    assert.match(`${excel}\n${html}`, new RegExp(`android:id="@id/${preserved}"`));
  }
});

test('E19 help stays local and search misses no longer offer adaptation', async (t) => {
  const { fixtureRoot } = await makePatchedFixture(t);
  const helper = await readSmaliMethod(
    fixtureRoot,
    relativePaths[2],
    'Lcom/suda/yzune/wakeupschedule/utils/o000O0;',
    'public static OooOOo0(Landroid/content/Context;Ljava/lang/String;)V',
  );
  const helpIndex = helper.indexOf(':slim_removed_online_help');
  const toastIndex = helper.indexOf('在线帮助与宣传入口已移除');
  const returnIndex = helper.indexOf('return-void', toastIndex);
  const nonWebIndex = helper.lastIndexOf(':slim_keep_non_web_open');
  const viewIntentIndex = helper.indexOf('android.intent.action.VIEW');
  assert.ok(helpIndex >= 0 && toastIndex > helpIndex && returnIndex > toastIndex && nonWebIndex > returnIndex);
  assert.ok(viewIntentIndex > nonWebIndex, 'HTTP(S) exits before the legacy browser path');
  assert.equal(helper.split('Context;->startActivity(Landroid/content/Intent;)V').length - 1, 1, 'non-web helper behavior stays in its original branch');
  const routeForScheme = (scheme) => ['http', 'https'].includes(scheme.toLowerCase()) ? 'local-message' : 'original-handler';
  assert.equal(routeForScheme('http'), 'local-message');
  assert.equal(routeForScheme('HTTPS'), 'local-message');
  assert.equal(routeForScheme('content'), 'original-handler');

  const school = await readSmaliMethod(
    fixtureRoot,
    relativePaths[3],
    'Lcom/suda/yzune/wakeupschedule/schedule_import/SchoolListActivity;',
    'public final o0000o0O(Ljava/lang/String;)V',
  );
  assert.match(school, /\\u6ca1\\u6709\\u627e\\u5230\\u4f60\\u7684\\u5b66\\u6821\\u54e6/);
  assert.match(school, /Snackbar;->o000oOoO\(\)V/);
  assert.doesNotMatch(school, /\\u7533\\u8bf7\\u9002\\u914d|SchoolListActivity\$OooO0o;-><init>/);

  const helpClick = await readSmaliMethod(
    fixtureRoot,
    relativePaths[3],
    'Lcom/suda/yzune/wakeupschedule/schedule_import/SchoolListActivity;',
    'public static final o0000O(Lcom/suda/yzune/wakeupschedule/schedule_import/SchoolListActivity;Lcom/chad/library/adapter/base/BaseQuickAdapter;Landroid/view/View;I)V',
  );
  assert.match(helpClick, /getType\(\)Ljava\/lang\/String;[\s\S]*?"help"[\s\S]*?utils\/o000O0;->OooOOo0/);
  assert.match(helpClick, /utils\/o000O0;->OooOOo0[\s\S]*?return-void/);

  const sso = await readFile(path.join(fixtureRoot, relativePaths[6]), 'utf8');
  const ssoBaseline = await readFile(path.join(root, relativePaths[6]), 'utf8');
  assert.equal(hash(sso), hash(ssoBaseline), 'dedicated school SSO navigation code is unchanged');
});

test('E08 skips import-feedback behavior and E15 returns an already-completed nonempty Job', async (t) => {
  const { fixtureRoot } = await makePatchedFixture(t);
  const schedule = await readSmaliMethod(
    fixtureRoot,
    relativePaths[4],
    'Lcom/suda/yzune/wakeupschedule/schedule/ScheduleFragment;',
    'public final oo00o(Lcom/suda/yzune/wakeupschedule/schedule/SchedulePagerItemLayout;)V',
  );
  const feedbackDisabled = schedule.indexOf('goto :cond_a');
  const feedbackBranch = schedule.indexOf('showImportFeedback(');
  assert.ok(feedbackDisabled >= 0 && feedbackBranch > feedbackDisabled);
  assert.match(schedule.slice(feedbackDisabled, feedbackBranch), /goto :cond_a/);
  assert.match(schedule, /showOperationContent\(\)V/);
  assert.match(schedule, /showImportFeedback\(/, 'the preserved feedback body is unreachable through the forced-false branch');

  const uploadPath = relativePaths[5];
  const importMethod = 'public final o000OOo(Ljava/lang/String;)Lkotlinx/coroutines/o00O0OOO;';
  const submit = await readSmaliMethod(
    fixtureRoot,
    uploadPath,
    'Lcom/suda/yzune/wakeupschedule/schedule_import/ImportViewModel;',
    importMethod,
  );
  assert.match(submit, /JobKt__JobKt;->OooO0O0\(Lkotlinx\/coroutines\/o00O0OOO;ILjava\/lang\/Object;\)Lkotlinx\/coroutines\/oo0o0Oo;/);
  assert.match(submit, /invoke-interface \{v0\}, Lkotlinx\/coroutines\/oo0o0Oo;->complete\(\)Z/);
  assert.match(submit, /return-object v0/);
  assert.doesNotMatch(submit, /ImportViewModel\$submitExport\$1|aiparse\/submit|webData|fullData|tableHtml/);

  const defaultJobFactory = await readSmaliMethod(
    root,
    'smali_classes7/kotlinx/coroutines/JobKt__JobKt.smali',
    'Lkotlinx/coroutines/JobKt__JobKt;',
    'public static synthetic OooO0O0(Lkotlinx/coroutines/o00O0OOO;ILjava/lang/Object;)Lkotlinx/coroutines/oo0o0Oo;',
  );
  const newJobFactory = await readSmaliMethod(
    root,
    'smali_classes7/kotlinx/coroutines/JobKt__JobKt.smali',
    'Lkotlinx/coroutines/JobKt__JobKt;',
    'public static final OooO00o(Lkotlinx/coroutines/o00O0OOO;)Lkotlinx/coroutines/oo0o0Oo;',
  );
  const completeJob = await readSmaliMethod(
    root,
    'smali_classes7/kotlinx/coroutines/oo0oOO0.smali',
    'Lkotlinx/coroutines/oo0oOO0;',
    'public complete()Z',
  );
  assert.match(defaultJobFactory, /and-int\/lit8 p1, p1, 0x1[\s\S]*?const\/4 p0, 0x0[\s\S]*?o00O;->OooO00o\(Lkotlinx\/coroutines\/o00O0OOO;\)Lkotlinx\/coroutines\/oo0o0Oo;/);
  assert.match(newJobFactory, /new-instance v0, Lkotlinx\/coroutines\/oo0oOO0;[\s\S]*?return-object v0/);
  assert.match(completeJob, /o00O0O\(Ljava\/lang\/Object;\)Z[\s\S]*?return v0/);

  const baselineImport = await readFile(path.join(root, uploadPath), 'utf8');
  const patchedImport = await readFile(path.join(fixtureRoot, uploadPath), 'utf8');
  const baselineMethod = await readSmaliMethod(root, uploadPath, 'Lcom/suda/yzune/wakeupschedule/schedule_import/ImportViewModel;', importMethod);
  const patchedMethod = await readSmaliMethod(fixtureRoot, uploadPath, 'Lcom/suda/yzune/wakeupschedule/schedule_import/ImportViewModel;', importMethod);
  const normalize = (value) => value.replace(/\r\n/g, '\n');
  assert.equal(
    normalize(patchedImport).replace(normalize(patchedMethod), normalize(baselineMethod)),
    normalize(baselineImport),
    'all other parse and local-save methods remain unchanged',
  );
});

test('E30 displays the local privacy text plainly and removes every legacy visitor browser path', async (t) => {
  const { fixtureRoot, result } = await makePatchedFixture(t);
  assert.equal(result.operations.length, 12);

  const privacyLayout = await readFile(path.join(fixtureRoot, relativePaths[7]), 'utf8');
  const visitor = privacyLayout.split(/\r?\n/).find((line) => line.includes('android:id="@id/tv_visitor"'));
  assert.ok(visitor, 'the visitor view id remains available to existing bindings');
  assert.match(visitor, /android:visibility="gone"/);
  assert.doesNotMatch(visitor, /android:layout_marginTop=/, 'the hidden view does not leave vertical spacing');

  const privacyPath = relativePaths[8];
  const privacyClass = 'Lcom/suda/yzune/wakeupschedule/utils/o000000O;';
  const listenerSetup = await readSmaliMethod(fixtureRoot, privacyPath, privacyClass, 'public final OooOO0()V');
  assert.equal(listenerSetup.split('setOnClickListener(').length - 1, 4, 'the four consent and settings listeners remain');
  assert.doesNotMatch(listenerSetup, /->o00OOOo0:Landroid\/view\/View;/, 'the hidden visitor view receives no listener');

  const plainText = await readSmaliMethod(fixtureRoot, privacyPath, privacyClass, 'public final OooOOOO()V');
  assert.match(plainText, /OooO0o0\(\)Landroid\/text\/Spannable;/, 'the original local policy text is still generated');
  assert.match(plainText, /Ljava\/lang\/Object;->toString\(\)Ljava\/lang\/String;/, 'the spannable is converted to an ordinary String');
  assert.match(plainText, /TextView;->setText\(Ljava\/lang\/CharSequence;\)V/);
  assert.doesNotMatch(plainText, /URLSpan|ClickableSpan|SpannableStringBuilder|setMovementMethod/);

  for (const method of ['public final OooO0o()V']) {
    const disabled = await readSmaliMethod(fixtureRoot, privacyPath, privacyClass, method);
    assert.match(disabled, /return-void/);
    assert.doesNotMatch(disabled, /android\.intent\.action\.VIEW|startActivity/);
  }
  const legacySpanClick = await readSmaliMethod(
    fixtureRoot,
    relativePaths[9],
    'Lcom/suda/yzune/wakeupschedule/utils/o000000O$OooO00o;',
    'public onClick(Landroid/view/View;)V',
  );
  assert.match(legacySpanClick, /return-void/);
  assert.doesNotMatch(legacySpanClick, /android\.intent\.action\.VIEW|startActivity/);

  const agreementAndDenial = await readSmaliMethod(fixtureRoot, privacyPath, privacyClass, 'public onClick(Landroid/view/View;)V');
  const baselineAgreementAndDenial = await readSmaliMethod(root, privacyPath, privacyClass, 'public onClick(Landroid/view/View;)V');
  assert.equal(agreementAndDenial, baselineAgreementAndDenial, 'agreement/denial state transitions, persistence, and callbacks remain byte-for-byte unchanged');
  for (const preserved of [
    'o0000OO0;->OooO0o(Landroid/content/Context;Z)V',
    'o000000O;->OooO0oO()V',
    'o000000O$OooO0O0;->OooO0O0()V',
    'o000000O$OooO0O0;->OooO0OO(ZZ)V',
  ]) assert.ok(agreementAndDenial.includes(preserved), `preserved privacy transition: ${preserved}`);
});
