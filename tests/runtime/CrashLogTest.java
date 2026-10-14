package com.suda.yzune.wakeupschedule.slim;

import java.io.File;
import java.io.FilterInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Collections;
import java.util.concurrent.Executor;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class CrashLogTest {
    public static void main(String[] args) throws Exception {
        testCrashReportCarriesHeaderThreadAndCauses();
        testHandlerWritesThenDelegates();
        testHandlerDelegatesWhenSinkOrHeaderFails();
        testHandlerWithoutPreviousDoesNotThrow();
        testFileNameIsSafe();
        testOnlyNewAbnormalExitsAreReported();
        testExitReportListsRecordsAndTraces();
        testNativeTraceKeepsReadableRuns();
        testWatermarkRoundTrip();
        testInstallNeverThrowsAndChainsOutsideAndroid();
        testAutomaticLogDirectoryAndUtf8Write();
        testReportsSafe();
        testDiagnosticHeaderRules();
        testSanitizerStreamingAndLineBoundaries();
        testLogStoreFiltersAndSanitizesEveryReadPath();
        testLegacyDownloadHeaderOwnership();
        testLogPageControllerCopiesAndExportsSanitizedSnapshot();
        testLogPageFailuresAndBridgeAbi();
        testLogPageExplicitActivityLaunchAndMode();
        testActivityOwnedPageThemeInsetsAndDetach();
        testProductionLogPageRendererStatesAndInitializationFailure();
        testActivityOwnedBackAndStaleCallbacks();
        testActivityOwnedSafResultAndFailure();
        testActivityOwnedExportStagesSurviveRecreation();
        testExportSessionCancellationAndStaleResults();
        testReadCloseFailuresAreNotSuccess();
        testMediaStoreProductionAdapterAndStates();
        testMediaStoreMultipleSourcesHaveStableOrdering();
        testExactLimitsAndUtf8Prefix();
        testSnapshotCleanupAndDocumentAdapter();
        testWritingAndFinalizingCallbacksAreIdempotent();
        testQueuedCompletionDoesNotOverwriteNextSelection();
        testStaleGenerationCallbacksReleaseResources();
        testAndroidHostOpenFailuresUseControllerPath();
        testDeleteExceptionUsesFixedResidualMessage();
        testOrphanCleanupDuringWritingAndCancellation();
        System.out.println("CrashLogTest passed (10 legacy + 6 round-1 + 7 round-2 + 7 round-3 + 5 round-4 + 1 round-5 groups)");
    }

    private static void testCrashReportCarriesHeaderThreadAndCauses() {
        Map<String, String> header = new LinkedHashMap<String, String>();
        header.put("package", "io.github.wakeupnoads");
        header.put("android", "14 (API 34)");
        Throwable error = new IllegalStateException("outer-secret student=827361", new UnsupportedOperationException("inner-secret"));
        error.setStackTrace(new StackTraceElement[] { new StackTraceElement("com.example.CrashPath", "run", "CrashPath.java", 5) });
        String report = CrashLog.crashReport(header, "main", error);
        check(report.startsWith("wakeup-noads crash log\n"), "report has a title line");
        check(report.contains("package: io.github.wakeupnoads\n"), "header values are written");
        check(report.indexOf("package:") < report.indexOf("android:"), "header order is preserved");
        check(report.contains("thread: main\n"), "crashing thread is named");
        check(report.contains("java.lang.IllegalStateException: [redacted]"), "exception type is kept and message hidden");
        check(report.contains("Caused by: java.lang.UnsupportedOperationException: [redacted]"), "cause type and relation are kept");
        check(!report.contains("outer-secret") && !report.contains("827361") && !report.contains("inner-secret"), "exception messages and identity numbers are absent");
        check(report.contains("com.example.CrashPath.run(CrashPath.java:5)"), "safe stack frames are written");
        check(CrashLog.stackTrace(null).equals("null\n"), "a null throwable is still reported");
    }

    private static void testHandlerWritesThenDelegates() {
        final List<String> events = new ArrayList<String>();
        final AtomicReference<String> written = new AtomicReference<String>();
        final AtomicReference<Throwable> delegatedError = new AtomicReference<Throwable>();
        Thread.UncaughtExceptionHandler previous = new Thread.UncaughtExceptionHandler() {
            @Override public void uncaughtException(Thread thread, Throwable error) { delegatedError.set(error); events.add("previous:" + error.getMessage()); }
        };
        CrashLog.Handler handler = new CrashLog.Handler(previous, new CrashLog.Sink() {
            @Override public void write(String fileName, String content) {
                events.add("write:" + fileName.substring(0, 6));
                written.set(content);
            }
        }, header("model", "test-device"));
        RuntimeException original = new RuntimeException("boom");
        handler.uncaughtException(Thread.currentThread(), original);
        check(events.equals(Arrays.asList("write:crash-", "previous:boom")), "the log is written before the original handler runs");
        check(delegatedError.get() == original, "the original handler receives the unchanged Throwable exactly once");
        check(!written.get().contains("model") && !written.get().contains("test-device"), "unknown device header fields are omitted");
        check(written.get().contains("java.lang.RuntimeException: [redacted]"), "safe exception type is retained at the sink");
        check(!written.get().contains("boom"), "free exception message is absent at the sink");
    }

    private static void testHandlerDelegatesWhenSinkOrHeaderFails() {
        final AtomicInteger delegated = new AtomicInteger();
        Thread.UncaughtExceptionHandler previous = new Thread.UncaughtExceptionHandler() {
            @Override public void uncaughtException(Thread thread, Throwable error) { delegated.incrementAndGet(); }
        };
        new CrashLog.Handler(previous, new CrashLog.Sink() {
            @Override public void write(String fileName, String content) throws Exception { throw new java.io.IOException("disk full"); }
        }, header("a", "b")).uncaughtException(Thread.currentThread(), new RuntimeException("x"));
        check(delegated.get() == 1, "a failing sink still reaches the original handler");

        final AtomicReference<String> written = new AtomicReference<String>();
        new CrashLog.Handler(previous, new CrashLog.Sink() {
            @Override public void write(String fileName, String content) { written.set(content); }
        }, new CrashLog.Header() {
            @Override public Map<String, String> collect() { throw new IllegalStateException("no context"); }
        }).uncaughtException(Thread.currentThread(), new RuntimeException("y"));
        check(delegated.get() == 2, "a failing header still reaches the original handler");
        check(written.get() != null && written.get().contains("java.lang.RuntimeException: [redacted]"), "a failing header still writes a safe stack trace");
        check(!written.get().contains("no context") && !written.get().contains(": y"), "header and exception messages remain hidden");

        new CrashLog.Handler(previous, new CrashLog.Sink() {
            @Override public void write(String fileName, String content) { throw new OutOfMemoryError("simulated"); }
        }, header("a", "b")).uncaughtException(Thread.currentThread(), new RuntimeException("z"));
        check(delegated.get() == 3, "an Error inside the sink still reaches the original handler");
    }

    private static void testHandlerWithoutPreviousDoesNotThrow() {
        final AtomicInteger writes = new AtomicInteger();
        new CrashLog.Handler(null, new CrashLog.Sink() {
            @Override public void write(String fileName, String content) { writes.incrementAndGet(); }
        }, header("a", "b")).uncaughtException(null, new RuntimeException("no previous"));
        check(writes.get() == 1, "the report is written without an original handler or thread");
    }

    private static void testFileNameIsSafe() {
        String name = CrashLog.fileName("crash", 1_760_000_000_000L);
        check(name.matches("crash-\\d{8}-\\d{6}-\\d{3}-\\d+\\.txt"), "file name is timestamped, numeric, and .txt: " + name);
    }

    private static void testOnlyNewAbnormalExitsAreReported() {
        List<CrashLog.ExitRecord> records = new ArrayList<CrashLog.ExitRecord>();
        records.add(record(300, CrashLog.REASON_CRASH_NATIVE));
        records.add(record(100, CrashLog.REASON_CRASH));
        records.add(record(400, 10));
        records.add(record(250, CrashLog.REASON_ANR));
        records.add(record(50, CrashLog.REASON_INITIALIZATION_FAILURE));
        records.add(record(200, 3));
        List<CrashLog.ExitRecord> fresh = CrashLog.newRecords(records, 60);
        check(fresh.size() == 3, "only reportable records after the watermark are selected");
        check(fresh.get(0).timestamp == 100 && fresh.get(1).timestamp == 250 && fresh.get(2).timestamp == 300, "records are oldest first");
        check(CrashLog.latestTimestamp(records, 60) == 400, "the watermark advances past non-reportable records too");
        check(CrashLog.latestTimestamp(new ArrayList<CrashLog.ExitRecord>(), 60) == 60, "no records keep the watermark");
        for (int reason : new int[] { 1, 2, 4, 5, 6, 7, 9 }) check(CrashLog.isReportable(reason), "reason " + reason + " is reportable");
        for (int reason : new int[] { 0, 3, 8, 10, 11, 12, 13, 14, 15, 16 }) check(!CrashLog.isReportable(reason), "reason " + reason + " is ordinary");
    }

    private static void testExitReportListsRecordsAndTraces() {
        CrashLog.ExitRecord nativeCrash = record(1_760_000_000_000L, CrashLog.REASON_CRASH_NATIVE);
        nativeCrash.trace = "Abort message: 'signature mismatch'";
        CrashLog.ExitRecord javaCrash = record(1_760_000_100_000L, CrashLog.REASON_CRASH);
        String report = CrashLog.exitReport(header("android", "11 (API 30)").collect(),Arrays.asList(nativeCrash, javaCrash));
        check(report.startsWith("wakeup-noads exit log\nandroid: 11 (API 30)\n"), "exit report has title and header");
        check(report.contains(" CRASH_NATIVE ==\n[redacted]\n-- trace --\n[redacted]\n"), "native free summary and abort text are hidden");
        check(report.contains(" CRASH ==\n[redacted]\n"), "system summary is hidden");
        check(!report.contains("summary-176") && !report.contains("signature mismatch"), "exit descriptions do not leak");
        check(report.indexOf("CRASH_NATIVE") < report.indexOf(" CRASH ==\n"), "records keep their order");
        check(CrashLog.reasonName(42).equals("REASON_42"), "unknown reasons are still named");
    }

    private static void testNativeTraceKeepsReadableRuns() {
        byte[] data = new byte[] { 0x0a, 0x05, 'a', 'b', 0x12, 'l', 'i', 'b', 'c', '.', 's', 'o', 0x00, 'x', 0x1a,
            'A', 'b', 'o', 'r', 't', ' ', 'm', 's', 'g', (byte) 0xff };
        String text = CrashLog.traceText(data, false, true);
        check(text.equals("libc.so\nAbort msg\n"), "binary traces keep only printable runs: " + text);
        check(CrashLog.traceText("ANR trace".getBytes(Charset.forName("UTF-8")), true, false).equals("ANR trace\n[truncated]\n"), "text traces are kept and truncation is marked");
    }

    private static void testWatermarkRoundTrip() throws Exception {
        File directory = cacheTemp("crash-log-test");
        try {
            File file = new File(new File(directory, "nested"), "watermark");
            check(CrashLog.readWatermark(file) == 0L, "a missing watermark reads as zero");
            CrashLog.writeWatermark(file, 1_760_000_000_123L);
            check(CrashLog.readWatermark(file) == 1_760_000_000_123L, "the watermark round-trips");
            Files.write(file.toPath(), "garbage".getBytes(Charset.forName("UTF-8")));
            check(CrashLog.readWatermark(file) == 0L, "a corrupt watermark reads as zero");
        } finally {
            deleteTree(directory);
        }
    }

    private static void testInstallNeverThrowsAndChainsOutsideAndroid() {
        Thread.UncaughtExceptionHandler original = Thread.getDefaultUncaughtExceptionHandler();
        final AtomicInteger delegated = new AtomicInteger();
        Thread.UncaughtExceptionHandler previous = new Thread.UncaughtExceptionHandler() {
            @Override public void uncaughtException(Thread thread, Throwable error) { delegated.incrementAndGet(); }
        };
        try {
            Thread.setDefaultUncaughtExceptionHandler(previous);
            CrashLog.install(null);
            check(Thread.getDefaultUncaughtExceptionHandler() == previous, "a null context installs nothing");
            CrashLog.install(new Object());
            Thread.UncaughtExceptionHandler installed = Thread.getDefaultUncaughtExceptionHandler();
            check(installed instanceof CrashLog.Handler, "the crash handler is installed");
            CrashLog.install(new Object());
            check(Thread.getDefaultUncaughtExceptionHandler() == installed, "a second install is a no-op");
            installed.uncaughtException(Thread.currentThread(), new RuntimeException("no android"));
            check(delegated.get() == 1, "without Android storage the original handler still runs");
        } finally {
            Thread.setDefaultUncaughtExceptionHandler(original);
        }
    }

    private static void testAutomaticLogDirectoryAndUtf8Write() throws Exception {
        File root = cacheTemp("calendar-tab-auto-log-");
        try {
            File publicDirectory = new File(root, "public-download");
            check(publicDirectory.mkdirs(), "test public sentinel directory is created under tools cache");
            File sentinel = new File(publicDirectory, "existing.txt");
            byte[] sentinelBytes = "legacy-public-sentinel".getBytes("UTF-8");
            Files.write(sentinel.toPath(), sentinelBytes);
            File written = CrashLog.writeAutomaticLog(root, "crash-20261012-010203-004-12.txt",
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\nmessage: 密码=secret-value\n");
            check(written.getParentFile().equals(CrashLog.logDirectory(root)), "automatic writes use the shared crash-logs directory helper");
            check(written.isFile(), "automatic writing creates the private directory and file");
            String actual = new String(Files.readAllBytes(written.toPath()), "UTF-8");
            check(actual.contains("package: io.github.wakeupnoads") && actual.contains("[redacted]"), "automatic file is UTF-8 and sanitized before its first write");
            check(!actual.contains("secret-value"), "automatic file never contains the synthetic secret");
            check(Arrays.equals(sentinelBytes, Files.readAllBytes(sentinel.toPath())), "public directory sentinel remains byte-for-byte unchanged");
            check(!new File(publicDirectory, written.getName()).exists(), "automatic writing does not create a public fallback");
            boolean nullFailed = false;
            try { CrashLog.writeAutomaticLog(null, "crash-20261012-010203-005-12.txt", "raw"); }
            catch (IOException expected) { nullFailed = true; }
            check(nullFailed, "null external-files root fails explicitly");
            File regularFile = new File(root, "not-a-directory");
            Files.write(regularFile.toPath(), new byte[] { 1 });
            boolean unwritableFailed = false;
            try { CrashLog.writeAutomaticLog(regularFile, "crash-20261012-010203-006-12.txt", "raw"); }
            catch (IOException expected) { unwritableFailed = true; }
            check(unwritableFailed, "an unusable external-files root fails without fallback");

            File watermark = new File(root, "files/watermark");
            CrashLog.writeWatermark(watermark, 100L);
            boolean sinkFailed = false;
            try {
                CrashLog.persistExitReportThenWatermark(new CrashLog.Sink() {
                    @Override public void write(String name, String content) throws Exception { throw new IOException("write failure"); }
                }, "exit-20261012-010203-004-12.txt", "wakeup-noads exit log\n", watermark, 100L, 200L);
            } catch (IOException expected) { sinkFailed = true; }
            check(sinkFailed && CrashLog.readWatermark(watermark) == 100L, "failed exit report write cannot advance the watermark");
            final AtomicReference<String> exitWrite = new AtomicReference<String>();
            CrashLog.persistExitReportThenWatermark(new CrashLog.Sink() {
                @Override public void write(String name, String content) { exitWrite.set(content); }
            }, "exit-20261012-010203-004-12.txt", "wakeup-noads exit log\n[redacted]\n", watermark, 100L, 200L);
            check(exitWrite.get() != null && CrashLog.readWatermark(watermark) == 200L, "successful exit write precedes watermark advancement");
        } finally { deleteTree(root); }
    }

    private static void testReportsSafe() {
        Map<String, String> header = new LinkedHashMap<String, String>();
        header.put("time", CrashLog.formatTime(1_760_000_000_000L));
        header.put("package", "io.github.wakeupnoads");
        header.put("version", "1.2.3 (42)");
        header.put("android", "14 (API 34)");
        header.put("abi", "[arm64-v8a, armeabi-v7a]");
        header.put("webview", "com.android.webview 129.0.6668.81");
        header.put("device", "Pixel Model-Sensitive");
        header.put("fingerprint", "brand/device/id/827361");
        header.put("private-key", "token=never-output");
        Throwable failure = new IllegalStateException("Alice Example student 827361 phone 13800138000 email alice@example.invalid password=p@ss",
            new UnsupportedOperationException("Cookie: sid=abc; Authorization: Bearer token-value"));
        failure.addSuppressed(new IllegalArgumentException("JWT eyJhbGciOiJIUzI1NiJ9.fake.payload"));
        String report = CrashLog.crashReport(header, "Custom-Alice-Thread", failure);
        check(report.startsWith("wakeup-noads crash log\n"), "crash report title remains");
        check(report.contains("package: io.github.wakeupnoads") && report.contains("version: 1.2.3 (42)"), "validated package and version remain");
        check(report.contains("android: 14 (API 34)") && report.contains("abi: [arm64-v8a, armeabi-v7a]"), "validated platform diagnostics remain");
        check(report.contains("webview: com.android.webview 129.0.6668.81"), "validated WebView diagnostic remains");
        check(report.contains("thread: [redacted]"), "arbitrary thread name is hidden");
        check(report.contains("java.lang.IllegalStateException: [redacted]") && report.contains("Caused by: java.lang.UnsupportedOperationException: [redacted]"), "exception and cause classes remain while messages are fixed placeholders");
        check(report.contains("Suppressed: java.lang.IllegalArgumentException: [redacted]"), "suppressed exception structure remains");
        check(report.contains("CrashLogTest.testReportsSafe"), "safe Java stack frames remain");
        for (String secret : new String[] { "Alice Example", "827361", "13800138000", "alice@example.invalid", "p@ss", "sid=abc", "Bearer", "token-value", "eyJhbGci", "Pixel", "fingerprint", "private-key" }) {
            check(!report.contains(secret), "crash report omits synthetic secret: " + secret);
        }

        Map<String, String> unsafeHeader = new LinkedHashMap<String, String>();
        unsafeHeader.put("package", "io.github.wakeupnoads\nAuthorization: bearer encoded");
        unsafeHeader.put("android", "14 (API 34) https://private.invalid/?token=one");
        unsafeHeader.put("unknown-field", "value-should-not-appear");
        CrashLog.ExitRecord record = new CrashLog.ExitRecord(1_760_000_000_000L, CrashLog.REASON_ANR,
            "name=Alice student=827361 /data/user/0/io.github.wakeupnoads/private.json", null);
        record.trace = "Abort message: token=exit-secret\nCmd line: io.github.wakeupnoads user=Alice\n"
            + "    at com.suda.yzune.wakeupschedule.slim.LogPage.select(LogPage.java:88)\n"
            + "#00 pc 0000000000001a2b /data/app/private/libdiagnostic.so (safeSymbol+12)\n"
            + "    at com.suda.yzune.wakeupschedule.slim.LogPage.copySelected(LogPage.java:120)\n";
        String exit = CrashLog.exitReport(unsafeHeader, Collections.singletonList(record));
        check(exit.contains(CrashLog.formatTime(record.timestamp) + " ANR =="), "exit timestamp and reason are retained in the record boundary");
        check(exit.contains("package: [redacted]") && exit.contains("android: [redacted]"), "malformed allowed header values are replaced as whole values");
        check(!exit.contains("unknown-field") && !exit.contains("value-should-not-appear"), "unknown header keys and values are omitted");
        check(exit.contains("[redacted]\n-- trace --") && exit.contains("LogPage.select(LogPage.java:88)"), "summary is hidden while a safe ANR Java frame remains");
        check(exit.contains("#00 pc 0000000000001a2b libdiagnostic.so (safeSymbol+12)"), "native pc, library basename, and safe symbol remain without path");
        for (String secret : new String[] { "Alice", "827361", "exit-secret", "/data/", "private.json", "Cmd line", "Authorization", "encoded" }) {
            check(!exit.contains(secret), "exit report omits synthetic free text: " + secret);
        }
    }

    private static void testDiagnosticHeaderRules() throws Exception {
        File root = cacheTemp("calendar-tab-r2-header-");
        try {
            final Map<String, String> fields = new LinkedHashMap<String, String>();
            fields.put("abi", "Alice Example");
            fields.put("version", "Student827361 (42)");
            fields.put("android", "Pixel 14 (API 34)");
            fields.put("webview", "com.Student827361.webview 1.2");
            fields.put("pid", "123456");
            fields.put("package", LogStore.PACKAGE_NAME);
            final AtomicReference<String> sinkText = new AtomicReference<String>();
            CrashLog.Handler handler = new CrashLog.Handler(null, new CrashLog.Sink() {
                @Override public void write(String fileName, String content) { sinkText.set(content); }
            }, new CrashLog.Header() {
                @Override public Map<String, String> collect() { return fields; }
            });
            RuntimeException handlerFailure = new RuntimeException("private crash detail");
            handlerFailure.setStackTrace(new StackTraceElement[] { new StackTraceElement("com.example.Crash", "run", "Crash.java", 12) });
            handler.uncaughtException(Thread.currentThread(), handlerFailure);
            String captured = sinkText.get();
            String handlerExpected = "wakeup-noads crash log\n"
                + "abi: [redacted]\nversion: [redacted]\nandroid: [redacted]\nwebview: [redacted]\n"
                + "pid: 123456\npackage: io.github.wakeupnoads\nthread: main\n\n"
                + "java.lang.RuntimeException: [redacted]\n\tat com.example.Crash.run(Crash.java:12)\n";
            check(handlerExpected.equals(captured), "real Handler/Sink output exactly matches hand-written safe diagnostics and stack expectation");

            String raw = "wakeup-noads exit log\n"
                + "abi: [arm64-v8a, armeabi-v7a]\n"
                + "version: v6.5.2-r4 (546123)\n"
                + "version: wakeup-noads-v6.5.4-r1 (543)\n"
                + "version: wakeup-noads-v6.5.4-r2 (546)\n"
                + "version: v6.5.4 (543)\n"
                + "version: 1.2.3 (42)\n"
                + "version: fake-wakeup-noads-v6.5.4-r1 (543)\n"
                + "version: wakeup-noads-v6.5.4-rx (543)\n"
                + "version: v827361 (42)\n"
                + "android: 14.1 (API 999)\n"
                + "webview: com.android.webview 129.0.6668.81\n"
                + "webview: com.google.android.webview 130.1\n"
                + "webview: com.android.chrome 131.2.3.4\n"
                + "version: Student827361 (42)\n"
                + "version: 1.2.3 (2147483648)\n"
                + "version: 1.2.3 (42) token=private\n"
                + "version: 1.2.3\u0085 (42)\n"
                + "version: 1.2.3" + (char) 1 + " (42)\n"
                + "version: 1.2.3-r12345 (42)\n"
                + "version: 1.23456 (42)\n"
                + "abi: [arm64-v8a, Alice Example]\n"
                + "abi: [arm64-v8a,]\n"
                + "abi: [arm64-v8a, arm64-v8a]\n"
                + "abi: x86_64\n"
                + "webview: com.Student827361.webview 1.2\n"
                + "webview: com.example.webview 129.0\n"
                + "android: 14 (API 1000)\n"
                + "pid: 123456\n"
                + "#00 pc 0000000000001a2b /data/app/private/libdiagnostic.so (safeSymbol+12)\n"
                + "model: Alice Example\n";
            String expected = "wakeup-noads exit log\n"
                + "abi: [arm64-v8a, armeabi-v7a]\n"
                + "version: v6.5.2-r4 (546123)\n"
                + "version: wakeup-noads-v6.5.4-r1 (543)\n"
                + "version: wakeup-noads-v6.5.4-r2 (546)\n"
                + "version: v6.5.4 (543)\n"
                + "version: 1.2.3 (42)\n"
                + "version: [redacted]\n"
                + "version: [redacted]\n"
                + "version: [redacted]\n"
                + "android: 14.1 (API 999)\n"
                + "webview: com.android.webview 129.0.6668.81\n"
                + "webview: com.google.android.webview 130.1\n"
                + "webview: com.android.chrome 131.2.3.4\n"
                + "version: [redacted]\n"
                + "version: [redacted]\n"
                + "version: [redacted]\n"
                + "version: [redacted]\n"
                + "version: [redacted]\n"
                + "version: [redacted]\n"
                + "version: [redacted]\n"
                + "abi: [redacted]\n"
                + "abi: [redacted]\n"
                + "abi: [arm64-v8a, arm64-v8a]\n"
                + "abi: x86_64\n"
                + "webview: [redacted]\n"
                + "webview: [redacted]\n"
                + "android: [redacted]\n"
                + "pid: 123456\n"
                + "#00 pc 0000000000001a2b libdiagnostic.so (safeSymbol+12)\n"
                + "[redacted]\n";
            String streamOutput = CrashLog.sanitizeText(raw);
            check(expected.equals(streamOutput), "shared sanitizer enforces fixed field rules while preserving six-digit versionCode/PID and native pc; expected="
                + expected.replace("\n", "\\n") + "; actual=" + streamOutput.replace("\n", "\\n"));
            check(expected.equals(CrashLog.sanitizeText(streamOutput)), "diagnostic normalization is idempotent");

            Map<String, String> publishedVersionHeader = new LinkedHashMap<String, String>();
            publishedVersionHeader.put("package", "io.github.wakeupnoads");
            publishedVersionHeader.put("version", "wakeup-noads-v6.5.4-r1 (543)");
            publishedVersionHeader.put("pid", "123456");
            final AtomicReference<String> publishedSink = new AtomicReference<String>();
            CrashLog.Handler publishedHandler = new CrashLog.Handler(null, new CrashLog.Sink() {
                @Override public void write(String fileName, String content) { publishedSink.set(content); }
            }, new CrashLog.Header() { @Override public Map<String, String> collect() { return publishedVersionHeader; } });
            RuntimeException publishedFailure = new RuntimeException("hidden message");
            publishedFailure.setStackTrace(new StackTraceElement[0]);
            publishedHandler.uncaughtException(Thread.currentThread(), publishedFailure);
            String publishedHandlerExpected = "wakeup-noads crash log\npackage: io.github.wakeupnoads\n"
                + "version: wakeup-noads-v6.5.4-r1 (543)\npid: 123456\nthread: main\n\n"
                + "java.lang.RuntimeException: [redacted]\n";
            check(publishedHandlerExpected.equals(publishedSink.get()), "the fixed published version prefix survives the real Handler/Sink with exact output");

            CrashLog.ExitRecord record = new CrashLog.ExitRecord(1_760_000_000_000L, CrashLog.REASON_CRASH, "summary hidden", null);
            record.trace = "    at com.example.Crash.run(Crash.java:12)\n";
            List<CrashLog.ExitRecord> records = Collections.singletonList(record);
            String exit = CrashLog.exitReport(fields, records);
            String exitExpected = "wakeup-noads exit log\n"
                + "abi: [redacted]\nversion: [redacted]\nandroid: [redacted]\nwebview: [redacted]\n"
                + "pid: 123456\npackage: io.github.wakeupnoads\n"
                + "\n== " + CrashLog.formatTime(record.timestamp) + " CRASH ==\n[redacted]\n-- trace --\n"
                + "\tat com.example.Crash.run(Crash.java:12)\n";
            check(exitExpected.equals(exit), "exitReport output exactly matches independent type-specific fields, summary, and safe-stack expectation");

            CrashLog.ExitRecord publishedRecord = new CrashLog.ExitRecord(1_760_000_000_001L, CrashLog.REASON_CRASH_NATIVE, "hidden native summary", null);
            publishedRecord.trace = "    at com.example.Native.run(Native.java:21)\n";
            String publishedExitExpected = "wakeup-noads exit log\npackage: io.github.wakeupnoads\n"
                + "version: wakeup-noads-v6.5.4-r1 (543)\npid: 123456\n"
                + "\n== " + CrashLog.formatTime(publishedRecord.timestamp) + " CRASH_NATIVE ==\n[redacted]\n-- trace --\n"
                + "\tat com.example.Native.run(Native.java:21)\n";
            check(publishedExitExpected.equals(CrashLog.exitReport(publishedVersionHeader, Collections.singletonList(publishedRecord))),
                "the fixed published version prefix survives exitReport with exact independent header and safe-trace expectation");

            File productDirectory = new File(root, "published-product");
            check(productDirectory.mkdirs(), "published-version product-read fixture directory is created");
            FixtureSource productSource = new FixtureSource("app", "应用目录", productDirectory);
            String publishedRaw = "wakeup-noads crash log\n"
                + "package: io.github.wakeupnoads\n"
                + "version: wakeup-noads-v6.5.4-r1 (543)\n"
                + "version: fake-wakeup-noads-v6.5.4-r1 (543)\n"
                + "pid: 123456\nthread: main\n\n"
                + "java.lang.RuntimeException: private message\n"
                + "\tat com.example.Crash.run(Crash.java:12)\n";
            String publishedProductExpected = "wakeup-noads crash log\n"
                + "package: io.github.wakeupnoads\n"
                + "version: wakeup-noads-v6.5.4-r1 (543)\n"
                + "version: [redacted]\npid: 123456\nthread: main\n\n"
                + "java.lang.RuntimeException: [redacted]\n"
                + "\tat com.example.Crash.run(Crash.java:12)\n";
            LogStore.Entry productEntry = productSource.add("crash-20261012-010204-001-12.txt", 1L, publishedRaw);
            LogStore productStore = new LogStore(Collections.<LogStore.Source>singletonList(productSource));
            check(publishedProductExpected.equals(productStore.preview(productEntry).text)
                && publishedProductExpected.equals(productStore.copyText(productEntry).text),
                "real Store preview/copy preserve the fixed published version and reject a pseudo-prefix against an independent expected body");
            File productSnapshot = productStore.snapshot(productEntry, root);
            try {
                check(Arrays.equals(publishedProductExpected.getBytes("UTF-8"), Files.readAllBytes(productSnapshot.toPath())),
                    "real Store snapshot keeps the published version and safe stack without the pseudo-prefix or message");
            } finally { LogPage.deleteSnapshotForTest(productSnapshot); }
            Object productOwner = new Object();
            ManualHost productHost = new ManualHost();
            LogPage.Controller productController = new LogPage.Controller(productOwner, productStore, productHost);
            readyController(productController, productHost, productEntry);
            check(publishedProductExpected.equals(lastState(productHost.states).preview),
                "real Controller selection renders the same independently expected safe version header");
            productController.copySelected(); productHost.runAllIo();
            check(publishedProductExpected.equals(productHost.copied), "real Controller clipboard receives the complete expected safe product body");
            productController.exportSelected(root); productHost.runNextIo();
            check(productController.onActivityResult(productOwner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content")),
                "real Controller accepts the matching product URI after preparing the complete snapshot");
            productHost.runAllIo();
            check(productHost.target != null && Arrays.equals(publishedProductExpected.getBytes("UTF-8"), productHost.target.toByteArray())
                && productHost.toasts.contains("导出成功"), "real Controller target write retains only the independent safe product expected bytes");
            productController.close();

            File automatic = CrashLog.writeAutomaticLog(new File(root, "external"),
                "crash-20261012-010203-004-12.txt", raw);
            String automaticText = new String(Files.readAllBytes(automatic.toPath()), "UTF-8");
            check(expected.equals(automaticText) && !automaticText.contains("Student827361")
                && !automaticText.contains("Alice Example"), "automatic on-disk writing applies the shared sanitizer at the sink boundary");

            ByteArrayOutputStream streamed = new ByteArrayOutputStream();
            CrashLog.writeSanitized(new ByteArrayInputStream(raw.getBytes("UTF-8")), streamed);
            check(Arrays.equals(expected.getBytes("UTF-8"), streamed.toByteArray()), "shared stream entry uses independent full output expectation");
        } finally { deleteTree(root); }
    }

    private static void testSanitizerStreamingAndLineBoundaries() throws Exception {
        String secret = "827361";
        String base64 = java.util.Base64.getEncoder().encodeToString("student=827361 password=secret".getBytes("UTF-8"));
        String raw = "wakeup-noads crash log\r\npackage: io.github.wakeupnoads\r\nthread: main\r\n"
            + "java.lang.RuntimeException: Alice student=" + secret + " Authorization: Bearer T0PSECRET\r\n"
            + "\tat com.example.Service.call(Service.java:17)\r\n"
            + "{" + "\"name\":\"Alice\",\"Authorization\":\"Bearer T0PSECRET\"}" + "\r\n"
            + "url=https%3A%2F%2Fprivate.invalid%2Fuser%2Falice%3Ftoken%3Dabc\r\n"
            + "Set-Cookie: sid=sensitive-session\r\nTOKEN=top-secret-token SESSION=session-private JWT=jwt-private API_KEY=key-private\r\n"
            + "Account=alice-account ID=987654321 Phone=13800138000 email=alice@example.invalid\r\n"
            + "form:name=Alice&student=827361&password=pass-private\r\nencoded=" + base64 + "\r\n"
            + "<html><body>student 827361</body></html>\n"
            + "file: /storage/emulated/0/Download/alice.txt\n"
            + "free text 含中文和🙂表情\n";
        String expected = CrashLog.sanitizeText(raw);
        ByteArrayOutputStream streamed = new ByteArrayOutputStream();
        CrashLog.writeSanitized(new FragmentedInputStream(raw.getBytes("UTF-8"), 3), streamed);
        String actual = new String(streamed.toByteArray(), "UTF-8");
        check(actual.equals(expected), "string and split-chunk UTF-8 stream entry points share one result");
        check(actual.equals(CrashLog.sanitizeText(actual)), "sanitized reports are idempotent");
        check(actual.contains("java.lang.RuntimeException: [redacted]") && actual.contains("Service.call(Service.java:17)"), "exception type and safe stack frame survive legacy parsing");
        for (String value : new String[] { "Alice", secret, "T0PSECRET", "private.invalid", "sensitive-session", base64,
            "Download", "Authorization", "<html>", "alice-account", "987654321", "13800138000", "alice@example.invalid",
            "top-secret-token", "session-private", "jwt-private", "key-private", "pass-private", "中文", "🙂" }) {
            check(!actual.contains(value), "streaming sanitizer removes source and encoded value: " + value);
        }
        String fakeMarker = "[redacted] student=827361 password=secret";
        check(CrashLog.sanitizeText(fakeMarker).equals("[redacted]"), "a forged redaction label cannot carry adjacent source text through");

        StringBuilder longLine = new StringBuilder("prefix-secret-");
        while (longLine.length() <= 16 * 1024 + 7) longLine.append('x');
        longLine.append("-suffix-secret\njava.lang.IllegalStateException: kept-frame\n");
        String longOutput = CrashLog.sanitizeText(longLine.toString());
        check(longOutput.startsWith("[redacted]\n"), "an overlong line is replaced from its start rather than leaking a prefix");
        check(!longOutput.contains("prefix-secret") && !longOutput.contains("suffix-secret"), "overlong-line source is absent");
        check(longOutput.contains("java.lang.IllegalStateException: [redacted]"), "streaming resumes after an overlong line");

        byte[] invalidUtf8 = new byte[] { 'u', 'n', 'k', 'n', 'o', 'w', 'n', ':', (byte) 0xc3, 0x28, '\n' };
        ByteArrayOutputStream invalidOutput = new ByteArrayOutputStream();
        CrashLog.writeSanitized(new FragmentedInputStream(invalidUtf8, 1), invalidOutput);
        check(new String(invalidOutput.toByteArray(), "UTF-8").equals("[redacted]\n"), "invalid UTF-8 is replacement-decoded then sanitized");
    }

    private static void testLogStoreFiltersAndSanitizesEveryReadPath() throws Exception {
        File root = cacheTemp("calendar-tab-store-");
        try {
            File appRoot = new File(root, "current");
            File legacyRoot = new File(root, "Download/wakeup-noads");
            check(appRoot.mkdirs() && legacyRoot.mkdirs(), "fixture app and legacy roots are created inside tools cache");
            FixtureSource app = new FixtureSource("app", "injected-private-label", appRoot);
            FixtureSource legacy = new FixtureSource("legacy-download", "untrusted legacy label", legacyRoot);
            String duplicateName = "crash-20261012-010203-004-12.txt";
            app.add(duplicateName, 1000L, "package: io.github.wakeupnoads\njava.lang.RuntimeException: student=827361 password=s3cret\n");
            legacy.add(duplicateName, 1000L, "package: io.github.wakeupnoads\njava.lang.RuntimeException: student=827361 password=s3cret\n");
            app.add("exit-20261012-010204-004-12.txt", 2000L, "wakeup-noads exit log\n");
            app.add("not-a-log.txt", 3000L, "must-not-list\n");
            app.addOutside("crash-20261012-010205-004-12.txt", 4000L, "outside-root\n", root);
            LogStore store = new LogStore(Arrays.<LogStore.Source>asList(app, legacy));
            LogStore.Result listed = store.list();
            check(listed.entries.size() == 3, "production list filtering excludes non-log names and canonical paths outside the source root");
            check(listed.entries.get(0).fileName.startsWith("exit-") && listed.entries.get(1).sourceKey.equals("app")
                && listed.entries.get(2).sourceKey.equals("legacy-download"), "list is reverse-time and stable by source key for same-named entries");
            check(!listed.entries.get(1).key.equals(listed.entries.get(2).key), "same-named files retain distinct source keys");
            String smallExpected = "package: io.github.wakeupnoads\njava.lang.RuntimeException: [redacted]\n";
            LogStore.Preview currentPreview = store.preview(listed.entries.get(1));
            LogStore.CopyText currentCopy = store.copyText(listed.entries.get(1));
            check(smallExpected.equals(currentPreview.text) && smallExpected.equals(currentCopy.text),
                "history preview and copy match a hand-written complete small-log expectation");
            File smallSnapshot = store.snapshot(listed.entries.get(1), root);
            try { check(Arrays.equals(smallExpected.getBytes("UTF-8"), Files.readAllBytes(smallSnapshot.toPath())),
                "small full snapshot matches the independent sanitized expectation"); }
            finally { LogPage.deleteSnapshotForTest(smallSnapshot); }
            LogStore.Preview legacyPreview = store.preview(listed.entries.get(2));
            check(legacyPreview.text.contains("java.lang.RuntimeException: [redacted]") && !legacyPreview.text.contains("827361"), "historical Download content uses the same production sanitizer as current logs");
            check(LogStore.validMediaMetadata(LogStore.PACKAGE_NAME, "Download/wakeup-noads/", duplicateName, "content"), "MediaStore metadata accepts the current package and bounded path");
            check(!LogStore.validMediaMetadata("other.package", "Download/wakeup-noads/", duplicateName, "content"), "MediaStore metadata rejects other owners");
            check(!LogStore.validMediaMetadata(LogStore.PACKAGE_NAME, "Download/other/", duplicateName, "content"), "MediaStore metadata rejects paths outside Download/wakeup-noads");
            check(LogStore.validLegacyMetadata(LogStore.PACKAGE_NAME, "Download/wakeup-noads", duplicateName), "legacy metadata accepts the historical package path");
            check(!LogStore.validLegacyMetadata(LogStore.PACKAGE_NAME, "Download/wakeup-noads/child", duplicateName), "legacy metadata rejects nested paths");

            FixtureSource empty = new FixtureSource("app", "ignored", new File(root, "empty"));
            LogStore.Result emptyResult = new LogStore(Collections.<LogStore.Source>singletonList(empty)).list();
            check(emptyResult.isEmpty() && "暂无日志".equals(emptyResult.stateText()), "a readable empty source is distinct from an error");
            FixtureSource unavailable = new FixtureSource("legacy-download", "untrusted", legacyRoot);
            unavailable.unavailableMessage = "/storage/alice permission token=private";
            LogStore.Result unavailableResult = new LogStore(Collections.<LogStore.Source>singletonList(unavailable)).list();
            check(unavailableResult.hasErrors() && "日志来源不可读取".equals(unavailableResult.stateText()), "unavailable and permission-failure states are fixed and do not expose adapter text");
            check(!unavailableResult.sourceErrors.get(0).contains("/storage") && !unavailableResult.sourceErrors.get(0).contains("private"), "source classification hides raw location details");
            FixtureSource failing = new FixtureSource("legacy-download", "untrusted", legacyRoot);
            failing.scanFailure = new IOException("/storage/user/alice?token=secret");
            LogStore.Result failed = new LogStore(Collections.<LogStore.Source>singletonList(failing)).list();
            check(failed.hasErrors() && !failed.sourceErrors.get(0).contains("/storage") && !failed.sourceErrors.get(0).contains("token=secret"), "source errors use a fixed category and never expose exception messages");
            check("读取失败（java.io.IOException）".equals(LogStore.shortError(failing.scanFailure)), "shortError returns a fixed category and validated exception type");

            StringBuilder longSafe = new StringBuilder("wakeup-noads crash log\nabi: Alice Example\nversion: Student827361 (42)\npackage: io.github.wakeupnoads\n");
            for (int index = 0; index < 9000; index++) longSafe.append("\tat com.example.Diagnostic.run(Diagnostic.java:12)\n");
            longSafe.append("student=827361 password=snapshot-secret\n");
            FixtureSource large = new FixtureSource("app", "应用目录", appRoot);
            LogStore.Entry largeEntry = large.add("crash-20261012-010206-004-12.txt", 5000L, longSafe.toString());
            byte[] sourceBefore = Files.readAllBytes(((File) largeEntry.handle).toPath());
            LogStore largeStore = new LogStore(Collections.<LogStore.Source>singletonList(large));
            LogStore.Preview preview = largeStore.preview(largeEntry);
            check(preview.truncated && preview.text.getBytes("UTF-8").length <= LogStore.PREVIEW_LIMIT + "\n[truncated]\n".getBytes("UTF-8").length,
                "preview truncates only after sanitized UTF-8 bytes reach 256 KiB");
            LogStore.CopyText copied = largeStore.copyText(largeEntry);
            check(copied.truncated && copied.text.getBytes("UTF-8").length <= LogStore.COPY_LIMIT, "clipboard text includes a marker within its 64 KiB total budget");
            StringBuilder expectedBuilder = new StringBuilder("wakeup-noads crash log\nabi: [redacted]\nversion: [redacted]\npackage: io.github.wakeupnoads\n");
            for (int index = 0; index < 9000; index++) expectedBuilder.append("\tat com.example.Diagnostic.run(Diagnostic.java:12)\n");
            expectedBuilder.append("[redacted]\n");
            String expected = expectedBuilder.toString();
            byte[] expectedBytes = expected.getBytes("UTF-8");
            String expectedPreview = new String(expectedBytes, 0, LogStore.PREVIEW_LIMIT, "UTF-8") + "\n[truncated]\n";
            int markerBytes = "\n[truncated]\n".getBytes("UTF-8").length;
            String expectedCopy = new String(expectedBytes, 0, LogStore.COPY_LIMIT - markerBytes, "UTF-8") + "\n[truncated]\n";
            check(expectedPreview.equals(preview.text) && expectedCopy.equals(copied.text),
                "large historical preview and copy exactly match independently constructed UTF-8 prefixes and marker budgets");
            RecordingOutput recordedSnapshot = new RecordingOutput();
            LogStore.writeSanitizedSnapshot(new ByteArrayInputStream(longSafe.toString().getBytes("UTF-8")), recordedSnapshot);
            check(recordedSnapshot.allWritesSafe("snapshot-secret", "827361", "Alice Example", "Student827361"), "every production snapshot transform write and cumulative content are already sanitized");
            check(Arrays.equals(expected.getBytes("UTF-8"), recordedSnapshot.toByteArray()), "snapshot stream output is the complete sanitized UTF-8 result");
            File largeAutomatic = CrashLog.writeAutomaticLog(new File(root, "external-large"),
                "exit-20261012-010206-004-12.txt", longSafe.toString());
            check(Arrays.equals(expectedBytes, Files.readAllBytes(largeAutomatic.toPath())),
                "large automatic sink output matches an independently constructed complete UTF-8 expectation");
            File snapshot = largeStore.snapshot(largeEntry, root);
            try {
                check(Arrays.equals(expected.getBytes("UTF-8"), Files.readAllBytes(snapshot.toPath())), "full snapshot bypasses preview and clipboard limits but stays sanitized");
                check(!new String(Files.readAllBytes(snapshot.toPath()), "UTF-8").contains("snapshot-secret"), "snapshot never persists source text");
            } finally { LogPage.deleteSnapshotForTest(snapshot); }
            check(Arrays.equals(sourceBefore, Files.readAllBytes(((File) largeEntry.handle).toPath())), "historical/source bytes remain unchanged after view, copy, and snapshot");

            LogStore.Entry missing = largeEntry;
            check(((File) missing.handle).delete(), "fixture entry is removed to model a disappeared source");
            boolean missingFailed = false;
            try { largeStore.preview(missing); } catch (IOException expectedFailure) { missingFailed = true; }
            check(missingFailed, "a disappeared file reports read failure rather than an empty preview");

            final LogStore.Source ioFail = new LogStore.Source() {
                @Override public String key() { return "app"; }
                @Override public String label() { return "app"; }
                @Override public LogStore.Scan scan() { return LogStore.Scan.readable(Collections.<LogStore.Entry>emptyList()); }
                @Override public InputStream open(LogStore.Entry entry) { return new InputStream() {
                    private int index;
                    private final byte[] prefix = "wakeup-noads crash log\npassword=must-not-leak\n".getBytes(Charset.forName("UTF-8"));
                    @Override public int read() throws IOException { if (index >= prefix.length) throw new IOException("secret-source-error"); return prefix[index++]; }
                }; }
            };
            File failedTargetRoot = new File(root, LogStore.EXPORT_FOLDER);
            boolean snapshotFailure = false;
            try { new LogStore(Collections.singletonList(ioFail)).snapshot(
                new LogStore.Entry("app:broken", "app", "应用目录", duplicateName, 1, ioFail,
                    new File(appRoot, duplicateName), appRoot, LogStore.PACKAGE_NAME, CrashLog.LOG_DIRECTORY, null), root); }
            catch (IOException expectedFailure) { snapshotFailure = true; }
            check(snapshotFailure, "stream transformation failure aborts snapshot creation");
            File[] remaining = failedTargetRoot.listFiles();
            check(remaining == null || remaining.length == 0, "failed snapshot is removed instead of falling back to source bytes");
            check(large.closedInputs >= 3, "preview, copy, and snapshot close their source streams on success");
        } finally { deleteTree(root); }
    }

    private static void testLegacyDownloadHeaderOwnership() throws Exception {
        File root = cacheTemp("calendar-tab-r2-legacy-");
        try {
            File directory = new File(root, "Download/wakeup-noads");
            check(directory.mkdirs(), "legacy Download root fixture is created in tools cache");
            LogStore.LegacyDownloadSource source = new LogStore.LegacyDownloadSource(directory);
            String[] names = new String[] {
                "crash-20261012-010301-001-12.txt", "exit-20261012-010302-002-12.txt",
                "crash-20261012-010303-003-12.txt", "crash-20261012-010304-004-12.txt",
                "crash-20261012-010305-005-12.txt", "crash-20261012-010306-006-12.txt",
                "crash-20261012-010307-007-12.txt", "crash-20261012-010308-008-12.txt",
                "crash-20261012-010309-009-12.txt", "crash-20261012-010310-010-12.txt",
                "crash-20261012-010311-011-12.txt", "crash-20261012-010312-012-12.txt",
                "crash-20261012-010313-013-12.txt"
            };
            String[] contents = new String[] {
                "package: io.github.wakeupnoads\nthread: main\n\nbody\n",
                "wakeup-noads exit log\r\npackage:\t io.github.wakeupnoads \t\r\nthread: main\r\n\r\nbody\r\n",
                "package: ioXgithubXwakeupnoads\n\nbody\n",
                "package: other.package\n\nbody\n",
                "package: prefix.io.github.wakeupnoads\n\nbody\n",
                "package: io.github.wakeupnoads.suffix\n\nbody\n",
                "package: io.github.wakeupnoads\npackage: other.package\n\nbody\n",
                "title\n\npackage: io.github.wakeupnoads\n",
                "title\nthread: main\n\nbody with package: io.github.wakeupnoads\n",
                "title\n",
                "package: io.github.wakeupnoads\u0001\n\nbody\n",
                "title\npackage: io.github.wakeupnoads",
                "package: io.github.wakeupnoads\npackage: io.github.wakeupnoads\n\nbody\n"
            };
            File truncated = new File(directory, names[11]);
            StringBuilder incomplete = new StringBuilder(contents[11]);
            while (incomplete.length() <= 16 * 1024 + 16) incomplete.append('x');
            for (int index = 0; index < names.length - 1; index++) writeUtf8(new File(directory, names[index]), contents[index]);
            writeUtf8(truncated, incomplete.toString());
            writeUtf8(new File(directory, names[12]), contents[12]);
            byte[] before = Files.readAllBytes(new File(directory, names[0]).toPath());

            LogStore.Scan scan = source.scan();
            check(scan.accessible && scan.entries.size() == 2, "real legacy scan accepts only complete, exact package rows");
            check(scan.entries.get(0).fileName.equals(names[0]) || scan.entries.get(0).fileName.equals(names[1]),
                "accepted entries come from the two exact owner headers");
            for (LogStore.Entry entry : scan.entries) {
                InputStream input = source.open(entry);
                input.close();
                boolean closed = false;
                try { input.read(); } catch (IOException expected) { closed = true; }
                check(closed, "real legacy open stream closes after use");
            }
            check(Arrays.equals(before, Files.readAllBytes(new File(directory, names[0]).toPath())),
                "legacy listing and reading do not rewrite source bytes");

            LogStore.Entry listed = scan.entries.get(0);
            File listedFile = (File) listed.handle;
            writeUtf8(listedFile, "package: ioXgithubXwakeupnoads\n\nchanged\n");
            boolean revalidated = false;
            try { source.open(listed); } catch (IOException expected) { revalidated = true; }
            check(revalidated, "legacy open rechecks package ownership after a listed file changes");
        } finally { deleteTree(root); }
    }

    private static void testLogPageControllerCopiesAndExportsSanitizedSnapshot() throws Exception {
        File root = cacheTemp("calendar-tab-page-");
        try {
            File directory = new File(root, "logs");
            check(directory.mkdirs(), "LogPage test source directory is created");
            FixtureSource source = new FixtureSource("app", "应用目录", directory);
            LogStore.Entry small = source.add("crash-20261012-010207-004-12.txt", 1000L,
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\njava.lang.RuntimeException: student=827361 password=small-secret\n");
            StringBuilder bigText = new StringBuilder("wakeup-noads crash log\npackage: io.github.wakeupnoads\nabi: Alice Example\nversion: Student827361 (42)\nwebview: com.Student827361.webview 1.2\n");
            for (int index = 0; index < 1800; index++) bigText.append("\tat com.example.Export.run(Export.java:12)\n");
            bigText.append("Authorization: Bearer export-secret\n");
            LogStore.Entry big = source.add("exit-20261012-010208-004-12.txt", 2000L, bigText.toString());
            StringBuilder expectedBigBuilder = new StringBuilder("wakeup-noads crash log\npackage: io.github.wakeupnoads\nabi: [redacted]\nversion: [redacted]\nwebview: [redacted]\n");
            for (int index = 0; index < 1800; index++) expectedBigBuilder.append("\tat com.example.Export.run(Export.java:12)\n");
            expectedBigBuilder.append("[redacted]\n");
            String expectedBig = expectedBigBuilder.toString();
            LogStore store = new LogStore(Collections.<LogStore.Source>singletonList(source));
            Object owner = new Object();
            ManualHost host = new ManualHost();
            LogPage.Controller controller = new LogPage.Controller(owner, store, host);
            controller.present(); host.runAllIo();
            check(host.opened && host.states.get(host.states.size() - 1).result.entries.size() == 2, "controller loads a list through LogStore on its I/O executor");
            controller.select(small); host.runAllIo();
            String smallExpected = "wakeup-noads crash log\npackage: io.github.wakeupnoads\njava.lang.RuntimeException: [redacted]\n";
            check(smallExpected.equals(host.states.get(host.states.size() - 1).preview), "detail state matches the independent small-log sanitized expectation");
            controller.copySelected(); host.runAllIo();
            check(smallExpected.equals(host.copied), "small clipboard output matches the independent sanitized expectation");
            check(host.toasts.contains("已复制"), "copy success is reported only after clipboard write succeeds");

            host.failCopy = true;
            controller.copySelected(); host.runAllIo();
            check(!host.toasts.contains("复制失败：small-secret") && host.toasts.contains("复制失败"), "copy failure does not expose exception text or claim success");
            host.failCopy = false;
            controller.select(big); host.runAllIo();
            byte[] expectedBigBytes = expectedBig.getBytes("UTF-8");
            check(expectedBig.equals(host.states.get(host.states.size() - 1).preview),
                "large controller preview exactly matches the independently constructed complete output under the preview limit");
            controller.copySelected(); host.runAllIo();
            int copyMarkerBytes = "\n[truncated]\n".getBytes("UTF-8").length;
            String expectedBigCopy = new String(expectedBigBytes, 0, LogStore.COPY_LIMIT - copyMarkerBytes, "UTF-8") + "\n[truncated]\n";
            check(expectedBigCopy.equals(host.copied) && host.copied.getBytes("UTF-8").length == LogStore.COPY_LIMIT,
                "large controller copy matches independent sanitized bytes within the exact 64 KiB marker budget");

            controller.exportSelected(root);
            controller.exportSelected(root);
            check(host.io.size() == 1, "repeat export taps while preparing do not create a second snapshot request");
            host.runAllIo();
            check(host.launchCount == 1 && host.requestCode == LogPage.EXPORT_REQUEST_CODE, "complete snapshot launches one local document request with the fixed request code");
            check(host.title.equals("wakeup-noads-" + big.fileName), "export title is based on the frozen selected filename");
            controller.select(small); host.runAllIo();
            check(!controller.onActivityResult(new Object(), LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content")), "a different host cannot consume another fragment's pending export");
            check(host.target == null && host.cacheFiles(root).length == 1, "rejected host leaves the frozen pending snapshot untouched");
            check(!controller.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE + 1, LogPage.RESULT_OK, new FakeUri("content")), "unrelated request codes are ignored");
            check(controller.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content")), "matching request accepts only its own content URI");
            host.runAllIo();
            check(Arrays.equals(expectedBigBytes, host.target.toByteArray()), "target output is the full sanitized snapshot even after selection changes");
            check(host.target.allWritesSafe("export-secret", "Authorization", "Alice Example", "Student827361", "com.Student827361.webview"), "every target stream write and cumulative output contains sanitized text only");
            check(host.target.closed && !host.toasts.contains("导出成功"), "stale A export closes successfully without a success toast after selection changes");
            check(host.deletedTargets == 0, "successful target is not deleted");
            controller.close();
            check(host.dismissed, "closing the controller dismisses its page host");
        } finally { deleteTree(root); }
    }

    private static void testLogPageFailuresAndBridgeAbi() throws Exception {
        java.lang.reflect.Method bind = LogPage.class.getMethod("bind", Object.class, Object.class);
        java.lang.reflect.Method show = LogPage.class.getMethod("show", Object.class);
        java.lang.reflect.Method result = LogPage.class.getMethod("onActivityResult", Object.class, int.class, int.class, Object.class);
        java.lang.reflect.Method close = LogPage.class.getMethod("close", Object.class);
        check(bind.getReturnType() == void.class && show.getReturnType() == void.class && close.getReturnType() == void.class
            && result.getReturnType() == void.class, "four public bridges retain the Smali ABI parameter and return signatures");
        check(bind.getParameterTypes().length == 2 && result.getParameterTypes().length == 4, "bridge arity is fixed");
        check(LogPage.class.getMethod("isLogActivity", Object.class).getReturnType() == boolean.class
            && LogPage.class.getMethod("prepareActivity", Object.class).getReturnType() == void.class
            && LogPage.class.getMethod("attachActivity", Object.class).getReturnType() == void.class
            && LogPage.class.getMethod("onBackPressed", Object.class).getReturnType() == boolean.class
            && LogPage.class.getMethod("onDestroy", Object.class).getReturnType() == void.class
            && LogPage.class.getMethod("applyPageInsets", Object.class, Object.class, Object.class).getReturnType() == void.class,
            "all six Activity-owned bridges keep their exact public Object-only signatures");
        check("日志已脱敏".equals(LogPage.SANITIZED_NOTICE), "the static page notice states that every displayed log is sanitized");

        File root = cacheTemp("calendar-tab-page-fail-");
        try {
            File directory = new File(root, "logs"); check(directory.mkdirs(), "failure fixture source directory is created");
            FixtureSource source = new FixtureSource("app", "应用目录", directory);
            LogStore.Entry entry = source.add("crash-20261012-010209-004-12.txt", 1000L,
                "wakeup-noads crash log\njava.lang.RuntimeException: secret-source\n");
            LogStore store = new LogStore(Collections.<LogStore.Source>singletonList(source));
            Object owner = new Object();
            ManualHost cancelledHost = new ManualHost();
            LogPage.Controller cancelled = new LogPage.Controller(owner, store, cancelledHost);
            cancelled.present(); cancelledHost.runAllIo(); cancelled.select(entry); cancelledHost.runAllIo();
            cancelled.exportSelected(root); cancelledHost.runAllIo();
            check(cancelledHost.launchCount == 1 && cancelledHost.cacheFiles(root).length == 1, "pending SAF choice retains exactly one sanitized module snapshot");
            check(cancelled.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, 0, null), "matching cancelled SAF result is consumed");
            check(cancelledHost.cacheFiles(root).length == 0 && !cancelledHost.toasts.contains("导出成功"), "cancel deletes the sanitized snapshot without success");
            check("已取消导出".equals(cancelledHost.states.get(cancelledHost.states.size() - 1).message), "cancel returns to the page with a fixed cancellation state");

            ManualHost invalidHost = new ManualHost();
            LogPage.Controller invalid = new LogPage.Controller(owner, store, invalidHost);
            invalid.present(); invalidHost.runAllIo(); invalid.select(entry); invalidHost.runAllIo(); invalid.exportSelected(root); invalidHost.runAllIo();
            check(invalid.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("file")), "non-content result is consumed and rejected");
            check(invalidHost.target == null && invalidHost.toasts.contains("未获得可写入的文件位置，未导出日志"), "invalid URI produces no write and a fixed safe error");

            ManualHost nullUriHost = new ManualHost();
            LogPage.Controller nullUri = new LogPage.Controller(owner, store, nullUriHost);
            readyController(nullUri, nullUriHost, entry); nullUri.exportSelected(root); nullUriHost.runNextIo();
            check(nullUri.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, null)
                && nullUriHost.openedTargets == 0 && nullUriHost.toasts.contains("未获得可写入的文件位置，未导出日志"),
                "RESULT_OK with a null URI is a fixed failure and never opens a target");
            nullUri.close();

            ManualHost noPickerHost = new ManualHost(); noPickerHost.failLaunch = true;
            LogPage.Controller noPicker = new LogPage.Controller(owner, store, noPickerHost);
            noPicker.present(); noPickerHost.runAllIo(); noPicker.select(entry); noPickerHost.runAllIo(); noPicker.exportSelected(root); noPickerHost.runAllIo();
            check(noPickerHost.cacheFiles(root).length == 0 && !noPickerHost.toasts.contains("导出成功"), "missing picker removes the snapshot and never reports success");
            check(noPickerHost.states.get(noPickerHost.states.size() - 1).message.equals("系统文件选择器不可用"), "picker error is a fixed message without URI or exception text");

            ManualHost closedPendingHost = new ManualHost();
            LogPage.Controller closedPending = new LogPage.Controller(owner, store, closedPendingHost);
            closedPending.present(); closedPendingHost.runAllIo(); closedPending.select(entry); closedPendingHost.runAllIo();
            closedPending.exportSelected(root); closedPendingHost.runAllIo();
            check(closedPendingHost.cacheFiles(root).length == 1, "pending request owns one sanitized snapshot until closure");
            closedPending.close();
            closedPendingHost.runAllCancellation();
            check(closedPendingHost.cacheFiles(root).length == 0, "closing while the SAF chooser is pending removes the module snapshot");

            ManualHost writeFailureHost = new ManualHost(); writeFailureHost.failTargetWrite = true;
            LogPage.Controller writeFailure = new LogPage.Controller(owner, store, writeFailureHost);
            writeFailure.present(); writeFailureHost.runAllIo(); writeFailure.select(entry); writeFailureHost.runAllIo(); writeFailure.exportSelected(root); writeFailureHost.runAllIo();
            writeFailure.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content")); writeFailureHost.runAllIo();
            check(writeFailureHost.deletedTargets == 1 && !writeFailureHost.toasts.contains("导出成功"), "failed target write attempts cleanup and does not report success");
            check(writeFailureHost.target.allWritesSafe("secret-source"), "even partial target writes contain no original source bytes");
            check(!last(writeFailureHost.toasts).contains("path") && !last(writeFailureHost.toasts).contains("uri"), "target failure text is fixed and carries no destination metadata");

            ManualHost closeFailureHost = new ManualHost(); closeFailureHost.failTargetClose = true;
            LogPage.Controller closeFailure = new LogPage.Controller(owner, store, closeFailureHost);
            closeFailure.present(); closeFailureHost.runAllIo(); closeFailure.select(entry); closeFailureHost.runAllIo(); closeFailure.exportSelected(root); closeFailureHost.runAllIo();
            closeFailure.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content")); closeFailureHost.runAllIo();
            check(closeFailureHost.deletedTargets == 1 && !closeFailureHost.toasts.contains("导出成功"), "target close failure is treated as export failure and cleaned");

            ManualHost targetOpenHost = new ManualHost(); targetOpenHost.failTargetOpen = true;
            LogPage.Controller targetOpen = new LogPage.Controller(owner, store, targetOpenHost);
            readyController(targetOpen, targetOpenHost, entry); targetOpen.exportSelected(root); targetOpenHost.runNextIo();
            targetOpen.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content")); targetOpenHost.runAllIo();
            check(targetOpenHost.deletedTargets == 1 && !targetOpenHost.toasts.contains("导出成功")
                && last(targetOpenHost.toasts).equals("导出失败，源日志未修改"),
                "target open exception triggers cleanup and a fixed non-residual failure result");

            ManualHost nullTargetHost = new ManualHost(); nullTargetHost.nullTarget = true;
            LogPage.Controller nullTarget = new LogPage.Controller(owner, store, nullTargetHost);
            readyController(nullTarget, nullTargetHost, entry); nullTarget.exportSelected(root); nullTargetHost.runNextIo();
            nullTarget.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content")); nullTargetHost.runAllIo();
            check(nullTargetHost.deletedTargets == 1 && !nullTargetHost.toasts.contains("导出成功"),
                "null target output is a failure and receives cleanup");

            ManualHost deleteFailureHost = new ManualHost(); deleteFailureHost.failTargetWrite = true; deleteFailureHost.deleteSucceeds = false;
            LogPage.Controller deleteFailure = new LogPage.Controller(owner, store, deleteFailureHost);
            readyController(deleteFailure, deleteFailureHost, entry); deleteFailure.exportSelected(root); deleteFailureHost.runNextIo();
            deleteFailure.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content")); deleteFailureHost.runAllIo();
            check(deleteFailureHost.deletedTargets == 1
                && last(deleteFailureHost.toasts).equals("导出失败，可能留下不完整文件，请检查所选位置"),
                "a false target delete result is classified separately as possible residual content");

            ManualHost lostHost = new ManualHost();
            LogPage.Controller lost = new LogPage.Controller(owner, store, lostHost);
            lost.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content"));
            check(lostHost.toasts.contains("导出已中断，请重新选择日志导出"), "result without its pending snapshot is reported as interrupted");

            ManualHost staleHost = new ManualHost();
            LogPage.Controller stale = new LogPage.Controller(owner, store, staleHost);
            stale.present(); staleHost.runAllIo(); stale.select(entry);
            int renders = staleHost.states.size(); stale.close(); staleHost.runAllIo();
            check(staleHost.states.size() == renders && staleHost.dismissed, "queued result after close is discarded and cannot redraw the old page");
        } finally { deleteTree(root); }
    }

    private static void testExportSessionCancellationAndStaleResults() throws Exception {
        File root = cacheTemp("calendar-tab-r2-session-");
        try {
            File directory = new File(root, "logs"); check(directory.mkdirs(), "session source root is created");
            FixtureSource source = new FixtureSource("app", "应用目录", directory);
            LogStore.Entry a = source.add("crash-20261012-010401-001-12.txt", 2000L,
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\njava.lang.RuntimeException: a-secret\n");
            LogStore.Entry b = source.add("exit-20261012-010402-002-12.txt", 1000L,
                "wakeup-noads exit log\npackage: io.github.wakeupnoads\n");
            LogStore store = new LogStore(Collections.<LogStore.Source>singletonList(source));

            Object owner = new Object();
            ManualHost host = new ManualHost();
            LogPage.Controller controller = new LogPage.Controller(owner, store, host);
            readyController(controller, host, a);
            controller.exportSelected(root); host.runNextIo();
            check(host.launchCount == 1 && host.cacheFiles(root).length == 1, "preparation reaches one selector with one registered snapshot");
            check(controller.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content")), "the matching URI enters WRITING");
            check(host.io.size() == 1 && host.states.get(host.states.size() - 1).exportPending, "URI acceptance keeps the session busy while its write is queued");
            controller.exportSelected(root);
            int copies = host.copyCalls;
            controller.copySelected();
            check(controller.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content")), "a repeated result is consumed without a second write");
            check(host.io.size() == 1 && host.launchCount == 1 && host.copyCalls == copies,
                "reentry and duplicate results do not schedule another export or copy");
            host.runNextIo();
            check(host.target.closeCalls == 1 && host.toasts.contains("导出成功") && host.cacheFiles(root).length == 0,
                "the sole write closes once and releases the snapshot after completion");
            controller.close();

            ManualHost selectHost = new ManualHost(); Object selectOwner = new Object();
            LogPage.Controller selectController = new LogPage.Controller(selectOwner, store, selectHost);
            readyController(selectController, selectHost, a);
            selectController.exportSelected(root); selectHost.runNextIo();
            selectController.onActivityResult(selectOwner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content"));
            selectController.select(b);
            selectHost.runNextIo(); selectHost.runAllIo();
            check(selectHost.target != null && !selectHost.toasts.contains("导出成功")
                && selectHost.states.get(selectHost.states.size() - 1).selected == b,
                "the frozen A write may finish after selecting B, while A cannot update B state or toast");
            selectController.close();

            ManualHost refreshHost = new ManualHost(); Object refreshOwner = new Object();
            LogPage.Controller refreshController = new LogPage.Controller(refreshOwner, store, refreshHost);
            readyController(refreshController, refreshHost, a);
            refreshController.exportSelected(root); refreshHost.runNextIo();
            refreshController.onActivityResult(refreshOwner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content"));
            refreshController.refresh();
            refreshHost.runNextIo(); refreshHost.runAllIo();
            check(!refreshHost.toasts.contains("导出成功") && refreshHost.states.get(refreshHost.states.size() - 1).selected == null,
                "refresh invalidates the old result message without cancelling the frozen write");
            refreshController.close();

            ManualHost backHost = new ManualHost(); Object backOwner = new Object();
            LogPage.Controller backController = new LogPage.Controller(backOwner, store, backHost);
            readyController(backController, backHost, a);
            backController.exportSelected(root); backHost.runNextIo();
            backController.onActivityResult(backOwner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content"));
            backController.back(); backHost.runNextIo();
            check(!backHost.toasts.contains("导出成功") && !backHost.states.get(backHost.states.size() - 1).detail,
                "returning to the list invalidates the previous detail result");
            backController.close();

            ManualHost beforeOpenHost = new ManualHost(); Object reopenOwner = new Object();
            LogPage.Controller oldController = new LogPage.Controller(reopenOwner, store, beforeOpenHost);
            readyController(oldController, beforeOpenHost, a);
            oldController.exportSelected(root); beforeOpenHost.runNextIo();
            oldController.onActivityResult(reopenOwner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content"));
            oldController.close();
            ManualHost reopenedHost = new ManualHost();
            LogPage.Controller reopened = new LogPage.Controller(reopenOwner, store, reopenedHost);
            readyController(reopened, reopenedHost, a);
            reopened.exportSelected(root);
            check(reopenedHost.launchCount == 0 && reopenedHost.io.isEmpty() && reopenedHost.toasts.contains("已有导出正在处理"),
                "same-fragment reopen remains busy until the cancelled queued worker confirms cleanup");
            beforeOpenHost.runAllIo();
            check(beforeOpenHost.openedTargets == 0 && beforeOpenHost.cacheFiles(root).length == 0,
                "close before the queued write prevents opening the target and releases the active snapshot");
            check(!lastState(reopenedHost.states).exportPending, "reopened host redraws when the prior cancelled session finalizes");
            int reopenedToastCount = reopenedHost.toasts.size();
            reopened.exportSelected(root);
            check(reopenedHost.io.size() == 1 && reopenedHost.toasts.size() == reopenedToastCount,
                "a new export can start after the shared session cleanup is confirmed");
            reopened.close(); reopenedHost.runAllIo();

            ManualHost preparingHost = new ManualHost(); Object preparingOwner = new Object();
            LogPage.Controller preparing = new LogPage.Controller(preparingOwner, store, preparingHost);
            readyController(preparing, preparingHost, a);
            preparingHost.queueMain = true;
            preparing.exportSelected(root); preparingHost.runNextIo();
            check(preparingHost.main.size() == 1 && preparingHost.launchCount == 0 && preparingHost.cacheFiles(root).length == 1,
                "completed preparation owns its unpresented snapshot until its main callback runs");
            preparing.close(); preparingHost.runAllCancellation(); preparingHost.runAllMain();
            check(preparingHost.launchCount == 0 && preparingHost.cacheFiles(root).length == 0,
                "close before presentation suppresses the selector and clears the completed snapshot");

            ManualHost completionQueuedHost = new ManualHost(); Object completionOwner = new Object();
            LogPage.Controller completionQueued = new LogPage.Controller(completionOwner, store, completionQueuedHost);
            readyController(completionQueued, completionQueuedHost, a);
            completionQueuedHost.queueMain = true;
            completionQueued.exportSelected(root); completionQueuedHost.runNextIo(); completionQueuedHost.runAllMain();
            completionQueued.onActivityResult(completionOwner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content"));
            completionQueuedHost.runNextIo();
            check(completionQueuedHost.main.size() == 1 && completionQueuedHost.target.closed,
                "write completion is queued to main only after all streams close");
            completionQueued.close(); completionQueuedHost.runAllMain();
            check(!completionQueuedHost.toasts.contains("导出成功"), "close before queued completion rendering suppresses the old toast");

            ManualHost cleanupFailureHost = new ManualHost(); Object cleanupFailureOwner = new Object();
            LogPage.Controller cleanupFailure = new LogPage.Controller(cleanupFailureOwner, store, cleanupFailureHost);
            readyController(cleanupFailure, cleanupFailureHost, a);
            cleanupFailure.exportSelected(root); cleanupFailureHost.runNextIo();
            cleanupFailureHost.failSnapshotDelete = true;
            cleanupFailure.onActivityResult(cleanupFailureOwner, LogPage.EXPORT_REQUEST_CODE, 0, null);
            check(cleanupFailureHost.cacheFiles(root).length == 1 && lastState(cleanupFailureHost.states).exportPending
                && lastState(cleanupFailureHost.states).message.equals("临时日志文件清理失败，导出仍在处理中"),
                "failed snapshot cleanup keeps the session and snapshot registered as busy instead of releasing ownership");
            cleanupFailure.close();
            ManualHost cleanupRetryHost = new ManualHost();
            LogPage.Controller cleanupRetry = new LogPage.Controller(cleanupFailureOwner, store, cleanupRetryHost);
            readyController(cleanupRetry, cleanupRetryHost, a);
            cleanupRetry.exportSelected(root);
            check(cleanupRetryHost.io.isEmpty() && cleanupRetryHost.toasts.contains("已有导出正在处理"),
                "same-fragment reopen remains blocked while the retained cleanup is pending");
            cleanupRetryHost.runAllCancellation();
            check(cleanupRetryHost.cacheFiles(root).length == 0 && !lastState(cleanupRetryHost.states).exportPending,
                "the reopened controller retries cleanup and releases the session only after the snapshot is deleted");
            cleanupRetry.exportSelected(root); cleanupRetryHost.runNextIo();
            check(cleanupRetryHost.launchCount == 1, "a later export starts only after confirmed snapshot cleanup");
            cleanupRetry.onActivityResult(cleanupFailureOwner, LogPage.EXPORT_REQUEST_CODE, 0, null);
            cleanupRetry.close();

            ManualHost blockingHost = new ManualHost(); Object blockingOwner = new Object();
            LogPage.Controller blocking = new LogPage.Controller(blockingOwner, store, blockingHost);
            readyController(blocking, blockingHost, a);
            blocking.exportSelected(root); blockingHost.runNextIo();
            blocking.onActivityResult(blockingOwner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content"));
            BlockingInput blockingInput = new BlockingInput(); blockingHost.snapshotInputOverride = blockingInput;
            Thread writer = new Thread(new Runnable() { @Override public void run() { blockingHost.runNextIo(); } });
            writer.start();
            check(blockingInput.entered.await(5, java.util.concurrent.TimeUnit.SECONDS), "write enters its controllable blocking snapshot read");
            blocking.close(); blockingHost.runAllCancellation(); writer.join(5000L);
            check(!writer.isAlive() && blockingInput.closeCalls == 1 && blockingHost.target.closeCalls == 1,
                "independent cancellation closes each active stream once and unblocks the writer");
            check(blockingHost.target.size() == 0 && blockingHost.deletedTargets == 1 && !blockingHost.toasts.contains("导出成功"),
                "cancelled writing stops before emitting bytes, attempts target cleanup, and never succeeds");
        } finally { deleteTree(root); }
    }

    private static void testReadCloseFailuresAreNotSuccess() throws Exception {
        File root = cacheTemp("calendar-tab-r2-close-");
        try {
            File directory = new File(root, "logs"); check(directory.mkdirs(), "close-failure source root is created");
            final String raw = "wakeup-noads crash log\npackage: io.github.wakeupnoads\njava.lang.RuntimeException: close-secret\n";
            final FixtureSource source = new FixtureSource("app", "应用目录", directory);
            final LogStore.Entry entry = source.add("crash-20261012-010501-001-12.txt", 10L, raw);
            final AtomicInteger closes = new AtomicInteger();
            File closeDirectory = new File(root, "close-logs"); check(closeDirectory.mkdirs(), "close-failure source has its own fixture directory");
            FixtureSource closeSource = new FixtureSource("app", "应用目录", closeDirectory) {
                @Override public InputStream open(LogStore.Entry ignored) {
                    return new FaultInput(raw.getBytes(Charset.forName("UTF-8")), false, true, closes);
                }
            };
            final LogStore.Entry closeEntry = closeSource.add("crash-20261012-010502-002-12.txt", 11L, raw);
            LogStore closeStore = new LogStore(Collections.<LogStore.Source>singletonList(closeSource));
            boolean previewFailed = false, copyFailed = false, snapshotFailed = false;
            try { closeStore.preview(closeEntry); } catch (IOException expected) { previewFailed = true; }
            try { closeStore.copyText(closeEntry); } catch (IOException expected) { copyFailed = true; }
            try { closeStore.snapshot(closeEntry, root); } catch (IOException expected) { snapshotFailed = true; }
            check(previewFailed && copyFailed && snapshotFailed && closes.get() == 3,
                "production preview/copy/snapshot fail on input close and attempt each close once");
            File exportRoot = new File(root, LogStore.EXPORT_FOLDER);
            File[] left = exportRoot.listFiles();
            check(left == null || left.length == 0, "input-close failure removes the incomplete snapshot");

            final AtomicInteger bothCloses = new AtomicInteger();
            LogStore.Source bothFails = new LogStore.Source() {
                @Override public String key() { return "app"; }
                @Override public String label() { return "app"; }
                @Override public LogStore.Scan scan() { return LogStore.Scan.readable(Collections.singletonList(closeEntry)); }
                @Override public InputStream open(LogStore.Entry ignored) { return new FaultInput(raw.getBytes(Charset.forName("UTF-8")), true, true, bothCloses); }
            };
            LogStore.Entry bothEntry = new LogStore.Entry(closeEntry.key, closeEntry.sourceKey, closeEntry.sourceLabel, closeEntry.fileName,
                closeEntry.modifiedMillis, bothFails, closeEntry.handle, closeEntry.boundaryRoot, closeEntry.ownerPackage, closeEntry.relativePath, closeEntry.uriScheme);
            IOException combined = null;
            try { new LogStore(Collections.<LogStore.Source>singletonList(bothFails)).preview(bothEntry); }
            catch (IOException expected) { combined = expected; }
            check(combined != null && "read-secret-failure".equals(combined.getMessage())
                && combined.getSuppressed().length == 1 && "close-secret-failure".equals(combined.getSuppressed()[0].getMessage())
                && bothCloses.get() == 1, "read remains primary, close is suppressed, and the stream is closed once");

            final AtomicInteger readOnlyCloses = new AtomicInteger();
            LogStore.Source readFails = new LogStore.Source() {
                @Override public String key() { return "app"; }
                @Override public String label() { return "app"; }
                @Override public LogStore.Scan scan() { return LogStore.Scan.readable(Collections.singletonList(closeEntry)); }
                @Override public InputStream open(LogStore.Entry ignored) { return new FaultInput(raw.getBytes(Charset.forName("UTF-8")), true, false, readOnlyCloses); }
            };
            LogStore.Entry readEntry = new LogStore.Entry(closeEntry.key, closeEntry.sourceKey, closeEntry.sourceLabel, closeEntry.fileName,
                closeEntry.modifiedMillis, readFails, closeEntry.handle, closeEntry.boundaryRoot, closeEntry.ownerPackage, closeEntry.relativePath, closeEntry.uriScheme);
            boolean readFailed = false;
            try { new LogStore(Collections.<LogStore.Source>singletonList(readFails)).copyText(readEntry); } catch (IOException expected) { readFailed = true; }
            check(readFailed && readOnlyCloses.get() == 1, "read failure with successful close remains a failure and closes once");

            LogStore outputCloseStore = new LogStore(Collections.<LogStore.Source>singletonList(source), new LogStore.OutputFactory() {
                @Override public OutputStream open(File file) throws Exception {
                    return new java.io.FilterOutputStream(new java.io.FileOutputStream(file)) {
                        int closeCount;
                        @Override public void close() throws IOException { closeCount++; super.close(); throw new IOException("output-close-secret"); }
                    };
                }
            });
            boolean outputCloseFailed = false;
            try { outputCloseStore.snapshot(entry, root); } catch (IOException expected) { outputCloseFailed = true; }
            left = exportRoot.listFiles();
            check(outputCloseFailed && (left == null || left.length == 0), "snapshot output close failure propagates and deletes partial output");

            ManualHost selectHost = new ManualHost(); Object owner = new Object();
            LogPage.Controller controller = new LogPage.Controller(owner, closeStore, selectHost);
            controller.present(); selectHost.runAllIo(); controller.select(closeEntry); selectHost.runAllIo();
            check(selectHost.copyCalls == 0 && lastState(selectHost.states).preview.isEmpty()
                && lastState(selectHost.states).message.equals("日志已消失或不可读取，请刷新重试"),
                "Controller.select turns input close failure into the fixed unreadable state (actual="
                    + lastState(selectHost.states).message + ", preview=" + lastState(selectHost.states).preview.length() + ")");
            controller.copySelected(); selectHost.runAllIo();
            check(selectHost.copyCalls == 0 && !selectHost.toasts.contains("已复制")
                && last(selectHost.toasts).equals("复制失败：日志不可读取"),
                "Controller.copySelected never calls host.copy or reports success when close fails");
            controller.close();

            ManualHost targetInputCloseHost = new ManualHost(); Object targetOwner = new Object();
            LogStore normalStore = new LogStore(Collections.<LogStore.Source>singletonList(source));
            LogPage.Controller targetInputClose = new LogPage.Controller(targetOwner, normalStore, targetInputCloseHost);
            readyController(targetInputClose, targetInputCloseHost, entry);
            targetInputClose.exportSelected(root); targetInputCloseHost.runNextIo();
            targetInputClose.onActivityResult(targetOwner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content"));
            AtomicInteger targetInputCloseCount = new AtomicInteger();
            targetInputCloseHost.snapshotInputOverride = new FaultInput("wakeup-noads crash log\n".getBytes("UTF-8"), false, true, targetInputCloseCount);
            targetInputCloseHost.runAllIo();
            check(targetInputCloseCount.get() == 1 && targetInputCloseHost.target.closeCalls == 1
                && targetInputCloseHost.deletedTargets == 1 && !targetInputCloseHost.toasts.contains("导出成功"),
                "target snapshot-input close failure closes both resources once and cannot report export success");
            targetInputClose.close();
            check(Arrays.equals(raw.getBytes("UTF-8"), Files.readAllBytes(((File) entry.handle).toPath())),
                "all read/write/close failures leave the original source unchanged");
        } finally { deleteTree(root); }
    }

    private static void testMediaStoreProductionAdapterAndStates() throws Exception {
        File root = cacheTemp("calendar-tab-r2-media-");
        try {
            File external = new File(root, "external");
            File appLogs = CrashLog.logDirectory(external);
            check(appLogs.mkdirs(), "app log directory is created for source-dispatch tests");
            File legacy = new File(root, "Download/wakeup-noads");
            check(legacy.mkdirs(), "legacy Download directory is prepared for API 28 dispatch");
            FakeMediaPlatform platform = new FakeMediaPlatform();
            platform.cursor = new FakeMediaCursor(new String[] { "_id", "_display_name", "relative_path", "owner_package_name", "date_modified" },
                new Object[][] {
                    { 77L, "crash-20261012-010601-001-12.txt", "Download/wakeup-noads/", LogStore.PACKAGE_NAME, 1234L },
                    { 78L, "crash-20261012-010602-002-12.txt", "Download/wakeup-noads/", "other.package", 1235L },
                    { 79L, "not-a-log.txt", "Download/wakeup-noads/", LogStore.PACKAGE_NAME, 1236L },
                    { 80L, "exit-20261012-010603-003-12.txt", "Download/other/", LogStore.PACKAGE_NAME, 1237L },
                });

            LogStore api28 = LogStore.forContext(null, 28, external, legacy, platform);
            check("legacy-download".equals(api28.sourceAt(1).key()) && api28.sourceAt(1).scan().accessible
                && platform.collectionCalls == 0 && platform.queryCalls == 0,
                "production source dispatch uses LegacyDownloadSource on API 28 without touching Downloads");
            LogStore api29 = LogStore.forContext(new Object(), 29, external, legacy, platform);
            check(api29.sourceAt(1) instanceof LogStore.MediaStoreSource, "API 29 production dispatch constructs MediaStoreSource");
            LogStore.Result result = api29.list();
            check(result.entries.size() == 1 && result.entries.get(0).fileName.equals("crash-20261012-010601-001-12.txt"),
                "production scan rejects wrong-owner, wrong-name, and wrong-path rows");
            check(result.entries.get(0).modifiedMillis == 1_234_000L
                && "content://downloads/77".equals(result.entries.get(0).key.substring("media:".length())),
                "production scan maps appended content URI and seconds to milliseconds");
            check(platform.lastCollection == platform.collection && Arrays.equals(platform.projection,
                new String[] { "_id", "_display_name", "relative_path", "owner_package_name", "date_modified" })
                && "owner_package_name=? AND (relative_path=? OR relative_path=?)".equals(platform.selection)
                && Arrays.equals(platform.arguments, new String[] { LogStore.PACKAGE_NAME, "Download/wakeup-noads/", "Download/wakeup-noads" })
                && platform.sortOrder == null && platform.cursor.closeCalls == 1,
                "real scan constructs and passes the exact collection/projection/selection/arguments/sort contract and closes Cursor");
            LogStore.Preview mediaPreview = api29.preview(result.entries.get(0));
            check("wakeup-noads crash log\n".equals(mediaPreview.text) && platform.openCalls == 1,
                "MediaStore open uses the same injected platform boundary after production filtering");

            FakeMediaPlatform api36Platform = new FakeMediaPlatform();
            api36Platform.cursor = FakeMediaCursor.empty();
            LogStore api36 = LogStore.forContext(new Object(), 36, external, legacy, api36Platform);
            check(api36.sourceAt(1) instanceof LogStore.MediaStoreSource && api36.list().entries.isEmpty()
                && api36Platform.collectionCalls == 1 && api36Platform.queryCalls == 1,
                "API 36 dispatch accesses MediaStore and preserves the successful empty state");

            FakeMediaPlatform nullCursor = new FakeMediaPlatform();
            nullCursor.returnNullCursor = true;
            LogStore.MediaStoreSource nullSource = new LogStore.MediaStoreSource(new Object(), nullCursor);
            LogStore.Scan nullScan = nullSource.scan();
            check(!nullScan.accessible && nullCursor.queryCalls == 1, "null Cursor is an unavailable source, not a successful empty list");
            FixtureSource readableApp = new FixtureSource("app", "应用目录", appLogs);
            LogStore.Result nullCursorPartial = new LogStore(Arrays.<LogStore.Source>asList(readableApp, nullSource)).list();
            check(nullCursorPartial.readableSources == 1 && "部分历史日志无法读取".equals(nullCursorPartial.stateText()),
                "null Cursor keeps a readable app source available while reporting the history source failure");

            FakeMediaPlatform permission = new FakeMediaPlatform(); permission.queryFailure = new IOException("permission secret");
            boolean permissionFailed = false;
            try { new LogStore.MediaStoreSource(new Object(), permission).scan(); } catch (IOException expected) { permissionFailed = true; }
            check(permissionFailed, "query permission failure propagates from the production scan path");

            FakeMediaPlatform missingColumn = new FakeMediaPlatform();
            missingColumn.cursor = new FakeMediaCursor(new String[] { "_id", "_display_name", "relative_path", "date_modified" }, new Object[0][]);
            boolean missingFailed = false;
            try { new LogStore.MediaStoreSource(new Object(), missingColumn).scan(); } catch (IOException expected) { missingFailed = true; }
            check(missingFailed && missingColumn.cursor.closeCalls == 1, "missing required column fails scan and closes Cursor once");

            FakeMediaPlatform iteration = new FakeMediaPlatform();
            iteration.cursor = FakeMediaCursor.empty(); iteration.cursor.failMove = true; iteration.cursor.failClose = true;
            Exception combined = null;
            try { new LogStore.MediaStoreSource(new Object(), iteration).scan(); } catch (Exception expected) { combined = expected; }
            check(combined != null && combined.getSuppressed().length == 1 && iteration.cursor.closeCalls == 1,
                "Cursor iteration remains primary while Cursor close failure is suppressed after one close attempt");

            FakeMediaPlatform closeOnly = new FakeMediaPlatform();
            closeOnly.cursor = FakeMediaCursor.empty(); closeOnly.cursor.failClose = true;
            boolean closeFailed = false;
            try { new LogStore.MediaStoreSource(new Object(), closeOnly).scan(); } catch (IOException expected) { closeFailed = true; }
            check(closeFailed && closeOnly.cursor.closeCalls == 1, "Cursor close failure cannot be swallowed as an empty successful scan");

            FixtureSource readable = new FixtureSource("app", "应用目录", appLogs);
            LogStore.Source nullScanSource = new LogStore.Source() {
                @Override public String key() { return "media-download"; }
                @Override public String label() { return "ignored"; }
                @Override public LogStore.Scan scan() { return null; }
                @Override public InputStream open(LogStore.Entry entry) { return null; }
            };
            LogStore.Result partial = new LogStore(Arrays.<LogStore.Source>asList(readable, nullScanSource)).list();
            check(partial.readableSources == 1 && "部分历史日志无法读取".equals(partial.stateText()),
                "null Scan with one readable source produces a partial-failure state");
            FixtureSource emptyA = new FixtureSource("app", "应用目录", appLogs);
            FixtureSource emptyB = new FixtureSource("legacy-download", "历史 Download", legacy);
            LogStore.Result empty = new LogStore(Arrays.<LogStore.Source>asList(emptyA, emptyB)).list();
            check(empty.readableSources == 2 && !empty.hasErrors() && "暂无日志".equals(empty.stateText()),
                "all-readable empty sources remain distinguishable from partial and total failure");
            FixtureSource unavailable = new FixtureSource("app", "应用目录", appLogs); unavailable.unavailableMessage = "private permission";
            LogStore.Result allFailed = new LogStore(Arrays.<LogStore.Source>asList(unavailable, nullScanSource)).list();
            check(allFailed.readableSources == 0 && "日志来源不可读取".equals(allFailed.stateText()),
                "all-failed sources show an unavailable state");
        } finally { deleteTree(root); }
    }

    private static void testMediaStoreMultipleSourcesHaveStableOrdering() {
        String[] columns = new String[] { "_id", "_display_name", "relative_path", "owner_package_name", "date_modified" };
        Object[][] rowsA = new Object[][] {
            { 301L, "crash-20261012-010801-001-12.txt", "Download/wakeup-noads/", LogStore.PACKAGE_NAME, 500L },
            { 302L, "exit-20261012-010802-002-12.txt", "Download/wakeup-noads/", LogStore.PACKAGE_NAME, 400L },
        };
        Object[][] rowsB = new Object[][] {
            { 401L, "crash-20261012-010803-003-12.txt", "Download/wakeup-noads/", LogStore.PACKAGE_NAME, 600L },
            { 402L, "exit-20261012-010804-004-12.txt", "Download/wakeup-noads/", LogStore.PACKAGE_NAME, 300L },
        };
        LogStore.Source first = mediaSource(columns, rowsA);
        LogStore.Source second = mediaSource(columns, rowsB);
        LogStore.Result firstOrder = new LogStore(Arrays.asList(first, second)).list();
        LogStore.Result swappedOrder = new LogStore(Arrays.asList(mediaSource(columns, rowsB), mediaSource(columns, rowsA))).list();
        List<String> firstNames = entryNames(firstOrder.entries);
        List<String> swappedNames = entryNames(swappedOrder.entries);
        check(firstOrder.readableSources == 2 && firstOrder.entries.size() == 4,
            "two readable production MediaStore adapters retain every nonempty successful entry");
        check(firstNames.equals(Arrays.asList(
                "crash-20261012-010803-003-12.txt", "crash-20261012-010801-001-12.txt",
                "exit-20261012-010802-002-12.txt", "exit-20261012-010804-004-12.txt"))
            && swappedNames.equals(firstNames),
            "production list sorting is independent of the order in which two nonempty MediaStore sources are scanned");

        List<String> survivingNames = Arrays.asList("crash-20261012-010801-001-12.txt", "exit-20261012-010802-002-12.txt");
        for (int failureKind = 0; failureKind < 2; failureKind++) {
            for (int order = 0; order < 2; order++) {
                FakeMediaPlatform failedPlatform = new FakeMediaPlatform();
                if (failureKind == 0) failedPlatform.queryFailure = new IOException("query failure");
                else failedPlatform.returnNullCursor = true;
                LogStore.Source success = mediaSource(columns, rowsA);
                LogStore.Source failed = new LogStore.MediaStoreSource(new Object(), failedPlatform);
                LogStore.Result partial = new LogStore(order == 0
                    ? Arrays.asList(success, failed) : Arrays.asList(failed, success)).list();
                check(partial.readableSources == 1 && partial.totalSources == 2 && partial.sourceErrors.size() == 1
                    && entryNames(partial.entries).equals(survivingNames)
                    && "部分历史日志无法读取".equals(partial.stateText()),
                    "one nonempty successful MediaStore source and one failed source keep the successful entries "
                        + "and report partial failure in either scan order (failure " + failureKind + ", order " + order + ")");
            }
        }
    }

    private static LogStore.Source mediaSource(String[] columns, Object[][] rows) {
        FakeMediaPlatform platform = new FakeMediaPlatform();
        platform.cursor = new FakeMediaCursor(columns, rows);
        return new LogStore.MediaStoreSource(new Object(), platform);
    }

    private static List<String> entryNames(List<LogStore.Entry> entries) {
        List<String> names = new ArrayList<String>();
        for (LogStore.Entry entry : entries) names.add(entry.fileName);
        return names;
    }

    private static void testWritingAndFinalizingCallbacksAreIdempotent() throws Exception {
        File root = cacheTemp("calendar-tab-r3-callbacks-");
        try {
            File directory = new File(root, "logs"); check(directory.mkdirs(), "callback source root is created");
            FixtureSource source = new FixtureSource("app", "应用目录", directory);
            LogStore.Entry entry = source.add("crash-20261012-010805-005-12.txt", 1000L,
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\n");
            LogStore store = new LogStore(Collections.<LogStore.Source>singletonList(source));

            Object writingOwner = new Object();
            ManualHost writingHost = new ManualHost();
            LogPage.Controller writing = new LogPage.Controller(writingOwner, store, writingHost);
            readyController(writing, writingHost, entry);
            String expectedPreview = lastState(writingHost.states).preview;
            writing.exportSelected(root); writingHost.runNextIo();
            writing.onActivityResult(writingOwner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content"));
            GateInput gate = new GateInput("wakeup-noads crash log\n".getBytes("UTF-8"));
            writingHost.snapshotInputOverride = gate;
            Thread writer = new Thread(new Runnable() { @Override public void run() { writingHost.runNextIo(); } });
            writer.start();
            check(gate.entered.await(5, java.util.concurrent.TimeUnit.SECONDS), "writing callback fixture reaches its controllable read");
            check(writing.onActivityResult(writingOwner, LogPage.EXPORT_REQUEST_CODE, 0, null),
                "a cancellation callback received during WRITING is consumed as a stale result");
            check(writingHost.io.isEmpty() && writingHost.cancellations.isEmpty() && writingHost.launchCount == 1,
                "WRITING cancellation does not schedule another write or cancel the current worker");
            gate.release.countDown(); writer.join(5000L);
            check(!writer.isAlive() && writingHost.target.closeCalls == 1 && writingHost.deletedTargets == 0,
                "the original write completes and closes once after the stale WRITING callback");
            check(countText(writingHost.toasts, "导出成功") == 1 && !writingHost.toasts.contains("已取消导出")
                && "导出成功".equals(lastState(writingHost.states).message)
                && lastState(writingHost.states).selected == entry
                && expectedPreview.equals(lastState(writingHost.states).preview),
                "WRITING callback leaves one final success state and toast and retains the selected preview");
            writing.close();

            Object finalizingOwner = new Object();
            ManualHost finalizingHost = new ManualHost();
            LogPage.Controller finalizing = new LogPage.Controller(finalizingOwner, store, finalizingHost);
            readyController(finalizing, finalizingHost, entry);
            String finalizingPreview = lastState(finalizingHost.states).preview;
            finalizing.exportSelected(root); finalizingHost.runNextIo();
            finalizingHost.beforeSnapshotDelete = new Runnable() {
                @Override public void run() {
                    check(finalizing.onActivityResult(finalizingOwner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK,
                        new FakeUri("content")), "duplicate RESULT_OK is consumed while FINALIZING");
                    check(finalizing.onActivityResult(finalizingOwner, LogPage.EXPORT_REQUEST_CODE, 0, null),
                        "duplicate cancellation is consumed while FINALIZING");
                }
            };
            check(finalizing.onActivityResult(finalizingOwner, LogPage.EXPORT_REQUEST_CODE, 0, null),
                "the initial cancellation enters FINALIZING");
            check(finalizingHost.snapshotDeleteCalls == 1 && finalizingHost.io.isEmpty() && finalizingHost.cancellations.isEmpty()
                && finalizingHost.openedTargets == 0
                && finalizingHost.cacheFiles(root).length == 0,
                "duplicate callbacks during FINALIZING neither write/cancel again nor duplicate snapshot cleanup");
            check(countText(finalizingHost.toasts, "已取消导出") == 0
                && countStateMessage(finalizingHost.states, "已取消导出") == 1
                && "已取消导出".equals(lastState(finalizingHost.states).message)
                && lastState(finalizingHost.states).selected == entry
                && finalizingPreview.equals(lastState(finalizingHost.states).preview),
                "FINALIZING duplicates leave one cancellation state, no toast, and the original preview");
            finalizing.close();
        } finally { deleteTree(root); }
    }

    private static void testQueuedCompletionDoesNotOverwriteNextSelection() throws Exception {
        File root = cacheTemp("calendar-tab-r3-queued-result-");
        try {
            File directory = new File(root, "logs"); check(directory.mkdirs(), "queued-result source root is created");
            FixtureSource source = new FixtureSource("app", "应用目录", directory);
            LogStore.Entry a = source.add("crash-20261012-010806-006-12.txt", 2000L,
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\nentry-a\n");
            LogStore.Entry b = source.add("exit-20261012-010807-007-12.txt", 1000L,
                "wakeup-noads exit log\npackage: io.github.wakeupnoads\nentry-b\n");
            LogStore store = new LogStore(Collections.<LogStore.Source>singletonList(source));
            Object owner = new Object(); ManualHost host = new ManualHost();
            LogPage.Controller controller = new LogPage.Controller(owner, store, host);
            readyController(controller, host, a);
            host.queueMain = true;
            controller.exportSelected(root); host.runNextIo(); host.runAllMain();
            controller.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content"));
            host.runNextIo();
            check(host.main.size() == 1 && host.target.closed,
                "A's stream is closed and completion is queued before the test switches selection");
            controller.select(b); host.runNextIo();
            host.runAllMain();
            LogPage.PageState current = lastState(host.states);
            check(current.selected == b && current.preview.equals(store.preview(b).text),
                "delivering A's queued completion after selecting B preserves B's production preview and state");
            check(!host.toasts.contains("导出成功") && !current.message.equals("导出成功")
                && host.target.toByteArray().length > 0,
                "A's queued result neither changes B's message nor emits a stale success toast");
            controller.close();
        } finally { deleteTree(root); }
    }

    private static void testStaleGenerationCallbacksReleaseResources() throws Exception {
        File root = cacheTemp("calendar-tab-r3-stale-generation-");
        try {
            File directory = new File(root, "logs"); check(directory.mkdirs(), "stale-generation source root is created");
            FixtureSource slow = new FixtureSource("app", "应用目录", directory);
            LogStore.Entry a = slow.add("crash-20261012-010808-008-12.txt", 3000L,
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\nentry-a\n");
            LogStore.Entry b = slow.add("exit-20261012-010809-009-12.txt", 2000L,
                "wakeup-noads exit log\npackage: io.github.wakeupnoads\nentry-b\n");
            LogStore store = new LogStore(Collections.<LogStore.Source>singletonList(slow));
            Object owner = new Object(); ManualHost host = new ManualHost();
            LogPage.Controller controller = new LogPage.Controller(owner, store, host);
            readyController(controller, host, a);
            host.queueMain = true;
            controller.exportSelected(root); host.runNextIo();
            File[] prepared = host.cacheFiles(root);
            check(prepared.length == 1 && host.main.size() == 1, "old generation owns its prepared snapshot and queued presentation callback");
            controller.select(b); host.runNextIo(); host.runAllMain();
            check(host.launchCount == 0 && host.cacheFiles(root).length == 0,
                "stale preparation callback is discarded before launching SAF and releases its snapshot");
            check(lastState(host.states).selected == b && lastState(host.states).preview.equals(store.preview(b).text)
                && !host.toasts.contains("请选择本地保存位置"),
                "stale preparation cannot update the current B page");
            controller.close();

            File failureDirectory = new File(root, "failure-logs"); check(failureDirectory.mkdirs(), "stale-failure source directory is created");
            FixtureSource failing = new FixtureSource("app", "应用目录", failureDirectory) {
                @Override public InputStream open(LogStore.Entry ignored) throws Exception { throw new IOException("old prepare failure"); }
            };
            LogStore.Entry old = failing.add("crash-20261012-010810-010-12.txt", 4000L,
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\n");
            FixtureSource currentSource = new FixtureSource("legacy-download", "历史 Download", failureDirectory);
            LogStore.Entry current = currentSource.add("exit-20261012-010811-011-12.txt", 1000L,
                "wakeup-noads exit log\npackage: io.github.wakeupnoads\ncurrent-entry\n");
            LogStore failureStore = new LogStore(Arrays.<LogStore.Source>asList(failing, currentSource));
            Object failureOwner = new Object(); ManualHost failureHost = new ManualHost();
            LogPage.Controller failureController = new LogPage.Controller(failureOwner, failureStore, failureHost);
            failureController.present(); failureHost.runAllIo();
            failureController.select(old); failureHost.runAllIo();
            failureHost.queueMain = true;
            failureController.exportSelected(root); failureHost.runNextIo();
            check(failureHost.main.size() == 1 && failureHost.cacheFiles(root).length == 0,
                "old preparation failure has a queued completion and no leaked snapshot");
            failureController.select(current); failureHost.runNextIo(); failureHost.runAllMain();
            check(lastState(failureHost.states).selected == current
                && lastState(failureHost.states).preview.equals(failureStore.preview(current).text)
                && !failureHost.toasts.contains("无法准备完整日志")
                && !lastState(failureHost.states).message.equals("无法准备完整日志"),
                "old failure callback is discarded after generation change and cannot replace B's page state");
            failureController.close();
        } finally { deleteTree(root); }
    }

    private static void testAndroidHostOpenFailuresUseControllerPath() throws Exception {
        File root = cacheTemp("calendar-tab-r3-android-open-");
        try {
            File directory = new File(root, "logs"); check(directory.mkdirs(), "AndroidHost failure source root is created");
            FixtureSource source = new FixtureSource("app", "应用目录", directory);
            LogStore.Entry entry = source.add("crash-20261012-010812-012-12.txt", 1000L,
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\n");
            LogStore store = new LogStore(Collections.<LogStore.Source>singletonList(source));
            for (boolean throwsOpen : new boolean[] { true, false }) {
                Object owner = new Object(); FakeAndroidCalls calls = new FakeAndroidCalls();
                calls.openThrows = throwsOpen; calls.openReturnsNull = !throwsOpen; calls.deleteResult = 1;
                ManualHost host = new ManualHost();
                host.targetAdapter = new LogPage.AndroidHost(owner, owner, calls);
                LogPage.Controller controller = new LogPage.Controller(owner, store, host);
                readyController(controller, host, entry);
                controller.exportSelected(root); host.runNextIo();
                controller.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK,
                    new AndroidFakeUri("content", "content://private/export/path-secret"));
                host.runAllIo();
                check(calls.openCalls == 1 && calls.deleteCalls == 1 && host.cacheFiles(root).length == 0,
                    "real AndroidHost open failure path cleans its snapshot and asks its platform adapter to delete the target");
                check(last(host.toasts).equals("导出失败，源日志未修改") && !last(host.toasts).contains("path-secret"),
                    "real AndroidHost open exception/null returns a fixed failed result without destination data");
                controller.close();
            }
        } finally { deleteTree(root); }
    }

    private static void testLogPageExplicitActivityLaunchAndMode() throws Exception {
        FakePageLaunchCalls launch = new FakePageLaunchCalls();
        FakeAndroidUiCalls ui = new FakeAndroidUiCalls(1, 32);
        LogPage.setPageLaunchCallsForTest(launch);
        LogPage.setAndroidUiCallsForTest(ui);
        try {
            FakeSettingsActivity activity = new FakeSettingsActivity(null, null, 1, true);
            FakePageFragment fragment = new FakePageFragment(activity);
            LogPage.show(fragment);
            check(launch.startedFragment == fragment && launch.lastIntent != null
                && launch.lastIntent.targetClass == FakeSettingsActivity.class
                && Boolean.TRUE.equals(launch.lastIntent.extras.get("wakeup_noads_log_page"))
                && launch.lastIntent.flags == 0x20000000,
                "production show starts the explicit SettingsActivity with the fixed boolean and only SINGLE_TOP");
            check(ui.openCount == 0 && ui.finishCount == 0, "the source Mine host is neither opened as a page nor finished");

            check(LogPage.isLogActivity(activity), "the typed true extra on the SettingsActivity is accepted");
            activity.intent.extras.remove("wakeup_noads_log_page");
            check(!LogPage.isLogActivity(activity), "a missing log extra is rejected");
            activity.intent.extras.put("wakeup_noads_log_page", Boolean.FALSE);
            check(!LogPage.isLogActivity(activity), "a false boolean log extra is rejected");
            activity.intent.extras.put("wakeup_noads_log_page", "true");
            check(!LogPage.isLogActivity(activity), "a string that looks like true is rejected as the wrong type");
            FakeOtherActivity other = new FakeOtherActivity(null, null, 1, true);
            check(!LogPage.isLogActivity(other) && !LogPage.isLogActivity(null), "another host and null are rejected even with a true extra");
            activity.intent.extras.put("wakeup_noads_log_page", Boolean.TRUE);
            LogPage.prepareActivity(activity);
            check("本地日志".contentEquals(activity.title), "the log Activity bridge sets the short native Toolbar title");

            launch.failStart = true;
            launch.failureText = "intent path-secret content://private";
            LogPage.show(fragment);
            check(ui.toasts.size() == 1 && "日志页暂不可用".equals(ui.toasts.get(0))
                && !ui.toasts.get(0).contains("path-secret") && !ui.toasts.get(0).contains("content://")
                && ui.openCount == 0 && ui.finishCount == 0,
                "launch failure displays only the fixed notice and leaves the source Activity open");
        } finally {
            LogPage.setPageLaunchCallsForTest(null);
            LogPage.setAndroidUiCallsForTest(null);
        }
    }

    private static void testActivityOwnedPageThemeInsetsAndDetach() throws Exception {
        File root = cacheTemp("calendar-tab-r4-theme-insets-");
        try {
            File external = new File(root, "external"); check(external.mkdirs(), "the Activity external-files fixture exists");
            File cache = new File(root, "cache"); check(cache.mkdirs(), "the Activity cache fixture exists");
            File logs = CrashLog.logDirectory(external); check(logs.mkdirs(), "the app-owned log directory fixture exists");
            String longName = "crash-20261014-010203-004-" + repeat('7', 180) + ".txt";
            writeUtf8(new File(logs, longName),
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\nstudent=827361 password=page-secret\n");

            LogPage.setPageLaunchCallsForTest(new FakePageLaunchCalls());
            FakeAndroidUiCalls ui = new FakeAndroidUiCalls(1, 33);
            LogPage.setAndroidUiCallsForTest(ui);
            FakeSettingsActivity activity = new FakeSettingsActivity(external, cache, 1, true);
            Object originalToolbar = activity.toolbar;
            Object originalRecycler = activity.recycler;
            Object originalParams = activity.recycler.getLayoutParams();
            Object originalBehavior = ((FakeLayoutParams) originalParams).behavior;
            LogPage.attachActivity(activity);
            LogPage.attachActivity(activity);
            ui.awaitRenderCount(1);
            check(ui.openCount == 1 && ui.backRegistrations == 1 && ui.requestInsetsCount == 1,
                "repeated Activity attach reuses one native page, one API 33 callback and one inset request");
            int beforeRepeatedOpen = ui.lastScroll.addViewCalls;
            registeredHost(activity).open();
            check(activity.toolbar == originalToolbar && activity.toolbar.text.equals("本地日志")
                && activity.toolbar.parent == activity.appBar && activity.appBar.parent == activity.coordinator
                && activity.factoryCalls == 0 && activity.supportActionBarCalls == 0
                && countClass(activity.coordinator, "com.google.android.material.appbar.AppBarLayout") == 1
                && activity.recycler == originalRecycler && activity.recycler.parent == null
                && activity.coordinator.removeViewCalls == 1 && ui.lastScroll.addViewCalls == beforeRepeatedOpen
                && ui.lastScroll.layoutParams == originalParams && ((FakeLayoutParams) ui.lastScroll.layoutParams).behavior == originalBehavior,
                "production page reuses the attached base Toolbar and Recycler layout objects without factory, action-bar reset, duplicate removal, or duplicate body");
            check(ui.attributes.equals(Arrays.asList("android:colorBackground", "io.github.wakeupnoads:colorSurface",
                    "io.github.wakeupnoads:colorOnSurface", "io.github.wakeupnoads:colorOnSurfaceVariant",
                    "io.github.wakeupnoads:colorOutlineVariant")) && ui.resolved.size() == 5 && ui.recycledArrays == 5,
                "the production theme resolver requests the Activity background and all four Material theme attributes");
            check(((FakeColorStateList) ui.resolved.get(0)).color == 0xff110101
                && ((FakeColorStateList) ui.resolved.get(1)).color == 0xff110202
                && ((FakeColorStateList) ui.resolved.get(2)).color == 0xff110303
                && ((FakeColorStateList) ui.resolved.get(3)).color == 0xff110404
                && ((FakeColorStateList) ui.resolved.get(4)).color == 0xff110505,
                "the injected TypedArray returns the five independent literal theme colors");
            check(ui.lastScroll.backgroundColor == 0xff110101, "production page background equals the literal Activity background attribute");
            check(containsText(ui.lastBody, longName), "production list body includes the complete long filename");
            check(activity.toolbar.text.equals("本地日志"), "the visible base Toolbar receives the list title");
            check(verifyRenderedTheme(ui.lastBody, 1), "actual production list render binds surface, foreground, divider, and partial-source colors");
            FakeView rootView = ui.lastScroll;
            FakeView bodyView = ui.lastBody;
            LogPage.applyPageInsets(activity, rootView, new LogPage.PageInsets(10, 24, 12, 30, 0));
            check(Arrays.equals(rootView.padding, new int[] { 10, 3, 12, 0 })
                && Arrays.equals(bodyView.padding, new int[] { 16, 8, 16, 42 }),
                "production inset bridge sends system-bar sides to the root and system bottom to the content baseline");
            LogPage.applyPageInsets(activity, rootView, new LogPage.PageInsets(10, 24, 12, 30, 0));
            check(Arrays.equals(rootView.padding, new int[] { 10, 3, 12, 0 })
                && Arrays.equals(bodyView.padding, new int[] { 16, 8, 16, 42 }),
                "repeating system-bar insets does not accumulate content padding or add a second top inset");
            LogPage.applyPageInsets(activity, rootView, new LogPage.PageInsets(14, 25, 16, 28, 280));
            check(Arrays.equals(rootView.padding, new int[] { 14, 3, 16, 280 })
                && Arrays.equals(bodyView.padding, new int[] { 16, 8, 16, 12 }),
                "IME bottom replaces the root bottom and suppresses the system bottom in the content");
            int paddingWrites = ui.paddingWrites;
            ui.attached = false;
            LogPage.applyPageInsets(activity, rootView, new LogPage.PageInsets(9, 9, 9, 9, 9));
            check(ui.paddingWrites == paddingWrites, "an unattached page is a no-op for inset padding");
            ui.attached = true;

            LogPage.Controller controller = registeredController(activity);
            LogStore.Entry entry = controllerResult(controller).entries.get(0);
            controller.select(entry);
            ui.awaitRenderCount(3);
            ui.awaitBodyText(longName);
            check(activity.toolbar.text.equals("日志详情"), "the visible base Toolbar receives the detail title");
            check(containsText(ui.lastBody, longName), "detail body keeps the complete selected filename");
            check(verifyRenderedTheme(ui.lastBody, 1), "actual production detail controls keep the Activity theme colors");
            int beforeBack = ui.renderCount;
            ui.platformBack.run();
            ui.awaitRenderCount(beforeBack + 1);
            check(activity.toolbar.text.equals("本地日志") && ui.finishCount == 0,
                "the API 33 dispatcher callback uses Controller.back to return from detail to list");

            int beforeDestroyWrites = ui.paddingWrites;
            LogPage.onDestroy(activity);
            LogPage.applyPageInsets(activity, rootView, new LogPage.PageInsets(1, 1, 1, 1, 1));
            check(ui.backUnregistrations == 1 && ui.detachCount == 1 && ui.finishCount == 0
                && ui.paddingWrites == beforeDestroyWrites && rootView.parent == null,
                "Activity destruction unregisters once, detaches without finish, and prevents later inset writes");

            FakeAndroidUiCalls secondUi = new FakeAndroidUiCalls(2, 32);
            LogPage.setAndroidUiCallsForTest(secondUi);
            FakeSettingsActivity second = new FakeSettingsActivity(external, cache, 2, true);
            LogPage.attachActivity(second);
            secondUi.awaitRenderCount(1);
            secondUi.awaitBodyText(longName);
            check(secondUi.lastScroll.backgroundColor == 0xff220101
                && ((FakeColorStateList) secondUi.resolved.get(1)).themeId == 2
                && second.toolbar.text.equals("本地日志") && verifyRenderedTheme(secondUi.lastBody, 2)
                && secondUi.backRegistrations == 0,
                "a recreated Activity resolves its own theme and API 24–32 installs no dispatcher callback");
            LogPage.onDestroy(second);
        } finally {
            LogPage.setPageLaunchCallsForTest(null);
            LogPage.setAndroidUiCallsForTest(null);
            deleteTree(root);
        }
    }

    private static void testProductionLogPageRendererStatesAndInitializationFailure() throws Exception {
        for (int themeId : new int[] { 1, 2 }) {
            File root = cacheTemp("calendar-tab-r5-render-" + themeId + "-");
            try {
                File cache = new File(root, "cache"); check(cache.mkdirs(), "the render cache directory exists");
                File listDirectory = new File(root, "list"); check(listDirectory.mkdirs(), "the partial-list source exists");
                String longName = "crash-20261014-010203-004-" + repeat('8', 180) + ".txt";
                FixtureSource listSource = new FixtureSource("app", "应用目录", listDirectory);
                LogStore.Entry listEntry = listSource.add(longName, 4L,
                    "wakeup-noads crash log\npackage: io.github.wakeupnoads\nstudent=827361 password=page-secret\n");
                FixtureSource failedSource = new FixtureSource("legacy-download", "历史 Download", new File(root, "failed-list"));
                failedSource.scanFailure = new IOException("source path private");
                FakeAndroidUiCalls listUi = new FakeAndroidUiCalls(themeId, 32);
                FakeSettingsActivity listActivity = new FakeSettingsActivity(root, cache, themeId, true);
                LogPage.Controller listController = startNativeController(listActivity,
                    new LogStore(Arrays.<LogStore.Source>asList(listSource, failedSource)), listUi);
                listUi.awaitRenderCount(1);
                listUi.awaitBodyText("部分历史日志无法读取");
                check(listActivity.toolbar.text.equals("本地日志") && listUi.bodyContainsText(LogPage.SANITIZED_NOTICE)
                    && listUi.bodyContainsText(longName) && verifyRenderedTheme(listUi.lastBody, themeId)
                    && verifyRenderedControlContracts(listUi.lastBody),
                    "both independent themes bind list, partial-source warning, long wrappable filename, SP sizing, and expandable controls in production");
                FakeView longNameView = findTextContaining(listUi.lastBody, longName);
                check(longNameView != null && longNameView.layoutParams instanceof FakeLayoutParams
                    && ((FakeLayoutParams) longNameView.layoutParams).width == -1
                    && ((FakeLayoutParams) longNameView.layoutParams).height == -2
                    && longNameView.singleLineCalls == 0 && longNameView.maxLinesCalls == 0,
                    "the complete filename stays in a full-width wrapping TextView with WRAP_CONTENT height and no line cap");
                FakeView originalScroll = listUi.lastScroll;
                int bodyAdds = listUi.lastBody.addViewCalls;
                int coordinatorAdds = listActivity.coordinator.addViewCalls;
                androidHost(listController).open();
                check(listActivity.factoryCalls == 0 && listActivity.supportActionBarCalls == 0
                    && countClass(listActivity.coordinator, "com.google.android.material.appbar.AppBarLayout") == 1
                    && listActivity.coordinator.removeViewCalls == 1 && listUi.lastBody.addViewCalls == bodyAdds
                    && originalScroll.addViewCalls == 1
                    && listActivity.coordinator.addViewCalls == coordinatorAdds && originalScroll == listUi.lastScroll,
                    "a repeated production open keeps one AppBar, one original Recycler removal, one page body, and no factory/action-bar mutation");
                listController.detach();

                final CountDownLatch previewEntered = new CountDownLatch(1);
                final CountDownLatch allowPreview = new CountDownLatch(1);
                File detailDirectory = new File(root, "detail"); check(detailDirectory.mkdirs(), "the detail source exists");
                FixtureSource detailSource = new FixtureSource("app", "应用目录", detailDirectory) {
                    @Override public InputStream open(LogStore.Entry entry) throws Exception {
                        previewEntered.countDown();
                        if (!allowPreview.await(5, java.util.concurrent.TimeUnit.SECONDS)) throw new IOException("preview test gate timeout");
                        return super.open(entry);
                    }
                };
                LogStore.Entry detailEntry = detailSource.add(longName, 5L,
                    "wakeup-noads crash log\npackage: io.github.wakeupnoads\nstudent=827361 password=detail-secret\n");
                FakeAndroidUiCalls detailUi = new FakeAndroidUiCalls(themeId, 32);
                FakeSettingsActivity detailActivity = new FakeSettingsActivity(root, cache, themeId, true);
                LogPage.Controller detailController = startNativeController(detailActivity,
                    new LogStore(Collections.<LogStore.Source>singletonList(detailSource)), detailUi);
                detailUi.awaitRenderCount(1);
                detailUi.awaitBodyText(longName);
                detailController.select(detailEntry);
                check(previewEntered.await(5, java.util.concurrent.TimeUnit.SECONDS), "the production detail read reaches the controlled source");
                detailUi.awaitBodyText("正在读取日志…");
                check(detailActivity.toolbar.text.equals("日志详情") && verifyRenderedTheme(detailUi.lastBody, themeId)
                    && detailUi.bodyContainsText(LogPage.SANITIZED_NOTICE)
                    && verifyRenderedControlContracts(detailUi.lastBody),
                    "loading detail keeps the Activity theme and uses the original Toolbar title");
                allowPreview.countDown();
                detailUi.awaitBodyText("[redacted]");
                check(verifyRenderedTheme(detailUi.lastBody, themeId)
                    && detailUi.bodyContainsText("package: io.github.wakeupnoads"),
                    "sanitized detail preview text and status controls receive the independent theme colors");
                Files.delete(((File) detailEntry.handle).toPath());
                detailController.select(detailEntry);
                detailUi.awaitBodyText("日志已消失或不可读取，请刷新重试");
                check(verifyRenderedTheme(detailUi.lastBody, themeId),
                    "failed detail message uses the same theme secondary color while the sanitization notice remains readable");
                detailController.detach();

                FixtureSource emptySource = new FixtureSource("app", "应用目录", new File(root, "empty"));
                FakeAndroidUiCalls emptyUi = new FakeAndroidUiCalls(themeId, 32);
                FakeSettingsActivity emptyActivity = new FakeSettingsActivity(root, cache, themeId, true);
                LogPage.Controller emptyController = startNativeController(emptyActivity,
                    new LogStore(Collections.<LogStore.Source>singletonList(emptySource)), emptyUi);
                emptyUi.awaitRenderCount(1);
                emptyUi.awaitBodyText("暂无日志");
                check(verifyRenderedTheme(emptyUi.lastBody, themeId), "empty-list text and sanitization notice use the independent theme colors");
                emptyController.detach();

                FixtureSource unreadableSource = new FixtureSource("app", "应用目录", new File(root, "unreadable"));
                unreadableSource.unavailableMessage = "private path";
                FakeAndroidUiCalls unreadableUi = new FakeAndroidUiCalls(themeId, 32);
                FakeSettingsActivity unreadableActivity = new FakeSettingsActivity(root, cache, themeId, true);
                LogPage.Controller unreadableController = startNativeController(unreadableActivity,
                    new LogStore(Collections.<LogStore.Source>singletonList(unreadableSource)), unreadableUi);
                unreadableUi.awaitRenderCount(1);
                unreadableUi.awaitBodyText("日志来源不可读取");
                check(verifyRenderedTheme(unreadableUi.lastBody, themeId),
                    "complete source failure and sanitization notice use their independent theme colors");
                unreadableController.detach();
            } finally { deleteTree(root); }
        }

        File failureRoot = cacheTemp("calendar-tab-r5-no-toolbar-");
        try {
            File cache = new File(failureRoot, "cache"); check(cache.mkdirs(), "the unavailable-toolbar cache exists");
            FakeAndroidUiCalls ui = new FakeAndroidUiCalls(1, 33);
            FakeSettingsActivity activity = new FakeSettingsActivity(failureRoot, cache, 1, true);
            activity.coordinator.removeView(activity.appBar);
            FixtureSource emptySource = new FixtureSource("app", "应用目录", new File(failureRoot, "logs"));
            LogPage.Controller controller = startNativeController(activity,
                new LogStore(Collections.<LogStore.Source>singletonList(emptySource)), ui);
            check(ui.toasts.equals(Collections.singletonList("日志页暂不可用")) && ui.finishCount == 1
                && ui.dialogConstructCount == 0 && activity.factoryCalls == 0 && activity.supportActionBarCalls == 0,
                "missing original Toolbar exits with the fixed notice and finish, without Dialog or factory fallback");
            controller.detach();
        } finally { deleteTree(failureRoot); }
    }

    private static void testActivityOwnedBackAndStaleCallbacks() throws Exception {
        File root = cacheTemp("calendar-tab-r4-back-stale-");
        try {
            File external = new File(root, "external"); check(external.mkdirs(), "the back fixture external-files root exists");
            File cache = new File(root, "cache"); check(cache.mkdirs(), "the back fixture cache exists");
            File logs = CrashLog.logDirectory(external); check(logs.mkdirs(), "the back fixture app log folder exists");
            writeUtf8(new File(logs, "crash-20261014-020304-005-13.txt"), "wakeup-noads crash log\nthread: main\n");
            FakePageLaunchCalls launcher = new FakePageLaunchCalls();
            FakeAndroidUiCalls ui = new FakeAndroidUiCalls(3, 32);
            LogPage.setPageLaunchCallsForTest(launcher);
            LogPage.setAndroidUiCallsForTest(ui);
            FakeSettingsActivity first = new FakeSettingsActivity(external, cache, 3, true);
            LogPage.attachActivity(first);
            ui.awaitRenderCount(1);
            FakeClickListener oldToolbarBack = (FakeClickListener) first.toolbar.navigationClickListener;
            LogPage.Controller controller = registeredController(first);
            LogStore.Entry entry = controllerResult(controller).entries.get(0);
            controller.select(entry);
            ui.awaitRenderCount(3);
            oldToolbarBack.run();
            ui.awaitRenderCount(3);
            check(!controllerState(controller).detail, "the original Toolbar callback returns from detail through Controller.back");

            controller.select(entry);
            ui.awaitRenderCount(6);
            check(LogPage.onBackPressed(first), "the API 24–32 Activity bridge consumes system return in log mode");
            ui.awaitRenderCount(7);
            check(!controllerState(controller).detail, "the Activity back bridge returns detail to the log list");
            check(LogPage.onBackPressed(first) && ui.finishCount == 1,
                "list back finishes the log Activity once and returns to the prior host");
            check(LogPage.onBackPressed(first) && ui.finishCount == 1,
                "repeated list back is consumed without finishing the Activity twice");
            LogPage.onDestroy(first);

            FakeSettingsActivity recreated = new FakeSettingsActivity(external, cache, 4, true);
            LogPage.attachActivity(recreated);
            ui.awaitRenderCount(8);
            ui.awaitBodyText("crash-20261014-020304-005-13.txt");
            String beforeOldCallback = viewSnapshot(ui.lastBody);
            int beforeOldRenderCount = ui.renderCount;
            oldToolbarBack.run();
            check(ui.renderCount == beforeOldRenderCount && beforeOldCallback.equals(viewSnapshot(ui.lastBody))
                && !controllerState(registeredController(recreated)).detail,
                "a detached old Toolbar callback cannot update or close the new Activity's list instance");
            check(ui.openCount == 2 && !controllerState(registeredController(recreated)).detail,
                "Activity recreation opens one fresh page at the log list without restoring old detail state");
            LogPage.onDestroy(recreated);
        } finally {
            LogPage.setPageLaunchCallsForTest(null);
            LogPage.setAndroidUiCallsForTest(null);
            deleteTree(root);
        }
    }

    private static void testActivityOwnedSafResultAndFailure() throws Exception {
        File root = cacheTemp("calendar-tab-r4-saf-failure-");
        try {
            File external = new File(root, "external"); check(external.mkdirs(), "the SAF fixture external-files root exists");
            File cache = new File(root, "cache"); check(cache.mkdirs(), "the SAF fixture cache exists");
            File logs = CrashLog.logDirectory(external); check(logs.mkdirs(), "the SAF fixture app log folder exists");
            writeUtf8(new File(logs, "crash-20261014-030405-006-14.txt"),
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\nstudent=827361 password=saf-secret\n");

            FakePageLaunchCalls launcher = new FakePageLaunchCalls();
            FakeAndroidUiCalls ui = new FakeAndroidUiCalls(5, 33);
            FakeAndroidCalls calls = new FakeAndroidCalls(); calls.deleteResult = 1;
            LogPage.setPageLaunchCallsForTest(launcher);
            LogPage.setAndroidUiCallsForTest(ui);
            LogPage.setAndroidCallsForTest(calls);
            FakeSettingsActivity activity = new FakeSettingsActivity(external, cache, 5, true);
            LogPage.attachActivity(activity);
            ui.awaitRenderCount(1);
            LogPage.Controller controller = registeredController(activity);
            LogStore.Entry entry = controllerResult(controller).entries.get(0);
            FakeOtherActivity otherHost = new FakeOtherActivity(external, cache, 5, true);
            LogPage.onActivityResult(otherHost, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK,
                new FakeResultIntent(new AndroidFakeUri("content", "content://private/other-host")));
            LogPage.onActivityResult(activity, LogPage.EXPORT_REQUEST_CODE + 1, LogPage.RESULT_OK,
                new FakeResultIntent(new AndroidFakeUri("content", "content://private/other-request")));
            check(calls.openCalls == 0 && calls.activity == null,
                "a different Activity and request code cannot open or consume the current SAF target");

            controller.select(entry);
            ui.awaitRenderCount(3);
            controller.exportSelected(cache);
            check(calls.startedLatch.await(5, java.util.concurrent.TimeUnit.SECONDS),
                "the production Controller and AndroidHost reach the injected SAF platform call");
            check(calls.activity == activity && calls.requestCode == 0x6c67
                && "android.intent.action.CREATE_DOCUMENT".equals(calls.intent.action)
                && "android.intent.category.OPENABLE".equals(calls.intent.category)
                && "text/plain".equals(calls.intent.mime)
                && Boolean.TRUE.equals(calls.intent.extras.get("android.intent.extra.LOCAL_ONLY"))
                && calls.intent.extras.get("android.intent.extra.TITLE") instanceof String,
                "the current log Activity receives the existing CREATE_DOCUMENT action, request, MIME and typed extras");
            FakeSettingsActivity wrongSettingsOwner = new FakeSettingsActivity(external, cache, 6, true);
            LogPage.onActivityResult(wrongSettingsOwner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK,
                new FakeResultIntent(new AndroidFakeUri("content", "content://private/wrong-owner")));
            check(calls.openCalls == 0, "a second valid log Activity cannot consume the first Activity's session");

            AndroidFakeUri uri = new AndroidFakeUri("content", "content://private/target/path-secret");
            FakeResultIntent result = new FakeResultIntent(uri);
            LogPage.onActivityResult(activity, 0x6c67, LogPage.RESULT_OK, result);
            awaitCondition("the Activity-owned SAF output closes", new Condition() {
                @Override public boolean ready() { return calls.output.closed; }
            });
            check(calls.openCalls == 1 && calls.output.allWritesSafe("saf-secret", "student=827361", "content://private", "path-secret")
                && ui.toasts.contains("导出成功"),
                "the Activity-owned Controller writes only sanitized snapshot bytes and reports fixed success");
            LogPage.onActivityResult(activity, 0x6c67, LogPage.RESULT_OK, result);
            LogPage.onActivityResult(new FakePageFragment(activity), 0x6c67, LogPage.RESULT_OK, result);
            check(calls.openCalls == 1 && calls.output.closeCalls == 1,
                "duplicate and original Mine Fragment callbacks cannot write or close the completed target again");
            LogPage.onDestroy(activity);
            LogPage.onActivityResult(activity, 0x6c67, LogPage.RESULT_OK, result);
            check(calls.openCalls == 1 && ui.backUnregistrations == 1,
                "destroy removes the Activity registry and unregisters the API 33 callback once");

            FakeAndroidUiCalls brokenUi = new FakeAndroidUiCalls(7, 33); brokenUi.failOpen = true;
            LogPage.setAndroidUiCallsForTest(brokenUi);
            FakeSettingsActivity broken = new FakeSettingsActivity(external, cache, 7, true);
            LogPage.attachActivity(broken);
            check(brokenUi.toasts.equals(Collections.singletonList("日志页暂不可用"))
                && brokenUi.finishCount == 1 && brokenUi.openCount == 1
                && brokenUi.toasts.toString().indexOf("view-path-secret") < 0,
                "native page initialization failure exits through the one fixed notice without exposing exception text");
            LogPage.onDestroy(broken);
        } finally {
            LogPage.setPageLaunchCallsForTest(null);
            LogPage.setAndroidUiCallsForTest(null);
            LogPage.setAndroidCallsForTest(null);
            deleteTree(root);
        }
    }

    private static void testActivityOwnedExportStagesSurviveRecreation() throws Exception {
        File root = cacheTemp("calendar-tab-r4-export-recreation-");
        try {
            File external = new File(root, "external"); check(external.mkdirs(), "the export lifecycle external-files root exists");
            File cache = new File(root, "cache"); check(cache.mkdirs(), "the export lifecycle cache exists");
            File logs = CrashLog.logDirectory(external); check(logs.mkdirs(), "the export lifecycle log folder exists");
            writeUtf8(new File(logs, "crash-20261014-040506-007-15.txt"),
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\nstudent=827361 password=lifecycle-secret\n");
            LogPage.setPageLaunchCallsForTest(new FakePageLaunchCalls());

            FakeAndroidCalls waitingCalls = new FakeAndroidCalls(); waitingCalls.deleteResult = 1;
            FakeAndroidUiCalls waitingUi = new FakeAndroidUiCalls(8, 33);
            LogPage.setAndroidCallsForTest(waitingCalls);
            LogPage.setAndroidUiCallsForTest(waitingUi);
            FakeSettingsActivity waitingActivity = new FakeSettingsActivity(external, cache, 8, true);
            LogPage.attachActivity(waitingActivity);
            waitingUi.awaitRenderCount(1);
            LogPage.Controller waitingController = registeredController(waitingActivity);
            LogStore.Entry entry = controllerResult(waitingController).entries.get(0);
            waitingController.select(entry);
            waitingUi.awaitRenderCount(2);
            waitingController.exportSelected(cache);
            check(waitingCalls.startedLatch.await(5, java.util.concurrent.TimeUnit.SECONDS),
                "the production Activity enters the SAF waiting phase after creating its snapshot");
            Object waitingSession = activeSession(waitingController);
            File waitingSnapshot = activeSnapshot(waitingSession);
            check("WAITING_RESULT".equals(activeSessionState(waitingSession)) && waitingSnapshot != null && waitingSnapshot.isFile(),
                "the Activity-owned production session is WAITING_RESULT with a retained frozen snapshot");

            LogPage.onDestroy(waitingActivity);
            FakeAndroidUiCalls waitingRecreatedUi = new FakeAndroidUiCalls(9, 33);
            LogPage.setAndroidUiCallsForTest(waitingRecreatedUi);
            FakeSettingsActivity waitingRecreated = new FakeSettingsActivity(external, cache, 9, true);
            LogPage.attachActivity(waitingRecreated);
            waitingRecreatedUi.awaitRenderCount(1);
            awaitCondition("the WAITING_RESULT recreation finishes its fresh list read", new Condition() {
                @Override public boolean ready() {
                    try { return controllerResult(registeredController(waitingRecreated)).entries.size() == 1; }
                    catch (Exception failure) { return false; }
                }
            });
            String waitingFreshSnapshot = viewSnapshot(waitingRecreatedUi.lastBody);
            int waitingFreshRenderCount = waitingRecreatedUi.renderCount;
            LogPage.onActivityResult(waitingActivity, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK,
                new FakeResultIntent(new AndroidFakeUri("content", "content://private/waiting-stale")));
            awaitCondition("destroying WAITING_RESULT removes its production snapshot", new Condition() {
                @Override public boolean ready() { return !waitingSnapshot.exists(); }
            });
            check(waitingCalls.openCalls == 0 && viewSnapshot(waitingRecreatedUi.lastBody).equals(waitingFreshSnapshot)
                && waitingRecreatedUi.renderCount == waitingFreshRenderCount && waitingRecreatedUi.finishCount == 0,
                "the stale WAITING_RESULT callback cannot write or change the recreated Activity's fresh list");
            LogPage.onDestroy(waitingRecreated);

            FakeAndroidCalls writingCalls = new FakeAndroidCalls(); writingCalls.deleteResult = 1;
            BlockingOutput writingOutput = new BlockingOutput(); writingCalls.targetOutput = writingOutput;
            FakeAndroidUiCalls writingUi = new FakeAndroidUiCalls(10, 32);
            LogPage.setAndroidCallsForTest(writingCalls);
            LogPage.setAndroidUiCallsForTest(writingUi);
            FakeSettingsActivity writingActivity = new FakeSettingsActivity(external, cache, 10, true);
            LogPage.attachActivity(writingActivity);
            writingUi.awaitRenderCount(1);
            LogPage.Controller writingController = registeredController(writingActivity);
            LogStore.Entry writingEntry = controllerResult(writingController).entries.get(0);
            writingController.select(writingEntry);
            writingUi.awaitRenderCount(2);
            writingController.exportSelected(cache);
            check(writingCalls.startedLatch.await(5, java.util.concurrent.TimeUnit.SECONDS),
                "the second production Activity reaches its SAF waiting phase");
            Object writingSession = activeSession(writingController);
            File writingSnapshot = activeSnapshot(writingSession);
            LogPage.onActivityResult(writingActivity, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK,
                new FakeResultIntent(new AndroidFakeUri("content", "content://private/writing-target")));
            check(writingOutput.entered.await(5, java.util.concurrent.TimeUnit.SECONDS),
                "the actual Activity result advances the production AndroidHost into a blocked target write");
            check("WRITING".equals(activeSessionState(writingSession)),
                "the production session is observably WRITING while its target stream is active");
            LogPage.onDestroy(writingActivity);
            FakeAndroidUiCalls writingRecreatedUi = new FakeAndroidUiCalls(11, 33);
            LogPage.setAndroidUiCallsForTest(writingRecreatedUi);
            FakeSettingsActivity writingRecreated = new FakeSettingsActivity(external, cache, 11, true);
            LogPage.attachActivity(writingRecreated);
            writingRecreatedUi.awaitRenderCount(1);
            awaitCondition("the WRITING recreation finishes its fresh list read", new Condition() {
                @Override public boolean ready() {
                    try { return controllerResult(registeredController(writingRecreated)).entries.size() == 1; }
                    catch (Exception failure) { return false; }
                }
            });
            String writingFreshSnapshot = viewSnapshot(writingRecreatedUi.lastBody);
            int writingFreshRenderCount = writingRecreatedUi.renderCount;
            LogPage.onActivityResult(writingActivity, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK,
                new FakeResultIntent(new AndroidFakeUri("content", "content://private/writing-stale")));
            check(writingOutput.closed.await(5, java.util.concurrent.TimeUnit.SECONDS)
                && writingCalls.deletedLatch.await(5, java.util.concurrent.TimeUnit.SECONDS),
                "destroying WRITING closes the active target stream and deletes the possibly partial target");
            awaitCondition("destroying WRITING removes its production snapshot", new Condition() {
                @Override public boolean ready() { return writingSnapshot != null && !writingSnapshot.exists(); }
            });
            check(writingOutput.closeCalls == 1 && writingCalls.openCalls == 1 && writingCalls.deleteCalls == 1
                && viewSnapshot(writingRecreatedUi.lastBody).equals(writingFreshSnapshot)
                && writingRecreatedUi.renderCount == writingFreshRenderCount
                && writingRecreatedUi.finishCount == 0,
                "the stale WRITING result cannot repeat resource cleanup or change the recreated list");
            LogPage.onDestroy(writingRecreated);

            FakeAndroidCalls finalizingCalls = new FakeAndroidCalls(); finalizingCalls.deleteResult = 1;
            FakeAndroidUiCalls finalizingUi = new FakeAndroidUiCalls(12, 32);
            LogPage.setAndroidCallsForTest(finalizingCalls);
            LogPage.setAndroidUiCallsForTest(finalizingUi);
            FakeSettingsActivity finalizingActivity = new FakeSettingsActivity(external, cache, 12, true);
            LogPage.attachActivity(finalizingActivity);
            finalizingUi.awaitRenderCount(1);
            LogPage.Controller finalizingController = registeredController(finalizingActivity);
            LogStore.Entry finalizingEntry = controllerResult(finalizingController).entries.get(0);
            finalizingController.select(finalizingEntry);
            finalizingUi.awaitRenderCount(2);
            finalizingController.exportSelected(cache);
            check(finalizingCalls.startedLatch.await(5, java.util.concurrent.TimeUnit.SECONDS),
                "the third production Activity reaches its SAF waiting phase");
            final Object finalizingSession = activeSession(finalizingController);
            final Object finalizingLock = activeSessionLock(finalizingSession);
            final CountDownLatch finalizingLockHeld = new CountDownLatch(1);
            final CountDownLatch releaseFinalizingLock = new CountDownLatch(1);
            final AtomicReference<Throwable> phaseFailure = new AtomicReference<Throwable>();
            final AtomicReference<Throwable> callbackFailure = new AtomicReference<Throwable>();
            final Thread finalizingObserver = new Thread(new Runnable() {
                @Override public void run() {
                    long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
                    try {
                        while (System.nanoTime() < deadline) {
                            if ("FINALIZING".equals(activeSessionState(finalizingSession))) {
                                synchronized (finalizingLock) {
                                    finalizingLockHeld.countDown();
                                    if (!releaseFinalizingLock.await(5, java.util.concurrent.TimeUnit.SECONDS)) {
                                        throw new IOException("finalizing test latch timeout");
                                    }
                                }
                                return;
                            }
                            Thread.yield();
                        }
                        throw new IOException("production FINALIZING state was not observed");
                    } catch (Throwable failure) {
                        phaseFailure.set(failure);
                        finalizingLockHeld.countDown();
                    }
                }
            }, "calendar-tab-r4-finalizing-observer");
            finalizingObserver.setDaemon(true);
            finalizingObserver.start();
            Thread finalizingCallback = new Thread(new Runnable() {
                @Override public void run() {
                    try {
                        LogPage.onActivityResult(finalizingActivity, LogPage.EXPORT_REQUEST_CODE, 0, null);
                    } catch (Throwable failure) { callbackFailure.set(failure); }
                }
            }, "calendar-tab-r4-finalizing-callback");
            finalizingCallback.setDaemon(true);
            finalizingCallback.start();
            Thread finalizingDestroy = null;
            try {
                check(finalizingLockHeld.await(5, java.util.concurrent.TimeUnit.SECONDS) && phaseFailure.get() == null,
                    "the real Activity result enters FINALIZING and the test holds that production phase for lifecycle overlap");

                finalizingDestroy = new Thread(new Runnable() {
                    @Override public void run() { LogPage.onDestroy(finalizingActivity); }
                }, "calendar-tab-r4-finalizing-destroy");
                finalizingDestroy.setDaemon(true);
                finalizingDestroy.start();
                awaitCondition("FINALIZING Activity is removed from the production registry before detach completes", new Condition() {
                    @Override public boolean ready() {
                        try { return !hasRegisteredController(finalizingActivity); }
                        catch (Exception failure) { throw new AssertionError(failure); }
                    }
                });
                FakeAndroidUiCalls finalizingRecreatedUi = new FakeAndroidUiCalls(13, 33);
                LogPage.setAndroidUiCallsForTest(finalizingRecreatedUi);
                FakeSettingsActivity finalizingRecreated = new FakeSettingsActivity(external, cache, 13, true);
                LogPage.attachActivity(finalizingRecreated);
                finalizingRecreatedUi.awaitRenderCount(1);
                awaitCondition("the FINALIZING recreation finishes its fresh list read", new Condition() {
                    @Override public boolean ready() {
                        try { return controllerResult(registeredController(finalizingRecreated)).entries.size() == 1; }
                        catch (Exception failure) { return false; }
                    }
                });
                String finalizingFreshSnapshot = viewSnapshot(finalizingRecreatedUi.lastBody);
                int finalizingFreshRenderCount = finalizingRecreatedUi.renderCount;
                LogPage.onActivityResult(finalizingActivity, LogPage.EXPORT_REQUEST_CODE, 0, null);
                check(viewSnapshot(finalizingRecreatedUi.lastBody).equals(finalizingFreshSnapshot)
                    && finalizingRecreatedUi.renderCount == finalizingFreshRenderCount
                    && finalizingRecreatedUi.finishCount == 0,
                    "the production FINALIZING cancellation and old Activity callback do not alter the recreated list");
                LogPage.onDestroy(finalizingRecreated);
            } finally {
                releaseFinalizingLock.countDown();
                finalizingCallback.join(5000L);
                if (finalizingDestroy != null) finalizingDestroy.join(5000L);
                finalizingObserver.join(5000L);
            }
            check(!finalizingCallback.isAlive() && (finalizingDestroy == null || !finalizingDestroy.isAlive())
                && !finalizingObserver.isAlive() && callbackFailure.get() == null && phaseFailure.get() == null,
                "the production finalization and Activity detach both complete once the controlled phase is released");
        } finally {
            LogPage.setPageLaunchCallsForTest(null);
            LogPage.setAndroidUiCallsForTest(null);
            LogPage.setAndroidCallsForTest(null);
            deleteTree(root);
        }
    }

    private static void testDeleteExceptionUsesFixedResidualMessage() throws Exception {
        File root = cacheTemp("calendar-tab-r3-delete-exception-");
        try {
            File directory = new File(root, "logs"); check(directory.mkdirs(), "delete-exception source root is created");
            FixtureSource source = new FixtureSource("app", "应用目录", directory);
            LogStore.Entry entry = source.add("crash-20261012-010813-013-12.txt", 1000L,
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\n");
            LogStore store = new LogStore(Collections.<LogStore.Source>singletonList(source));
            Object owner = new Object(); FakeAndroidCalls calls = new FakeAndroidCalls(); calls.openThrows = false; calls.deleteThrows = true;
            calls.output.failWrite = true;
            ManualHost host = new ManualHost(); host.targetAdapter = new LogPage.AndroidHost(owner, owner, calls);
            LogPage.Controller controller = new LogPage.Controller(owner, store, host);
            readyController(controller, host, entry);
            controller.exportSelected(root); host.runNextIo();
            String sensitiveUri = "content://private/export/path-secret";
            controller.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK,
                new AndroidFakeUri("content", sensitiveUri));
            host.runAllIo();
            String residual = "导出失败，可能留下不完整文件，请检查所选位置";
            check(calls.deleteCalls == 1 && residual.equals(last(host.toasts)),
                "production Controller reaches the fixed residual-file message when production AndroidHost deletion throws");
            check(!last(host.toasts).contains(sensitiveUri) && !last(host.toasts).contains("path-secret")
                && !last(host.toasts).contains("content://"),
                "residual-file message does not echo the target URI or path");
            controller.close();

            AtomicInteger inputCloses = new AtomicInteger();
            Object closeOwner = new Object(); FakeAndroidCalls closeCalls = new FakeAndroidCalls();
            closeCalls.output.failClose = true; closeCalls.deleteResult = 1;
            ManualHost suppressedHost = new ManualHost(); suppressedHost.targetAdapter = new LogPage.AndroidHost(closeOwner, closeOwner, closeCalls);
            FaultInput suppressedInput = new FaultInput("sanitized snapshot\n".getBytes("UTF-8"), false, true, inputCloses);
            suppressedHost.snapshotInputOverride = suppressedInput;
            LogPage.Controller suppressed = new LogPage.Controller(closeOwner, store, suppressedHost);
            readyController(suppressed, suppressedHost, entry);
            suppressed.exportSelected(root); suppressedHost.runNextIo();
            suppressed.onActivityResult(closeOwner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK,
                new AndroidFakeUri("content", "content://private/export/other-path"));
            suppressedHost.runAllIo();
            check(closeCalls.output.closeCalls == 1 && inputCloses.get() == 1 && closeCalls.deleteCalls == 1
                && closeCalls.output.closeFailure != null && closeCalls.output.closeFailure.getSuppressed().length == 1
                && closeCalls.output.closeFailure.getSuppressed()[0] == suppressedInput.closeFailure
                && "导出失败，源日志未修改".equals(last(suppressedHost.toasts)),
                "the input close exception is actually suppressed under output close, while successful delete keeps the fixed non-residual classification");
            suppressed.close();
        } finally { deleteTree(root); }
    }

    private static void testOrphanCleanupDuringWritingAndCancellation() throws Exception {
        File root = cacheTemp("calendar-tab-r3-orphan-phases-");
        try {
            File cache = new File(root, "cache"); check(cache.mkdirs(), "orphan phase cache directory is created");
            File logs = new File(root, "logs"); check(logs.mkdirs(), "orphan phase log source is created");
            FixtureSource source = new FixtureSource("app", "应用目录", logs);
            LogStore.Entry entry = source.add("crash-20261012-010814-014-12.txt", 1000L,
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\n");
            LogStore store = new LogStore(Collections.<LogStore.Source>singletonList(source));
            Object owner = new Object(); ManualHost host = new ManualHost();
            LogPage.Controller controller = new LogPage.Controller(owner, store, host);
            readyController(controller, host, entry);
            controller.exportSelected(cache); host.runNextIo();
            File[] active = host.cacheFiles(cache);
            check(active.length == 1, "prepared snapshot is registered before the writer starts");
            controller.onActivityResult(owner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content"));
            File exportRoot = new File(cache, LogStore.EXPORT_FOLDER);
            File writingOrphan = new File(exportRoot, LogStore.EXPORT_PREFIX + "123e4567-e89b-12d3-a456-426614174010.tmp");
            writeUtf8(writingOrphan, "orphan-writing");
            LogPage.cleanupOrphanSnapshots(cache);
            check(active[0].isFile() && !writingOrphan.exists(),
                "production orphan cleanup during WRITING preserves the active snapshot and deletes an inactive valid orphan");

            controller.close();
            File cancelledOrphan = new File(exportRoot, LogStore.EXPORT_PREFIX + "123e4567-e89b-12d3-a456-426614174011.tmp");
            writeUtf8(cancelledOrphan, "orphan-cancelled");
            LogPage.cleanupOrphanSnapshots(cache);
            check(active[0].isFile() && !cancelledOrphan.exists(),
                "production orphan cleanup during cancelled-session cleanup still preserves the owned snapshot");
            host.runAllIo();
            check(!active[0].exists() && host.cacheFiles(cache).length == 0,
                "once the cancelled writer confirms cleanup, its snapshot is released");
        } finally { deleteTree(root); }
    }

    private static void testExactLimitsAndUtf8Prefix() throws Exception {
        File root = cacheTemp("calendar-tab-r2-limits-");
        try {
            File directory = new File(root, "Download/wakeup-noads"); check(directory.mkdirs(), "limit history source directory is created");
            LogStore.LegacyDownloadSource source = new LogStore.LegacyDownloadSource(directory);
            int[] copySizes = new int[] { 65535, 65536, 65537 };
            String[] copyNames = new String[copySizes.length];
            for (int index = 0; index < copySizes.length; index++) {
                copyNames[index] = "crash-20261012-01061" + index + "-001-12.txt";
                writeBoundarySource(directory, copyNames[index], index + 1L, copySizes[index]);
            }
            int[] previewSizes = new int[] { 262143, 262144, 262145 };
            String[] previewNames = new String[previewSizes.length];
            for (int index = 0; index < previewSizes.length; index++) {
                previewNames[index] = "exit-20261012-01062" + index + "-001-12.txt";
                writeBoundarySource(directory, previewNames[index], 10L - index, previewSizes[index]);
            }
            LogStore store = new LogStore(Collections.<LogStore.Source>singletonList(source));
            int copyMarkerBytes = "\n[truncated]\n".getBytes("UTF-8").length;
            for (int index = 0; index < copySizes.length; index++) {
                LogStore.Entry entry = legacyEntryByName(source, copyNames[index]);
                String expected = exactBoundaryExpected(copySizes[index]);
                LogStore.CopyText copy = store.copyText(entry);
                int actualBytes = copy.text.getBytes("UTF-8").length;
                check(copy.truncated == (copySizes[index] > LogStore.COPY_LIMIT)
                    && actualBytes == Math.min(copySizes[index], LogStore.COPY_LIMIT),
                    "copyText exact boundary " + copySizes[index] + " bytes reports and budgets truncation correctly");
                String expectedCopy = copySizes[index] > LogStore.COPY_LIMIT
                    ? expected.substring(0, LogStore.COPY_LIMIT - copyMarkerBytes) + "\n[truncated]\n" : expected;
                check(expectedCopy.equals(copy.text), "history copy at " + copySizes[index] + " bytes matches an independent B01-safe expected body");
            }
            int previewMarkerBytes = "\n[truncated]\n".getBytes("UTF-8").length;
            LogStore.Entry exportBoundary = null;
            for (int index = 0; index < previewSizes.length; index++) {
                LogStore.Entry entry = legacyEntryByName(source, previewNames[index]);
                String expected = exactBoundaryExpected(previewSizes[index]);
                LogStore.Preview preview = store.preview(entry);
                String expectedPreview = previewSizes[index] > LogStore.PREVIEW_LIMIT
                    ? expected.substring(0, LogStore.PREVIEW_LIMIT) + "\n[truncated]\n" : expected;
                int expectedBytes = previewSizes[index] <= LogStore.PREVIEW_LIMIT
                    ? previewSizes[index] : LogStore.PREVIEW_LIMIT + "\n[truncated]\n".getBytes("UTF-8").length;
                check(preview.truncated == (previewSizes[index] > LogStore.PREVIEW_LIMIT)
                    && preview.text.getBytes("UTF-8").length == expectedBytes && expectedPreview.equals(preview.text),
                    "history preview exact boundary " + previewSizes[index] + " bytes matches its independent B01-safe expected body");
                if (previewSizes[index] == 262145) exportBoundary = entry;
            }

            for (int index : new int[] { 0, 2 }) {
                int size = index == 0 ? copySizes[0] : previewSizes[2];
                String raw = exactBoundaryRaw(size);
                String expected = exactBoundaryExpected(size);
                File automatic = CrashLog.writeAutomaticLog(new File(root, "automatic-" + size),
                    "crash-20261012-010699-001-12.txt", raw);
                check(Arrays.equals(expected.getBytes("UTF-8"), Files.readAllBytes(automatic.toPath())),
                    "complete automatic sink at " + size + " bytes matches the independent B01-safe expected body");
            }
            String largeBoundaryRaw = exactBoundaryRaw(262145);
            RecordingOutput boundaryWrites = new RecordingOutput();
            LogStore.writeSanitizedSnapshot(new ByteArrayInputStream(largeBoundaryRaw.getBytes("UTF-8")), boundaryWrites);
            check(boundaryWrites.allWritesSafe("Alice Example", "Student827361", "827361", "boundary-secret")
                && Arrays.equals(exactBoundaryExpected(262145).getBytes("UTF-8"), boundaryWrites.toByteArray()),
                "each large sink write and its cumulative bytes exclude B01 values and match the independent safe-stack expected body");

            check(exportBoundary != null, "the largest preview-boundary sample exists for full export");
            byte[] sourceBefore = Files.readAllBytes(((File) exportBoundary.handle).toPath());
            String fullExpected = exactBoundaryExpected(262145);
            File snapshot = store.snapshot(exportBoundary, root);
            try {
                check(Arrays.equals(fullExpected.getBytes("UTF-8"), Files.readAllBytes(snapshot.toPath()))
                    && Files.readAllBytes(snapshot.toPath()).length == 262145,
                    "complete history snapshot matches the independent B01-safe 262145-byte output beyond preview/copy limits");
            } finally { LogPage.deleteSnapshotForTest(snapshot); }
            check(Arrays.equals(sourceBefore, Files.readAllBytes(((File) exportBoundary.handle).toPath())),
                "boundary export never changes the source file");

            Object targetOwner = new Object(); ManualHost targetHost = new ManualHost();
            LogPage.Controller targetController = new LogPage.Controller(targetOwner, store, targetHost);
            targetController.present(); targetHost.runAllIo();
            LogStore.Entry listedExportBoundary = null;
            for (LogStore.Entry candidate : lastState(targetHost.states).result.entries) {
                if (exportBoundary.fileName.equals(candidate.fileName)) listedExportBoundary = candidate;
            }
            check(listedExportBoundary != null, "production history listing returns the large export boundary entry");
            targetController.select(listedExportBoundary); targetHost.runAllIo();
            targetController.exportSelected(root); targetHost.runNextIo();
            check(targetController.onActivityResult(targetOwner, LogPage.EXPORT_REQUEST_CODE, LogPage.RESULT_OK, new FakeUri("content")),
                "large history boundary enters the production target-write flow");
            targetHost.runAllIo();
            check(targetHost.target != null && Arrays.equals(fullExpected.getBytes("UTF-8"), targetHost.target.toByteArray())
                && targetHost.target.closeCalls == 1 && targetHost.toasts.contains("导出成功"),
                "full target write above both UI limits equals the independent B01-safe expected bytes and closes once");
            targetController.close();
            check(Arrays.equals(sourceBefore, Files.readAllBytes(((File) exportBoundary.handle).toPath())),
                "large target write leaves the legacy source unchanged");

            java.lang.reflect.Method helper = LogStore.class.getDeclaredMethod("safeUtf8Prefix", byte[].class, int.class);
            helper.setAccessible(true);
            byte[] bytes = "Aé中🙂\r\nZ".getBytes("UTF-8");
            String[] expectedByBudget = new String[] {
                "", "A", "A", "Aé", "Aé", "Aé", "Aé中", "Aé中", "Aé中", "Aé中", "Aé中🙂",
                "Aé中🙂", "Aé中🙂\r\n", "Aé中🙂\r\nZ"
            };
            for (int budget = 0; budget < expectedByBudget.length; budget++) {
                int prefix = ((Integer) helper.invoke(null, bytes, budget)).intValue();
                String actual = new String(bytes, 0, prefix, "UTF-8");
                check(expectedByBudget[budget].equals(actual), "safeUtf8Prefix boundary " + budget + " preserves ASCII/2/3/4-byte and CRLF boundaries");
                check(!actual.contains("\uFFFD"), "safeUtf8Prefix boundary " + budget + " has no replacement character");
            }
            int copyBudget = LogStore.COPY_LIMIT - "\n[truncated]\n".getBytes("UTF-8").length;
            byte[] copyEdge = (repeat('x', copyBudget - 1) + "éQ").getBytes("UTF-8");
            int copyPrefix = ((Integer) helper.invoke(null, copyEdge, copyBudget)).intValue();
            int asciiPrefix = ((Integer) helper.invoke(null, repeat('x', copyBudget + 5).getBytes("UTF-8"), copyBudget)).intValue();
            check(copyPrefix == copyBudget - 1 && asciiPrefix + "\n[truncated]\n".getBytes("UTF-8").length == LogStore.COPY_LIMIT,
                "copy truncation subtracts marker bytes and stays within budget when a multibyte character crosses the boundary");
        } finally { deleteTree(root); }
    }

    private static void writeBoundarySource(File directory, String name, long modified, int outputBytes) throws IOException {
        File file = new File(directory, name);
        writeUtf8(file, exactBoundaryRaw(outputBytes));
        file.setLastModified(modified);
    }

    private static LogStore.Entry legacyEntryByName(LogStore.LegacyDownloadSource source, String fileName) throws Exception {
        LogStore.Scan scan = source.scan();
        for (LogStore.Entry entry : scan.entries) if (fileName.equals(entry.fileName)) return entry;
        throw new AssertionError("legacy source did not accept the expected boundary entry: " + fileName);
    }

    private static String exactBoundaryRaw(int outputBytes) throws IOException {
        String expectedPrefix = exactBoundaryExpectedPrefix();
        int remaining = outputBytes - expectedPrefix.getBytes("UTF-8").length;
        if (remaining < 0) throw new IOException("safe log fixture too small for requested byte count");
        String rawPrefix = "wakeup-noads crash log\nabi: Alice Example\nversion: Student827361 (42)\n"
            + "package: io.github.wakeupnoads\n\tat com.example.Safe.run(Safe.java:12)\n"
            + "student=827361 password=boundary-secret\n";
        StringBuilder builder = new StringBuilder(rawPrefix.length() + remaining);
        builder.append(rawPrefix);
        for (int index = 0; index < remaining; index++) builder.append('\n');
        return builder.toString();
    }

    private static String exactBoundaryExpected(int outputBytes) throws IOException {
        String expectedPrefix = exactBoundaryExpectedPrefix();
        int remaining = outputBytes - expectedPrefix.getBytes("UTF-8").length;
        if (remaining < 0) throw new IOException("safe expected log too small for requested byte count");
        StringBuilder builder = new StringBuilder(outputBytes);
        builder.append(expectedPrefix);
        for (int index = 0; index < remaining; index++) builder.append('\n');
        return builder.toString();
    }

    private static String exactBoundaryExpectedPrefix() {
        return "wakeup-noads crash log\nabi: [redacted]\nversion: [redacted]\n"
            + "package: io.github.wakeupnoads\n\tat com.example.Safe.run(Safe.java:12)\n[redacted]\n";
    }

    private static String repeat(char value, int count) {
        StringBuilder builder = new StringBuilder(count);
        for (int index = 0; index < count; index++) builder.append(value);
        return builder.toString();
    }

    private static void testSnapshotCleanupAndDocumentAdapter() throws Exception {
        File root = cacheTemp("calendar-tab-r2-cleanup-");
        try {
            File cache = new File(root, "cache"); check(cache.mkdirs(), "cacheDir fixture is created");
            File exportRoot = new File(cache, LogStore.EXPORT_FOLDER); check(exportRoot.mkdirs(), "dedicated export root is created");
            String uuid = "123e4567-e89b-12d3-a456-426614174000";
            File orphan = new File(exportRoot, LogStore.EXPORT_PREFIX + uuid + ".tmp"); writeUtf8(orphan, "orphan");
            File invalidName = new File(exportRoot, LogStore.EXPORT_PREFIX + "not-a-uuid.tmp"); writeUtf8(invalidName, "keep");
            File ordinary = new File(exportRoot, "notes.txt"); writeUtf8(ordinary, "keep");
            File nestedDirectory = new File(exportRoot, "nested"); check(nestedDirectory.mkdirs(), "nested invalid location is created");
            File nested = new File(nestedDirectory, LogStore.EXPORT_PREFIX + "123e4567-e89b-12d3-a456-426614174001.tmp"); writeUtf8(nested, "keep");
            File outside = new File(root, LogStore.EXPORT_PREFIX + "123e4567-e89b-12d3-a456-426614174002.tmp"); writeUtf8(outside, "keep");
            LogStore.assertSnapshot(cache, orphan);
            boolean invalidRejected = false, nestedRejected = false;
            try { LogStore.assertSnapshot(cache, invalidName); } catch (IOException expected) { invalidRejected = true; }
            try { LogStore.assertSnapshot(cache, nested); } catch (IOException expected) { nestedRejected = true; }
            check(invalidRejected && nestedRejected, "production snapshot assertions require complete UUID names and the canonical root itself");

            File logs = new File(root, "logs"); check(logs.mkdirs(), "active snapshot source directory is created");
            File sourceLog = new File(logs, "crash-20261012-010701-001-12.txt");
            writeUtf8(sourceLog, "wakeup-noads crash log\npackage: io.github.wakeupnoads\nsource-log-secret\n");
            FixtureSource source = new FixtureSource("app", "应用目录", logs);
            LogStore.Entry entry = source.add("crash-20261012-010701-001-12.txt", 1L,
                "wakeup-noads crash log\npackage: io.github.wakeupnoads\n");
            byte[] sourceLogBeforeCleanup = Files.readAllBytes(sourceLog.toPath());
            LogStore store = new LogStore(Collections.<LogStore.Source>singletonList(source));
            Object ownerA = new Object(), ownerB = new Object();
            ManualHost hostA = new ManualHost(), hostB = new ManualHost();
            LogPage.Controller controllerA = new LogPage.Controller(ownerA, store, hostA);
            LogPage.Controller controllerB = new LogPage.Controller(ownerB, store, hostB);
            readyController(controllerA, hostA, entry); readyController(controllerB, hostB, entry);
            controllerA.exportSelected(cache); hostA.runNextIo();
            controllerB.exportSelected(cache); hostB.runNextIo();
            check(countNamed(exportRoot, "wakeup-noads-log-export-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp") == 3,
                "two different fragment sessions hold distinct active snapshots beside the orphan");
            LogPage.cleanupOrphanSnapshots(cache);
            check(!orphan.exists() && invalidName.exists() && ordinary.exists() && nested.exists() && outside.exists()
                && countNamed(exportRoot, "wakeup-noads-log-export-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp") == 2,
                "orphan cleanup removes only a valid UUID file in its own root and preserves active/cross-host/ordinary/outside files");
            check(sourceLog.isFile() && Arrays.equals(sourceLogBeforeCleanup, Files.readAllBytes(sourceLog.toPath())),
                "snapshot cleanup leaves the source log file and its bytes untouched");
            controllerA.onActivityResult(ownerA, LogPage.EXPORT_REQUEST_CODE, 0, null);
            controllerB.onActivityResult(ownerB, LogPage.EXPORT_REQUEST_CODE, 0, null);
            check(countNamed(exportRoot, "wakeup-noads-log-export-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp") == 0,
                "ending each active session removes its own snapshot after cleanup confirmation");
            controllerA.close(); controllerB.close();

            final File escapedTarget = new File(exportRoot, LogStore.EXPORT_PREFIX + "123e4567-e89b-12d3-a456-426614174003.tmp");
            writeUtf8(escapedTarget, "protected");
            LogStore.CanonicalPaths escaping = new LogStore.CanonicalPaths() {
                @Override public String canonicalPath(File file) throws IOException {
                    if (file.equals(cache)) return "D:\\trusted\\cache";
                    if (file.equals(exportRoot) || file.equals(escapedTarget.getParentFile())) return "D:\\outside\\export";
                    if (file.equals(escapedTarget)) return "D:\\outside\\export\\" + escapedTarget.getName();
                    return file.getCanonicalPath();
                }
            };
            boolean escapedRootRejected = false;
            try { LogStore.assertSnapshot(cache, escapedTarget, escaping); } catch (IOException expected) { escapedRootRejected = true; }
            check(escapedRootRejected && !LogPage.deleteSnapshotForTest(cache, escapedTarget, escaping) && escapedTarget.exists(),
                "canonical export-root escape is rejected by assertion and deletion without removing the file");
            LogPage.cleanupOrphanSnapshots(cache, escaping);
            check(escapedTarget.exists(), "cleanup with an escaped canonical export root leaves all files untouched");

            final Object activity = new Object(), uri = new Object();
            FakeAndroidCalls calls = new FakeAndroidCalls();
            LogPage.AndroidHost androidHost = new LogPage.AndroidHost(activity, activity, calls);
            androidHost.launchDocument("wakeup-noads-crash.txt", LogPage.EXPORT_REQUEST_CODE);
            check("android.intent.action.CREATE_DOCUMENT".equals(calls.intent.action)
                && "android.intent.category.OPENABLE".equals(calls.intent.category)
                && "text/plain".equals(calls.intent.mime)
                && "wakeup-noads-crash.txt".equals(calls.intent.extras.get("android.intent.extra.TITLE"))
                && Boolean.TRUE.equals(calls.intent.extras.get("android.intent.extra.LOCAL_ONLY"))
                && calls.activity == activity && calls.startedIntent == calls.intent
                && calls.requestCode == 0x6c67,
                "production AndroidHost.launchDocument builds and starts the same Intent with exact action/category/MIME/typed extras/request/current Activity owner");
            check(androidHost.openTarget(uri) == calls.output && calls.openedUri == uri,
                "production AndroidHost target adapter calls the injected platform with the selected URI");
            calls.deleteResult = 0;
            check(!androidHost.deleteTargetChecked(uri), "resolver delete count zero is classified as cleanup failure");
            calls.deleteResult = 1;
            check(androidHost.deleteTargetChecked(uri), "resolver delete count greater than zero is classified as cleanup success");
            calls.deleteThrows = true;
            boolean deleteThrew = false;
            try { androidHost.deleteTargetChecked(uri); } catch (IOException expected) { deleteThrew = true; }
            check(deleteThrew, "resolver delete exceptions propagate through the production adapter");
        } finally { deleteTree(root); }
    }

    private static void readyController(LogPage.Controller controller, ManualHost host, LogStore.Entry entry) {
        controller.present(); host.runAllIo(); controller.select(entry); host.runAllIo();
    }

    private static LogPage.Controller registeredController(Object activity) throws Exception {
        java.lang.reflect.Field field = LogPage.class.getDeclaredField("CONTROLLERS");
        field.setAccessible(true);
        @SuppressWarnings("unchecked") Map<Object, LogPage.Controller> controllers = (Map<Object, LogPage.Controller>) field.get(null);
        LogPage.Controller controller = controllers.get(activity);
        check(controller != null, "the production Activity registry owns the attached Controller");
        return controller;
    }

    private static LogPage.AndroidHost registeredHost(Object activity) throws Exception {
        LogPage.Controller controller = registeredController(activity);
        return androidHost(controller);
    }

    private static LogPage.AndroidHost androidHost(LogPage.Controller controller) throws Exception {
        java.lang.reflect.Field field = LogPage.Controller.class.getDeclaredField("host");
        field.setAccessible(true);
        return (LogPage.AndroidHost) field.get(controller);
    }

    private static LogPage.Controller startNativeController(FakeSettingsActivity activity, LogStore store,
                                                             FakeAndroidUiCalls ui) throws Exception {
        LogPage.AndroidHost host = new LogPage.AndroidHost(activity, activity, new FakeAndroidCalls(), ui);
        LogPage.Controller controller = new LogPage.Controller(activity, store, host);
        java.lang.reflect.Field field = LogPage.AndroidHost.class.getDeclaredField("controller");
        field.setAccessible(true);
        field.set(host, controller);
        controller.present();
        return controller;
    }

    private static LogStore.Result controllerResult(LogPage.Controller controller) throws Exception {
        java.lang.reflect.Field field = LogPage.Controller.class.getDeclaredField("result");
        field.setAccessible(true);
        return (LogStore.Result) field.get(controller);
    }

    private static LogPage.PageState controllerState(LogPage.Controller controller) throws Exception {
        java.lang.reflect.Field[] fields = LogPage.Controller.class.getDeclaredFields();
        java.lang.reflect.Field resultField = LogPage.Controller.class.getDeclaredField("result");
        resultField.setAccessible(true);
        java.lang.reflect.Field selectedField = LogPage.Controller.class.getDeclaredField("selected");
        selectedField.setAccessible(true);
        java.lang.reflect.Field previewField = LogPage.Controller.class.getDeclaredField("preview");
        previewField.setAccessible(true);
        java.lang.reflect.Field detailField = LogPage.Controller.class.getDeclaredField("detail");
        detailField.setAccessible(true);
        java.lang.reflect.Field exportPendingField = LogPage.Controller.class.getDeclaredField("session");
        exportPendingField.setAccessible(true);
        java.lang.reflect.Field messageField = LogPage.Controller.class.getDeclaredField("message");
        messageField.setAccessible(true);
        Object session = exportPendingField.get(controller);
        boolean busy = session != null && !activeSessionFinalized(session);
        return new LogPage.PageState((LogStore.Result) resultField.get(controller),
            (LogStore.Entry) selectedField.get(controller), (String) previewField.get(controller),
            detailField.getBoolean(controller), busy, (String) messageField.get(controller));
    }

    private static boolean activeSessionFinalized(Object session) throws Exception {
        java.lang.reflect.Field field = session.getClass().getDeclaredField("finalized");
        field.setAccessible(true);
        return field.getBoolean(session);
    }

    private static boolean containsText(FakeView root, String expected) {
        if (root == null) return false;
        if (root.text != null && root.text.contains(expected)) return true;
        for (FakeView child : new ArrayList<FakeView>(root.children)) if (containsText(child, expected)) return true;
        return false;
    }

    private static FakeView findTextContaining(FakeView root, String expected) {
        if (root == null) return null;
        if ("android.widget.TextView".equals(root.className) && root.text != null && root.text.contains(expected)) return root;
        for (FakeView child : new ArrayList<FakeView>(root.children)) {
            FakeView found = findTextContaining(child, expected);
            if (found != null) return found;
        }
        return null;
    }

    private static int countClass(FakeView root, String className) {
        if (root == null) return 0;
        int count = className.equals(root.className) ? 1 : 0;
        for (FakeView child : new ArrayList<FakeView>(root.children)) count += countClass(child, className);
        return count;
    }

    private static void collectViews(FakeView root, List<FakeView> output) {
        if (root == null) return;
        output.add(root);
        for (FakeView child : new ArrayList<FakeView>(root.children)) collectViews(child, output);
    }

    private static boolean isSecondaryLogText(String value) {
        return value.startsWith("正在") || value.startsWith("部分") || value.startsWith("日志来源")
            || value.startsWith("日志已消失") || value.startsWith("Java 崩溃 ·") || value.startsWith("系统退出 ·")
            || value.startsWith("历史 Download") || value.startsWith("应用目录不可读取");
    }

    private static boolean verifyRenderedTheme(FakeView body, int themeId) {
        if (body == null || body.parent == null) return false;
        FakeView scroll = (FakeView) body.parent;
        if (scroll.backgroundColor != expectedThemeColor(themeId, 1)) return false;
        List<FakeView> views = new ArrayList<FakeView>();
        collectViews(body, views);
        boolean sawText = false;
        for (FakeView view : views) {
            if ("android.widget.TextView".equals(view.className)) {
                sawText = true;
                int attribute = isSecondaryLogText(view.text == null ? "" : view.text) ? 4 : 3;
                if (!(view.textColor instanceof FakeColorStateList)
                    || ((FakeColorStateList) view.textColor).attributeId != attribute
                    || ((FakeColorStateList) view.textColor).color != expectedThemeColor(themeId, attribute)) return false;
            } else if ("com.google.android.material.button.MaterialButton".equals(view.className)) {
                if (!(view.textColor instanceof FakeColorStateList) || !(view.backgroundTint instanceof FakeColorStateList)
                    || ((FakeColorStateList) view.textColor).attributeId != 3
                    || ((FakeColorStateList) view.backgroundTint).attributeId != 2
                    || ((FakeColorStateList) view.textColor).color != expectedThemeColor(themeId, 3)
                    || ((FakeColorStateList) view.backgroundTint).color != expectedThemeColor(themeId, 2)) return false;
            } else if ("com.google.android.material.card.MaterialCardView".equals(view.className)) {
                if (!(view.cardBackgroundColor instanceof FakeColorStateList)
                    || ((FakeColorStateList) view.cardBackgroundColor).attributeId != 2
                    || ((FakeColorStateList) view.cardBackgroundColor).color != expectedThemeColor(themeId, 2)) return false;
            } else if ("android.view.View".equals(view.className)
                && view.backgroundColor != expectedThemeColor(themeId, 5)) return false;
        }
        return sawText;
    }

    private static boolean verifyRenderedControlContracts(FakeView body) {
        List<FakeView> views = new ArrayList<FakeView>();
        collectViews(body, views);
        boolean sawText = false, sawButton = false;
        for (FakeView view : views) {
            if (!(view.layoutParams instanceof FakeLayoutParams)) continue;
            FakeLayoutParams params = (FakeLayoutParams) view.layoutParams;
            if ("android.widget.TextView".equals(view.className)) {
                sawText = true;
                if (view.textSizeUnit != 2 || params.height != -2 || view.minimumHeight < 56
                    || view.singleLineCalls != 0 || view.maxLinesCalls != 0) return false;
            }
            if ("com.google.android.material.button.MaterialButton".equals(view.className)) {
                sawButton = true;
                if (view.textSizeUnit != 2 || params.width != -2 || params.height != -2 || view.minimumHeight < 48
                    || view.singleLineCalls != 0 || view.maxLinesCalls != 0) return false;
            }
        }
        return sawText && sawButton;
    }

    private static String viewSnapshot(FakeView root) {
        StringBuilder result = new StringBuilder();
        appendSnapshot(root, result);
        return result.toString();
    }

    private static void appendSnapshot(FakeView view, StringBuilder result) {
        if (view == null) return;
        result.append(view.className).append('|').append(view.text).append('|').append(view.backgroundColor).append(';');
        for (FakeView child : new ArrayList<FakeView>(view.children)) appendSnapshot(child, result);
    }

    private static Object activeSession(LogPage.Controller controller) throws Exception {
        java.lang.reflect.Field field = LogPage.Controller.class.getDeclaredField("session");
        field.setAccessible(true);
        Object value = field.get(controller);
        check(value != null, "the production Controller owns the active export session");
        return value;
    }

    private static String activeSessionState(Object session) throws Exception {
        java.lang.reflect.Field field = session.getClass().getDeclaredField("state");
        field.setAccessible(true);
        Object value = field.get(session);
        return value == null ? "" : value.toString();
    }

    private static File activeSnapshot(Object session) throws Exception {
        java.lang.reflect.Field field = session.getClass().getDeclaredField("snapshot");
        field.setAccessible(true);
        return (File) field.get(session);
    }

    private static Object activeSessionLock(Object session) throws Exception {
        java.lang.reflect.Field field = session.getClass().getDeclaredField("lock");
        field.setAccessible(true);
        return field.get(session);
    }

    private static boolean hasRegisteredController(Object activity) throws Exception {
        java.lang.reflect.Field lockField = LogPage.class.getDeclaredField("LOCK");
        java.lang.reflect.Field controllersField = LogPage.class.getDeclaredField("CONTROLLERS");
        lockField.setAccessible(true);
        controllersField.setAccessible(true);
        @SuppressWarnings("unchecked") Map<Object, LogPage.Controller> controllers =
            (Map<Object, LogPage.Controller>) controllersField.get(null);
        synchronized (lockField.get(null)) { return controllers.containsKey(activity); }
    }

    private interface Condition { boolean ready(); }

    private static void awaitCondition(String label, Condition condition) throws Exception {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
        while (!condition.ready() && System.nanoTime() < deadline) Thread.sleep(10L);
        check(condition.ready(), label);
    }

    private static String last(List<String> values) { return values.isEmpty() ? "" : values.get(values.size() - 1); }
    private static LogPage.PageState lastState(List<LogPage.PageState> values) { return values.isEmpty() ? null : values.get(values.size() - 1); }
    private static int countText(List<String> values, String expected) {
        int count = 0;
        for (String value : values) if (expected.equals(value)) count++;
        return count;
    }
    private static int countStateMessage(List<LogPage.PageState> values, String expected) {
        int count = 0;
        for (LogPage.PageState value : values) if (expected.equals(value.message)) count++;
        return count;
    }

    private static File cacheTemp(String prefix) throws IOException {
        File cache = new File("tools/_cache").getCanonicalFile();
        if (!cache.isDirectory() && !cache.mkdirs() && !cache.isDirectory()) throw new IOException("project test cache unavailable");
        return Files.createTempDirectory(cache.toPath(), prefix).toFile().getCanonicalFile();
    }

    private static void writeUtf8(File file, String text) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) throw new IOException("fixture parent unavailable");
        Files.write(file.toPath(), text.getBytes("UTF-8"));
    }

    private static int countNamed(File directory, String pattern) {
        File[] files = directory.listFiles();
        if (files == null) return 0;
        int count = 0;
        for (File file : files) if (file.getName().matches(pattern)) count++;
        return count;
    }

    private static void deleteTree(File file) throws IOException {
        if (file == null || !file.exists()) return;
        File cache = new File("tools/_cache").getCanonicalFile();
        String root = cache.getCanonicalPath();
        String target = file.getCanonicalPath();
        if (!target.startsWith(root + File.separator)) throw new AssertionError("refusing to delete outside tools/_cache: " + target);
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        if (!file.delete() && file.exists()) throw new AssertionError("could not delete test cache path");
    }

    private static class FixtureSource implements LogStore.Source {
        final String key;
        final String label;
        final File root;
        final List<LogStore.Entry> entries = new ArrayList<LogStore.Entry>();
        int closedInputs;
        Throwable scanFailure;
        String unavailableMessage;
        FixtureSource(String key, String label, File root) { this.key = key; this.label = label; this.root = root; }
        @Override public String key() { return key; }
        @Override public String label() { return label; }
        @Override public LogStore.Scan scan() throws Exception {
            if (scanFailure != null) throw new IOException("wrapped /private/alice?token=source-secret", scanFailure);
            if (unavailableMessage != null) return LogStore.Scan.unavailable(unavailableMessage);
            return LogStore.Scan.readable(new ArrayList<LogStore.Entry>(entries));
        }
        @Override public InputStream open(LogStore.Entry entry) throws Exception {
            final InputStream file = new java.io.FileInputStream((File) entry.handle);
            return new FilterInputStream(file) {
                @Override public void close() throws IOException { try { super.close(); } finally { closedInputs++; } }
            };
        }
        LogStore.Entry add(String name, long modified, String content) throws IOException { return addAt(root, name, modified, content); }
        LogStore.Entry addOutside(String name, long modified, String content, File outside) throws IOException { return addAt(outside, name, modified, content); }
        private LogStore.Entry addAt(File parent, String name, long modified, String content) throws IOException {
            if (!parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) throw new IOException("fixture directory unavailable");
            File file = new File(parent, name); Files.write(file.toPath(), content.getBytes("UTF-8")); file.setLastModified(modified);
            File boundary = "legacy-download".equals(key) ? root : root;
            String owner = "legacy-download".equals(key) ? LogStore.PACKAGE_NAME : LogStore.PACKAGE_NAME;
            String relative = "legacy-download".equals(key) ? "Download/wakeup-noads" : CrashLog.LOG_DIRECTORY;
            LogStore.Entry entry = new LogStore.Entry(key + ":" + file.getCanonicalPath(), key,
                "legacy-download".equals(key) ? "历史 Download" : "应用目录", name, modified, this, file,
                boundary, owner, relative, null);
            entries.add(entry); return entry;
        }
    }

    private static final class FakeMediaPlatform implements LogStore.MediaPlatform {
        final Object collection = new Object();
        FakeMediaCursor cursor;
        String[] projection;
        String selection;
        String[] arguments;
        String sortOrder;
        Object lastCollection;
        IOException queryFailure;
        boolean returnNullCursor;
        int collectionCalls, queryCalls, openCalls;
        Object openedUri;
        @Override public Object downloadsCollection() { collectionCalls++; return collection; }
        @Override public LogStore.MediaCursor query(Object context, Object collection, String[] projection, String selection,
                                                     String[] arguments, String sortOrder) throws Exception {
            queryCalls++; this.lastCollection = collection; this.projection = projection.clone(); this.selection = selection;
            this.arguments = arguments.clone(); this.sortOrder = sortOrder;
            if (queryFailure != null) throw queryFailure;
            return returnNullCursor ? null : cursor;
        }
        @Override public Object withAppendedId(Object collection, long id) {
            if (collection != this.collection) throw new AssertionError("scan changed collection identity");
            return "content://downloads/" + id;
        }
        @Override public InputStream open(Object context, Object uri) {
            openCalls++; openedUri = uri;
            return new ByteArrayInputStream("wakeup-noads crash log\n".getBytes(Charset.forName("UTF-8")));
        }
    }

    private static final class FakeMediaCursor implements LogStore.MediaCursor {
        final String[] columns;
        final Object[][] rows;
        int row = -1;
        int closeCalls;
        boolean failMove, failClose;
        String missingColumn;
        FakeMediaCursor(String[] columns, Object[][] rows) { this.columns = columns; this.rows = rows; }
        static FakeMediaCursor empty() {
            return new FakeMediaCursor(new String[] { "_id", "_display_name", "relative_path", "owner_package_name", "date_modified" }, new Object[0][]);
        }
        @Override public int getColumnIndex(String name) {
            if (name.equals(missingColumn)) return -1;
            for (int index = 0; index < columns.length; index++) if (name.equals(columns[index])) return index;
            return -1;
        }
        @Override public boolean moveToNext() throws Exception {
            if (failMove) throw new IOException("cursor-iteration-secret");
            row++; return row < rows.length;
        }
        @Override public String getString(int index) { return (String) rows[row][index]; }
        @Override public long getLong(int index) { return ((Number) rows[row][index]).longValue(); }
        @Override public void close() throws Exception { closeCalls++; if (failClose) throw new IOException("cursor-close-secret"); }
    }

    public static class FakeActivityBase {
        final File externalFiles;
        final File cache;
        final int themeId;
        public FakeExplicitIntent intent;
        CharSequence title;
        int finishCalls;
        int factoryCalls, supportActionBarCalls;
        final FakeView coordinator = new FakeView("androidx.coordinatorlayout.widget.CoordinatorLayout");
        final FakeView appBar = new FakeView("com.google.android.material.appbar.AppBarLayout");
        final FakeView toolbar = new FakeView("com.google.android.material.appbar.MaterialToolbar");
        final FakeView recycler = new FakeView("androidx.recyclerview.widget.RecyclerView");
        FakeActivityBase(File externalFiles, File cache, int themeId, boolean logMode) {
            this.externalFiles = externalFiles; this.cache = cache; this.themeId = themeId;
            intent = new FakeExplicitIntent(null, FakeSettingsActivity.class);
            if (logMode) intent.extras.put("wakeup_noads_log_page", Boolean.TRUE);
            appBar.addView(toolbar, new FakeLayoutParams("android.view.ViewGroup$LayoutParams", -1, -2, 0));
            coordinator.addView(appBar, new FakeLayoutParams("androidx.coordinatorlayout.widget.CoordinatorLayout$LayoutParams", -1, -2, 0));
            FakeLayoutParams original = new FakeLayoutParams("androidx.coordinatorlayout.widget.CoordinatorLayout$LayoutParams", -1, -1, 0);
            original.behavior = new Object();
            recycler.setLayoutParams(original);
            coordinator.addView(recycler, original);
        }
        public FakeExplicitIntent getIntent() { return intent; }
        public File getExternalFilesDir(String type) { return externalFiles; }
        public File getCacheDir() { return cache; }
        public String getPackageName() { return "io.github.wakeupnoads"; }
        public FakeView o00O0O() { return coordinator; }
        public FakeView o0OoOo0() { return recycler; }
        public FakeView Oooooo0() {
            factoryCalls++;
            FakeView made = new FakeView("com.google.android.material.appbar.AppBarLayout");
            made.addView(new FakeView("com.google.android.material.appbar.MaterialToolbar"),
                new FakeLayoutParams("android.view.ViewGroup$LayoutParams", -1, -2, 0));
            coordinator.addView(made, new FakeLayoutParams("androidx.coordinatorlayout.widget.CoordinatorLayout$LayoutParams", -1, -2, 0));
            return made;
        }
        public void setSupportActionBar(Object value) { supportActionBarCalls++; }
        public void setTitle(CharSequence value) { title = value; }
        public void finish() { finishCalls++; }
    }

    public static final class FakeSettingsActivity extends FakeActivityBase {
        public FakeSettingsActivity(File externalFiles, File cache, int themeId, boolean logMode) {
            super(externalFiles, cache, themeId, logMode);
        }
    }

    public static final class FakeOtherActivity extends FakeActivityBase {
        public FakeOtherActivity(File externalFiles, File cache, int themeId, boolean logMode) {
            super(externalFiles, cache, themeId, logMode);
        }
    }

    public static final class FakePageFragment {
        private final Object activity;
        public FakePageFragment(Object activity) { this.activity = activity; }
        public Object getActivity() { return activity; }
    }

    public static final class FakeExplicitIntent {
        final Object context;
        final Class<?> targetClass;
        final Map<String, Object> extras = new LinkedHashMap<String, Object>();
        int flags;
        FakeExplicitIntent(Object context, Class<?> targetClass) { this.context = context; this.targetClass = targetClass; }
    }

    public static final class FakeResultIntent {
        private final Object data;
        public FakeResultIntent(Object data) { this.data = data; }
        public Object getData() { return data; }
    }

    private static final class FakePageLaunchCalls implements LogPage.PageLaunchCalls {
        FakeExplicitIntent lastIntent;
        Object startedFragment;
        boolean failStart;
        String failureText = "launch failed";
        @Override public Class<?> settingsActivityClass() { return FakeSettingsActivity.class; }
        @Override public Object newExplicitIntent(Object context, Class<?> targetClass) {
            lastIntent = new FakeExplicitIntent(context, targetClass); return lastIntent;
        }
        @Override public void putBooleanExtra(Object intent, String key, boolean value) {
            ((FakeExplicitIntent) intent).extras.put(key, Boolean.valueOf(value));
        }
        @Override public void addFlags(Object intent, int flags) { ((FakeExplicitIntent) intent).flags |= flags; }
        @Override public void startActivity(Object fragment, Object intent) throws Exception {
            startedFragment = fragment;
            if (failStart) throw new IOException(failureText);
        }
        @Override public boolean isSettingsActivity(Object activity) { return activity instanceof FakeSettingsActivity; }
        @Override public Object activityIntent(Object activity) {
            return activity instanceof FakeActivityBase ? ((FakeActivityBase) activity).getIntent() : null;
        }
        @Override public boolean booleanExtraIsTrue(Object intent, String key) {
            if (!(intent instanceof FakeExplicitIntent)) return false;
            Object value = ((FakeExplicitIntent) intent).extras.get(key);
            return value instanceof Boolean && ((Boolean) value).booleanValue();
        }
    }

    private static final class FakeColorStateList {
        final int themeId, attributeId, color;
        FakeColorStateList(int themeId, int attributeId, int color) {
            this.themeId = themeId; this.attributeId = attributeId; this.color = color;
        }
        public int getDefaultColor() { return color; }
    }

    private static final class FakeLayoutParams {
        final String className;
        final int width, height;
        final float weight;
        Object behavior;
        int[] margins = new int[4];
        FakeLayoutParams(String className, int width, int height, float weight) {
            this.className = className; this.width = width; this.height = height; this.weight = weight;
        }
        public Object getBehavior() { return behavior; }
        public void setBehavior(Object value) { behavior = value; }
        public void setMargins(int left, int top, int right, int bottom) { margins = new int[] { left, top, right, bottom }; }
    }

    private static final class FakeClickListener {
        final Runnable callback;
        FakeClickListener(Runnable callback) { this.callback = callback; }
        void run() { if (callback != null) callback.run(); }
    }

    private static final class FakeView {
        final String className;
        final List<FakeView> children = new ArrayList<FakeView>();
        Object parent, layoutParams, textColor, cardBackgroundColor, backgroundTint, clickListener, navigationClickListener, typeface;
        String text;
        int backgroundColor, textSizeUnit = -1, minimumHeight, orientation, singleLineCalls, maxLinesCalls;
        float textSize;
        int[] padding = new int[] { 1, 3, 2, 5 };
        boolean fillViewport, clipToPadding, selectable, allCaps;
        int addViewCalls, removeViewCalls, removeAllViewsCalls;
        FakeView(String className) { this.className = className; }
        public Object getParent() { return parent; }
        public Object getLayoutParams() { return layoutParams; }
        public void setLayoutParams(Object value) { layoutParams = value; }
        public int getChildCount() { return children.size(); }
        public Object getChildAt(int index) { return index < 0 || index >= children.size() ? null : children.get(index); }
        public void addView(Object child, Object params) {
            FakeView view = (FakeView) child;
            if (view.parent != null) throw new AssertionError("a view cannot have two parents");
            view.parent = this; view.layoutParams = params; children.add(view); addViewCalls++;
        }
        public void removeView(Object child) {
            FakeView view = (FakeView) child;
            if (children.remove(view)) { view.parent = null; removeViewCalls++; }
        }
        public void removeAllViews() {
            removeAllViewsCalls++;
            for (FakeView child : children) child.parent = null;
            children.clear();
        }
        public void setText(CharSequence value) { text = value == null ? null : value.toString(); }
        public void setTextSize(int unit, float size) { textSizeUnit = unit; textSize = size; }
        public void setTextColor(Object value) { textColor = value; }
        public void setMinimumHeight(int value) { minimumHeight = value; }
        public void setBackgroundColor(int value) { backgroundColor = value; }
        public void setCardBackgroundColor(Object value) { cardBackgroundColor = value; }
        public void setBackgroundTintList(Object value) { backgroundTint = value; }
        public void setPadding(int left, int top, int right, int bottom) { padding = new int[] { left, top, right, bottom }; }
        public int getPaddingLeft() { return padding[0]; }
        public int getPaddingTop() { return padding[1]; }
        public int getPaddingRight() { return padding[2]; }
        public int getPaddingBottom() { return padding[3]; }
        public void setOrientation(int value) { orientation = value; }
        public void setFillViewport(boolean value) { fillViewport = value; }
        public void setClipToPadding(boolean value) { clipToPadding = value; }
        public void setTextIsSelectable(boolean value) { selectable = value; }
        public void setTypeface(Object value) { typeface = value; }
        public void setAllCaps(boolean value) { allCaps = value; }
        public void setOnClickListener(Object value) { clickListener = value; }
        public void setNavigationOnClickListener(Object value) { navigationClickListener = value; }
        public void setTitle(CharSequence value) { text = value == null ? null : value.toString(); }
        public boolean isAttachedToWindow() { return parent != null; }
        public void requestApplyInsets() { }
        public void setSingleLine(boolean value) { singleLineCalls++; }
        public void setMaxLines(int value) { maxLinesCalls++; }
    }

    private static final class FakeResources {
        final FakeAndroidUiCalls calls;
        FakeResources(FakeAndroidUiCalls calls) { this.calls = calls; }
        public int getIdentifier(String name, String type, String resourcePackage) {
            calls.attributes.add(resourcePackage + ":" + name);
            if (!"attr".equals(type)) return 0;
            if ("colorBackground".equals(name)) return 1;
            if ("colorSurface".equals(name)) return 2;
            if ("colorOnSurface".equals(name)) return 3;
            if ("colorOnSurfaceVariant".equals(name)) return 4;
            if ("colorOutlineVariant".equals(name)) return 5;
            return 0;
        }
        public FakeMetrics getDisplayMetrics() { return new FakeMetrics(); }
    }

    private static final class FakeMetrics { public float density = 1.0f; }

    private static final class FakeTheme {
        final FakeAndroidUiCalls calls;
        final int themeId;
        FakeTheme(FakeAndroidUiCalls calls, int themeId) { this.calls = calls; this.themeId = themeId; }
        public FakeTypedArray obtainStyledAttributes(int[] ids) { return new FakeTypedArray(calls, themeId, ids[0]); }
    }

    private static final class FakeTypedArray {
        final FakeAndroidUiCalls calls;
        final int themeId, attributeId;
        boolean recycled;
        FakeTypedArray(FakeAndroidUiCalls calls, int themeId, int attributeId) {
            this.calls = calls; this.themeId = themeId; this.attributeId = attributeId;
        }
        public Object getColorStateList(int index) {
            check(index == 0, "production reads the requested theme item");
            FakeColorStateList value = new FakeColorStateList(themeId, attributeId, expectedThemeColor(themeId, attributeId));
            calls.resolved.add(value);
            return value;
        }
        public void recycle() { recycled = true; calls.recycledArrays++; }
    }

    private static int expectedThemeColor(int themeId, int attributeId) {
        if (themeId == 1) {
            switch (attributeId) {
                case 1: return 0xff110101;
                case 2: return 0xff110202;
                case 3: return 0xff110303;
                case 4: return 0xff110404;
                case 5: return 0xff110505;
                default: throw new AssertionError("unknown theme attribute id " + attributeId);
            }
        }
        if (themeId == 2) {
            switch (attributeId) {
                case 1: return 0xff220101;
                case 2: return 0xff220202;
                case 3: return 0xff220303;
                case 4: return 0xff220404;
                case 5: return 0xff220505;
                default: throw new AssertionError("unknown theme attribute id " + attributeId);
            }
        }
        return 0xff330000 | (attributeId << 8);
    }

    private static final class FakeAndroidUiCalls implements LogPage.AndroidUiCalls {
        final List<String> attributes = Collections.synchronizedList(new ArrayList<String>());
        final List<Object> resolved = Collections.synchronizedList(new ArrayList<Object>());
        final List<String> toasts = Collections.synchronizedList(new ArrayList<String>());
        final Object backToken = new Object();
        final Object renderMonitor = new Object();
        final int themeId, sdk;
        int openCount, backRegistrations, backUnregistrations, requestInsetsCount, detachCount, finishCount, paddingWrites;
        int recycledArrays, renderCount, dialogConstructCount;
        boolean attached = true, failOpen;
        FakeView lastScroll, lastBody;
        Runnable platformBack;

        FakeAndroidUiCalls(int themeId, int sdk) { this.themeId = themeId; this.sdk = sdk; }
        @Override public Object invoke(Object receiver, String method, String[] types, Object[] args) throws Exception {
            if (receiver instanceof FakeActivityBase) {
                FakeActivityBase activity = (FakeActivityBase) receiver;
                if ("getPackageName".equals(method)) return activity.getPackageName();
                if ("getResources".equals(method)) return new FakeResources(this);
                if ("getTheme".equals(method)) return new FakeTheme(this, activity.themeId);
                if ("o00O0O".equals(method)) {
                    openCount++;
                    if (failOpen) throw new IOException("open /private/view-path-secret");
                    return activity.o00O0O();
                }
                if ("o0OoOo0".equals(method)) return activity.o0OoOo0();
                if ("Oooooo0".equals(method)) return activity.Oooooo0();
                if ("setSupportActionBar".equals(method)) { activity.setSupportActionBar(args[0]); return null; }
                if ("finish".equals(method)) { activity.finish(); return null; }
                throw new AssertionError("unexpected production Activity call " + method);
            }
            if (receiver instanceof FakeResources) {
                FakeResources resources = (FakeResources) receiver;
                if ("getIdentifier".equals(method)) return resources.getIdentifier((String) args[0], (String) args[1], (String) args[2]);
                if ("getDisplayMetrics".equals(method)) return resources.getDisplayMetrics();
            }
            if (receiver instanceof FakeMetrics && "density".equals(method)) return ((FakeMetrics) receiver).density;
            if (receiver instanceof FakeTheme && "obtainStyledAttributes".equals(method)) {
                FakeTheme value = (FakeTheme) receiver; return value.obtainStyledAttributes((int[]) args[0]);
            }
            if (receiver instanceof FakeTypedArray) {
                FakeTypedArray value = (FakeTypedArray) receiver;
                if ("getColorStateList".equals(method)) return value.getColorStateList(((Integer) args[0]).intValue());
                if ("recycle".equals(method)) { value.recycle(); return null; }
            }
            if (receiver instanceof FakeColorStateList && "getDefaultColor".equals(method)) return ((FakeColorStateList) receiver).getDefaultColor();
            if (receiver instanceof FakeLayoutParams) {
                FakeLayoutParams params = (FakeLayoutParams) receiver;
                if ("getBehavior".equals(method)) return params.getBehavior();
                if ("setBehavior".equals(method)) { params.setBehavior(args[0]); return null; }
                if ("setMargins".equals(method)) { params.setMargins(intAt(args, 0), intAt(args, 1), intAt(args, 2), intAt(args, 3)); return null; }
            }
            if (receiver instanceof FakeView) return invokeView((FakeView) receiver, method, args);
            throw new AssertionError("unexpected platform receiver for " + method + ": " + receiver);
        }
        private Object invokeView(FakeView view, String method, Object[] args) {
            if ("getParent".equals(method)) return view.getParent();
            if ("getLayoutParams".equals(method)) return view.getLayoutParams();
            if ("getChildCount".equals(method)) return view.getChildCount();
            if ("getChildAt".equals(method)) return view.getChildAt(intAt(args, 0));
            if ("addView".equals(method)) {
                FakeView child = (FakeView) args[0]; view.addView(child, args[1]);
                if ("androidx.core.widget.NestedScrollView".equals(child.className)) {
                    lastScroll = child;
                    if (!child.children.isEmpty()) lastBody = child.children.get(0);
                }
                if (view == lastScroll && child.className.equals("android.widget.LinearLayout")) lastBody = child;
                signalRenderChange();
                return null;
            }
            if ("removeView".equals(method)) {
                FakeView child = (FakeView) args[0];
                boolean wasPageRoot = child == lastScroll;
                view.removeView(child);
                if (wasPageRoot) detachCount++;
                return null;
            }
            if ("removeAllViews".equals(method)) {
                view.removeAllViews();
                if (view == lastBody) { synchronized (renderMonitor) { renderCount++; renderMonitor.notifyAll(); } }
                return null;
            }
            if ("getPaddingLeft".equals(method)) return view.padding[0];
            if ("getPaddingTop".equals(method)) return view.padding[1];
            if ("getPaddingRight".equals(method)) return view.padding[2];
            if ("getPaddingBottom".equals(method)) return view.padding[3];
            if ("setPadding".equals(method)) { view.setPadding(intAt(args, 0), intAt(args, 1), intAt(args, 2), intAt(args, 3)); paddingWrites++; return null; }
            if ("setLayoutParams".equals(method)) { view.setLayoutParams(args[0]); return null; }
            if ("setText".equals(method)) { view.setText((CharSequence) args[0]); signalRenderChange(); return null; }
            if ("setTitle".equals(method)) { view.setTitle((CharSequence) args[0]); signalRenderChange(); return null; }
            if ("setTextSize".equals(method)) { view.setTextSize(intAt(args, 0), ((Number) args[1]).floatValue()); return null; }
            if ("setTextColor".equals(method)) { view.setTextColor(args[0]); return null; }
            if ("setMinimumHeight".equals(method)) { view.setMinimumHeight(intAt(args, 0)); return null; }
            if ("setBackgroundColor".equals(method)) { view.setBackgroundColor(intAt(args, 0)); return null; }
            if ("setCardBackgroundColor".equals(method)) { view.cardBackgroundColor = args[0]; return null; }
            if ("setBackgroundTintList".equals(method)) { view.backgroundTint = args[0]; return null; }
            if ("setOrientation".equals(method)) { view.orientation = intAt(args, 0); return null; }
            if ("setFillViewport".equals(method)) { view.fillViewport = ((Boolean) args[0]).booleanValue(); return null; }
            if ("setClipToPadding".equals(method)) { view.clipToPadding = ((Boolean) args[0]).booleanValue(); return null; }
            if ("setTextIsSelectable".equals(method)) { view.selectable = ((Boolean) args[0]).booleanValue(); return null; }
            if ("setTypeface".equals(method)) { view.typeface = args[0]; return null; }
            if ("setAllCaps".equals(method)) { view.allCaps = ((Boolean) args[0]).booleanValue(); return null; }
            if ("setOnClickListener".equals(method)) { view.clickListener = args[0]; return null; }
            if ("setNavigationOnClickListener".equals(method)) { view.navigationClickListener = args[0]; return null; }
            if ("setSingleLine".equals(method)) { view.singleLineCalls++; return null; }
            if ("setMaxLines".equals(method)) { view.maxLinesCalls++; return null; }
            if ("isAttachedToWindow".equals(method)) return Boolean.valueOf(attached);
            if ("requestApplyInsets".equals(method)) { requestInsetsCount++; return null; }
            throw new AssertionError("unexpected production View call " + view.className + "." + method);
        }
        @Override public Object construct(String className, String[] parameterTypes, Object[] args) {
            if (className.contains("Dialog")) dialogConstructCount++;
            if (className.equals("android.view.ViewGroup$LayoutParams"))
                return new FakeLayoutParams(className, intAt(args, 0), intAt(args, 1), 0);
            if (className.equals("android.widget.LinearLayout$LayoutParams"))
                return new FakeLayoutParams(className, intAt(args, 0), intAt(args, 1), ((Number) args[2]).floatValue());
            return new FakeView(className);
        }
        @Override public boolean isInstance(Object value, String className) {
            if (value instanceof FakeLayoutParams) return className.equals(((FakeLayoutParams) value).className)
                || "android.view.ViewGroup$LayoutParams".equals(className);
            return value instanceof FakeView && (className.equals(((FakeView) value).className)
                || "android.view.View".equals(className) || "android.view.ViewGroup".equals(className));
        }
        @Override public Object staticField(String className, String name) { return className + "." + name; }
        @Override public Object clickListener(Runnable callback) { return callback == null ? null : new FakeClickListener(callback); }
        @Override public float density(Object context) { return 1.0f; }
        @Override public int sdkInt() { return sdk; }
        @Override public Object registerBack(Object activity, Runnable callback) { backRegistrations++; platformBack = callback; return backToken; }
        @Override public void unregisterBack(Object activity, Object registration) { if (registration == backToken) backUnregistrations++; }
        @Override public LogPage.PageInsets readInsets(Object insets) { return (LogPage.PageInsets) insets; }
        @Override public int[] padding(Object view) { return ((FakeView) view).padding.clone(); }
        @Override public void setPadding(Object view, int left, int top, int right, int bottom) {
            ((FakeView) view).setPadding(left, top, right, bottom); paddingWrites++;
        }
        @Override public boolean isAttached(Object view) { return attached; }
        @Override public void requestApplyInsets(Object view) { requestInsetsCount++; }
        @Override public void finish(Object activity) { finishCount++; ((FakeActivityBase) activity).finish(); }
        @Override public void toast(Object activity, String message) { toasts.add(message); }
        void awaitRenderCount(final int minimum) throws Exception {
            long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
            synchronized (renderMonitor) {
                while (renderCount < minimum && System.nanoTime() < deadline) {
                    long remaining = deadline - System.nanoTime();
                    if (remaining <= 0) break;
                    long millis = Math.max(1L, Math.min(100L, java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(remaining)));
                    renderMonitor.wait(millis);
                }
            }
            check(renderCount >= minimum, "production renderer cleared and rebuilt the body at least " + minimum + " times");
        }
        void awaitBodyText(final String expected) throws Exception {
            long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
            synchronized (renderMonitor) {
                while (!bodyContainsText(expected) && System.nanoTime() < deadline) {
                    long remaining = deadline - System.nanoTime();
                    if (remaining <= 0) break;
                    long millis = Math.max(1L, Math.min(100L, java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(remaining)));
                    renderMonitor.wait(millis);
                }
            }
            check(bodyContainsText(expected), "production rendered body contains expected text: " + expected);
        }
        private void signalRenderChange() { synchronized (renderMonitor) { renderMonitor.notifyAll(); } }
        boolean bodyContainsText(String expected) { return containsText(lastBody, expected); }
        private static boolean containsText(FakeView root, String expected) {
            if (root == null) return false;
            if (root.text != null && root.text.contains(expected)) return true;
            for (FakeView child : new ArrayList<FakeView>(root.children)) if (containsText(child, expected)) return true;
            return false;
        }
        private static int intAt(Object[] values, int index) { return ((Number) values[index]).intValue(); }
    }

    private static final class FakeIntent {
        final String action;
        String category, mime;
        final Map<String, Object> extras = new LinkedHashMap<String, Object>();
        FakeIntent(String action) { this.action = action; }
    }

    private static final class FakeAndroidCalls implements LogPage.AndroidCalls {
        FakeIntent intent;
        Object activity, startedIntent, openedUri;
        final java.util.concurrent.CountDownLatch startedLatch = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch deletedLatch = new java.util.concurrent.CountDownLatch(1);
        int requestCode, deleteResult;
        boolean deleteThrows, openThrows, openReturnsNull;
        volatile int openCalls, deleteCalls;
        final RecordingOutput output = new RecordingOutput();
        volatile OutputStream targetOutput = output;
        @Override public Object newIntent(String action) { intent = new FakeIntent(action); return intent; }
        @Override public void addCategory(Object intent, String category) { ((FakeIntent) intent).category = category; }
        @Override public void setType(Object intent, String mimeType) { ((FakeIntent) intent).mime = mimeType; }
        @Override public void putStringExtra(Object intent, String key, String value) { ((FakeIntent) intent).extras.put(key, value); }
        @Override public void putBooleanExtra(Object intent, String key, boolean value) { ((FakeIntent) intent).extras.put(key, Boolean.valueOf(value)); }
        @Override public void startActivityForResult(Object activity, Object intent, int requestCode) {
            this.activity = activity; this.startedIntent = intent; this.requestCode = requestCode;
            startedLatch.countDown();
        }
        @Override public OutputStream openTarget(Object context, Object uri) throws Exception {
            openCalls++; openedUri = uri;
            if (openThrows) throw new IOException("resolver open secret");
            return openReturnsNull ? null : targetOutput;
        }
        @Override public int deleteTarget(Object context, Object uri) throws Exception {
            deleteCalls++;
            openedUri = uri;
            deletedLatch.countDown();
            if (deleteThrows) throw new IOException("resolver delete secret");
            return deleteResult;
        }
    }

    static final class AndroidFakeUri {
        private final String scheme;
        private final String text;
        AndroidFakeUri(String scheme, String text) { this.scheme = scheme; this.text = text; }
        public String getScheme() { return scheme; }
        @Override public String toString() { return text; }
    }

    private static final class FragmentedInputStream extends ByteArrayInputStream {
        private final int chunk;
        FragmentedInputStream(byte[] bytes, int chunk) { super(bytes); this.chunk = chunk; }
        @Override public synchronized int read(byte[] bytes, int offset, int length) {
            return super.read(bytes, offset, Math.min(length, chunk));
        }
    }

    private static final class FaultInput extends InputStream {
        private final ByteArrayInputStream input;
        final boolean failRead;
        final boolean failClose;
        final AtomicInteger closeCounter;
        final IOException closeFailure = new IOException("close-secret-failure");
        FaultInput(byte[] bytes, boolean failRead, boolean failClose, AtomicInteger closeCounter) {
            this.input = new ByteArrayInputStream(bytes); this.failRead = failRead; this.failClose = failClose; this.closeCounter = closeCounter;
        }
        @Override public synchronized int read() throws IOException {
            if (failRead) throw new IOException("read-secret-failure");
            return input.read();
        }
        @Override public synchronized int read(byte[] bytes, int offset, int length) throws IOException {
            if (failRead) throw new IOException("read-secret-failure");
            return input.read(bytes, offset, length);
        }
        @Override public void close() throws IOException {
            closeCounter.incrementAndGet(); input.close();
            if (failClose) throw closeFailure;
        }
    }

    private static final class BlockingInput extends InputStream {
        final java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch released = new java.util.concurrent.CountDownLatch(1);
        volatile int closeCalls;
        @Override public int read() throws IOException {
            entered.countDown();
            try {
                if (!released.await(5, java.util.concurrent.TimeUnit.SECONDS)) throw new IOException("blocking read timeout");
            } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IOException("blocking read interrupted"); }
            throw new IOException("blocking stream cancelled");
        }
        @Override public int read(byte[] bytes, int offset, int length) throws IOException {
            int value = read();
            if (value < 0) return -1;
            bytes[offset] = (byte) value;
            return 1;
        }
        @Override public void close() { closeCalls++; released.countDown(); }
    }

    private static final class BlockingOutput extends OutputStream {
        final java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch released = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch closed = new java.util.concurrent.CountDownLatch(1);
        volatile int closeCalls;
        volatile boolean isClosed;
        @Override public void write(int value) throws IOException { write(new byte[] { (byte) value }, 0, 1); }
        @Override public void write(byte[] bytes, int offset, int length) throws IOException {
            entered.countDown();
            try {
                if (!released.await(5, java.util.concurrent.TimeUnit.SECONDS)) throw new IOException("blocking target write timeout");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("blocking target write interrupted");
            }
            if (isClosed) throw new IOException("target stream closed");
        }
        @Override public void close() {
            closeCalls++;
            isClosed = true;
            released.countDown();
            closed.countDown();
        }
    }

    private static final class GateInput extends InputStream {
        final java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        final ByteArrayInputStream input;
        boolean waited;
        int closeCalls;
        GateInput(byte[] bytes) { input = new ByteArrayInputStream(bytes); }
        @Override public synchronized int read() throws IOException {
            awaitRelease();
            return input.read();
        }
        @Override public synchronized int read(byte[] bytes, int offset, int length) throws IOException {
            awaitRelease();
            return input.read(bytes, offset, length);
        }
        private void awaitRelease() throws IOException {
            if (waited) return;
            waited = true;
            entered.countDown();
            try {
                if (!release.await(5, java.util.concurrent.TimeUnit.SECONDS)) throw new IOException("gate read timeout");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("gate read interrupted", interrupted);
            }
        }
        @Override public void close() throws IOException { closeCalls++; input.close(); }
    }

    private static final class RecordingOutput extends ByteArrayOutputStream {
        final List<String> writes = new ArrayList<String>();
        boolean closed;
        boolean failClose;
        boolean failWrite;
        int closeCalls;
        IOException closeFailure;
        @Override public synchronized void write(byte[] bytes, int offset, int length) {
            String value = new String(bytes, offset, length, Charset.forName("UTF-8"));
            writes.add(value);
            if (failWrite) throw new RuntimeException("private target write failure");
            super.write(bytes, offset, length);
        }
        @Override public synchronized void write(int value) {
            writes.add(new String(new byte[] { (byte) value }, Charset.forName("UTF-8")));
            if (failWrite) throw new RuntimeException("private target write failure");
            super.write(value);
        }
        @Override public void close() throws IOException {
            closeCalls++; closed = true;
            if (failClose) { closeFailure = new IOException("private close failure"); throw closeFailure; }
            super.close();
        }
        boolean allWritesSafe(String... forbidden) {
            StringBuilder aggregate = new StringBuilder();
            for (String write : writes) {
                for (String value : forbidden) if (write.contains(value)) return false;
                aggregate.append(write);
            }
            for (String value : forbidden) if (aggregate.indexOf(value) >= 0) return false;
            return true;
        }
    }

    private static final class FakeUri {
        final String scheme;
        FakeUri(String scheme) { this.scheme = scheme; }
        public String getScheme() { return scheme; }
    }

    private static final class ManualHost implements LogPage.ControllerHost {
        final List<Runnable> io = Collections.synchronizedList(new ArrayList<Runnable>());
        final List<Runnable> main = Collections.synchronizedList(new ArrayList<Runnable>());
        final List<Runnable> cancellations = Collections.synchronizedList(new ArrayList<Runnable>());
        final List<String> toasts = Collections.synchronizedList(new ArrayList<String>());
        final List<LogPage.PageState> states = Collections.synchronizedList(new ArrayList<LogPage.PageState>());
        boolean opened, dismissed, failCopy, failLaunch, failTargetWrite, failTargetClose, failTargetOpen, nullTarget, deleteSucceeds = true, failSnapshotDelete;
        boolean queueMain;
        int requestCode, launchCount, deletedTargets, openedTargets, copyCalls;
        int snapshotDeleteCalls;
        String copied, title;
        RecordingOutput target;
        File cacheRoot;
        InputStream snapshotInputOverride;
        LogPage.AndroidHost targetAdapter;
        Runnable beforeSnapshotDelete;
        @Override public void executeIo(Runnable task) { io.add(task); }
        @Override public void executeCancellation(Runnable task) { cancellations.add(task); }
        @Override public void postMain(Runnable task) { if (queueMain) main.add(task); else task.run(); }
        @Override public void open() { opened = true; }
        @Override public void dismiss() { dismissed = true; }
        @Override public void render(LogPage.PageState state) { states.add(state); }
        @Override public void toast(String message) { toasts.add(message); }
        @Override public void copy(String text) throws Exception { copyCalls++; if (failCopy) throw new IOException("clipboard /users/alice failure"); copied = text; }
        @Override public void launchDocument(String title, int requestCode) throws Exception {
            if (failLaunch) throw new IOException("picker path /users/alice unavailable");
            this.title = title; this.requestCode = requestCode; launchCount++;
        }
        @Override public boolean isContentUri(Object uri) {
            return uri instanceof FakeUri && "content".equals(((FakeUri) uri).scheme)
                || uri instanceof AndroidFakeUri && "content".equals(((AndroidFakeUri) uri).getScheme());
        }
        @Override public OutputStream openTarget(Object uri) throws Exception {
            openedTargets++;
            if (targetAdapter != null) return targetAdapter.openTarget(uri);
            if (failTargetOpen) throw new IOException("target open secret");
            if (nullTarget) return null;
            target = new RecordingOutput(); target.failWrite = failTargetWrite; target.failClose = failTargetClose; return target;
        }
        @Override public void deleteTarget(Object uri) { deletedTargets++; }
        @Override public boolean deleteTargetChecked(Object uri) throws Exception {
            deletedTargets++;
            if (targetAdapter != null) return targetAdapter.deleteTargetChecked(uri);
            if (!deleteSucceeds) return false;
            return true;
        }
        @Override public boolean deleteSnapshot(File cache, File snapshot) {
            snapshotDeleteCalls++;
            if (beforeSnapshotDelete != null) {
                Runnable hook = beforeSnapshotDelete;
                beforeSnapshotDelete = null;
                hook.run();
            }
            if (failSnapshotDelete) return false;
            return LogPage.deleteSnapshotForTest(cache, snapshot, new LogStore.CanonicalPaths() {
                @Override public String canonicalPath(File file) throws IOException { return file.getCanonicalPath(); }
            });
        }
        @Override public InputStream openSnapshot(File cache, File snapshot) throws Exception {
            LogStore.assertSnapshot(cache, snapshot);
            if (snapshotInputOverride != null) return snapshotInputOverride;
            return new java.io.FileInputStream(snapshot);
        }
        void runAllIo() { while (true) { Runnable task; synchronized (io) { if (io.isEmpty()) break; task = io.remove(0); } task.run(); } }
        void runNextIo() { Runnable task; synchronized (io) { task = io.remove(0); } task.run(); }
        void runAllMain() { while (true) { Runnable task; synchronized (main) { if (main.isEmpty()) break; task = main.remove(0); } task.run(); } }
        void runAllCancellation() { while (true) { Runnable task; synchronized (cancellations) { if (cancellations.isEmpty()) break; task = cancellations.remove(0); } task.run(); } }
        File[] cacheFiles(File cache) { cacheRoot = new File(cache, LogStore.EXPORT_FOLDER); File[] files = cacheRoot.listFiles(); return files == null ? new File[0] : files; }
    }

    private static CrashLog.ExitRecord record(long timestamp, int reason) {
        return new CrashLog.ExitRecord(timestamp, reason, "summary-" + timestamp, null);
    }

    private static CrashLog.Header header(final String key, final String value) {
        return new CrashLog.Header() {
            @Override public Map<String, String> collect() {
                Map<String, String> values = new LinkedHashMap<String, String>();
                values.put(key, value);
                return values;
            }
        };
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
