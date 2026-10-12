package com.suda.yzune.wakeupschedule.slim;

import java.io.File;
import java.nio.charset.Charset;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
        System.out.println("CrashLogTest passed");
    }

    private static void testCrashReportCarriesHeaderThreadAndCauses() {
        Map<String, String> header = new LinkedHashMap<String, String>();
        header.put("package", "io.github.wakeupnoads");
        header.put("android", "14 (API 34)");
        Throwable error = new IllegalStateException("outer", new UnsupportedOperationException("inner cause"));
        String report = CrashLog.crashReport(header, "main", error);
        check(report.startsWith("wakeup-noads crash log\n"), "report has a title line");
        check(report.contains("package: io.github.wakeupnoads\n"), "header values are written");
        check(report.indexOf("package:") < report.indexOf("android:"), "header order is preserved");
        check(report.contains("thread: main\n"), "crashing thread is named");
        check(report.contains("java.lang.IllegalStateException: outer"), "exception type and message are written");
        check(report.contains("Caused by: java.lang.UnsupportedOperationException: inner cause"), "causes are written");
        check(report.contains("CrashLogTest.testCrashReportCarriesHeaderThreadAndCauses"), "stack frames are written");
        check(CrashLog.stackTrace(null).equals("null\n"), "a null throwable is still reported");
    }

    private static void testHandlerWritesThenDelegates() {
        final List<String> events = new ArrayList<String>();
        final AtomicReference<String> written = new AtomicReference<String>();
        Thread.UncaughtExceptionHandler previous = new Thread.UncaughtExceptionHandler() {
            @Override public void uncaughtException(Thread thread, Throwable error) { events.add("previous:" + error.getMessage()); }
        };
        CrashLog.Handler handler = new CrashLog.Handler(previous, new CrashLog.Sink() {
            @Override public void write(String fileName, String content) {
                events.add("write:" + fileName.substring(0, 6));
                written.set(content);
            }
        }, header("model", "test-device"));
        handler.uncaughtException(Thread.currentThread(), new RuntimeException("boom"));
        check(events.equals(Arrays.asList("write:crash-", "previous:boom")), "the log is written before the original handler runs");
        check(written.get().contains("model: test-device"), "device header is included");
        check(written.get().contains("java.lang.RuntimeException: boom"), "stack trace is included");
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
        check(written.get() != null && written.get().contains("java.lang.RuntimeException: y"), "a failing header still writes the stack trace");

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
        check(report.contains(" CRASH_NATIVE ==\nsummary-1760000000000\n-- trace --\nAbort message: 'signature mismatch'\n"), "native record has summary and trace");
        check(report.contains(" CRASH ==\nsummary-1760000100000\n"), "java record has summary");
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
        File directory = Files.createTempDirectory("crash-log-test").toFile();
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

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        if (!file.delete() && file.exists()) throw new AssertionError("could not delete " + file);
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
