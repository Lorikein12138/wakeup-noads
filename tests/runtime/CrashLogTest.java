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
        System.out.println("CrashLogTest passed (10 legacy + 6 round-1 + 7 round-2 + 7 round-3 groups)");
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
                host.targetAdapter = new LogPage.AndroidHost(owner, new Object(), calls);
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
            ManualHost host = new ManualHost(); host.targetAdapter = new LogPage.AndroidHost(owner, new Object(), calls);
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
            ManualHost suppressedHost = new ManualHost(); suppressedHost.targetAdapter = new LogPage.AndroidHost(closeOwner, new Object(), closeCalls);
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

            final Object fragment = new Object(), activity = new Object(), uri = new Object();
            FakeAndroidCalls calls = new FakeAndroidCalls();
            LogPage.AndroidHost androidHost = new LogPage.AndroidHost(fragment, activity, calls);
            androidHost.launchDocument("wakeup-noads-crash.txt", LogPage.EXPORT_REQUEST_CODE);
            check("android.intent.action.CREATE_DOCUMENT".equals(calls.intent.action)
                && "android.intent.category.OPENABLE".equals(calls.intent.category)
                && "text/plain".equals(calls.intent.mime)
                && "wakeup-noads-crash.txt".equals(calls.intent.extras.get("android.intent.extra.TITLE"))
                && Boolean.TRUE.equals(calls.intent.extras.get("android.intent.extra.LOCAL_ONLY"))
                && calls.fragment == fragment && calls.startedIntent == calls.intent
                && calls.requestCode == 0x6c67,
                "production AndroidHost.launchDocument builds and starts the same Intent with exact action/category/MIME/typed extras/request/fragment");
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

    private static final class FakeIntent {
        final String action;
        String category, mime;
        final Map<String, Object> extras = new LinkedHashMap<String, Object>();
        FakeIntent(String action) { this.action = action; }
    }

    private static final class FakeAndroidCalls implements LogPage.AndroidCalls {
        FakeIntent intent;
        Object fragment, startedIntent, openedUri;
        int requestCode, deleteResult;
        boolean deleteThrows, openThrows, openReturnsNull;
        int openCalls, deleteCalls;
        final RecordingOutput output = new RecordingOutput();
        @Override public Object newIntent(String action) { intent = new FakeIntent(action); return intent; }
        @Override public void addCategory(Object intent, String category) { ((FakeIntent) intent).category = category; }
        @Override public void setType(Object intent, String mimeType) { ((FakeIntent) intent).mime = mimeType; }
        @Override public void putStringExtra(Object intent, String key, String value) { ((FakeIntent) intent).extras.put(key, value); }
        @Override public void putBooleanExtra(Object intent, String key, boolean value) { ((FakeIntent) intent).extras.put(key, Boolean.valueOf(value)); }
        @Override public void startActivityForResult(Object fragment, Object intent, int requestCode) {
            this.fragment = fragment; this.startedIntent = intent; this.requestCode = requestCode;
        }
        @Override public OutputStream openTarget(Object context, Object uri) throws Exception {
            openCalls++; openedUri = uri;
            if (openThrows) throw new IOException("resolver open secret");
            return openReturnsNull ? null : output;
        }
        @Override public int deleteTarget(Object context, Object uri) throws Exception {
            deleteCalls++;
            openedUri = uri;
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
