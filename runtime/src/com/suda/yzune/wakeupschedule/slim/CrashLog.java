package com.suda.yzune.wakeupschedule.slim;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Method;
import java.nio.charset.Charset;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Local-only crash log. Uncaught Java exceptions and the abnormal exits recorded by the system
 * (Android 11+, including native crashes and ANRs) are written as text files to
 * Download/wakeup-noads on Android 10+, or to the app's external files directory otherwise.
 * Nothing is uploaded. Android APIs are reached by reflection because the runtime is compiled
 * without android.jar.
 */
public final class CrashLog {
    static final String FOLDER = "wakeup-noads";
    static final int REASON_EXIT_SELF = 1;
    static final int REASON_SIGNALED = 2;
    static final int REASON_CRASH = 4;
    static final int REASON_CRASH_NATIVE = 5;
    static final int REASON_ANR = 6;
    static final int REASON_INITIALIZATION_FAILURE = 7;
    static final int REASON_EXCESSIVE_RESOURCE_USAGE = 9;
    private static final Charset UTF_8 = Charset.forName("UTF-8");
    private static final int MAX_EXIT_RECORDS = 16;
    private static final int MAX_TRACE_BYTES = 256 * 1024;
    private static final int MIN_PRINTABLE_RUN = 6;
    private static final String WATERMARK_FILE = "slim-crash-log-exit-watermark";
    private static final AtomicBoolean INSTALLED = new AtomicBoolean();

    private CrashLog() { }

    interface Sink {
        void write(String fileName, String content) throws Exception;
    }

    interface Header {
        Map<String, String> collect();
    }

    static final class ExitRecord {
        final long timestamp;
        final int reason;
        final String summary;
        final Object source;
        String trace;

        ExitRecord(long timestamp, int reason, String summary, Object source) {
            this.timestamp = timestamp;
            this.reason = reason;
            this.summary = summary;
            this.source = source;
        }
    }

    /** Called first in BaseApplication.attachBaseContext with the base context; never throws. */
    public static void install(Object context) {
        if (context == null || !INSTALLED.compareAndSet(false, true)) return;
        try {
            AndroidPlatform platform = new AndroidPlatform(context);
            installHandler(platform, platform);
            platform.reportNewExits();
        } catch (Throwable ignored) {
            // Logging must never change startup behavior.
        }
    }

    static Thread.UncaughtExceptionHandler installHandler(Sink sink, Header header) {
        Thread.UncaughtExceptionHandler handler = new Handler(Thread.getDefaultUncaughtExceptionHandler(), sink, header);
        Thread.setDefaultUncaughtExceptionHandler(handler);
        return handler;
    }

    /** Writes the report, then always hands the exception to the previous handler. */
    static final class Handler implements Thread.UncaughtExceptionHandler {
        private final Thread.UncaughtExceptionHandler previous;
        private final Sink sink;
        private final Header header;

        Handler(Thread.UncaughtExceptionHandler previous, Sink sink, Header header) {
            this.previous = previous;
            this.sink = sink;
            this.header = header;
        }

        @Override public void uncaughtException(Thread thread, Throwable error) {
            try {
                long now = System.currentTimeMillis();
                sink.write(fileName("crash", now), crashReport(collectSafely(header), thread == null ? "unknown" : thread.getName(), error));
            } catch (Throwable ignored) {
                // Fall through to the original handler.
            } finally {
                if (previous != null) previous.uncaughtException(thread, error);
            }
        }
    }

    static Map<String, String> collectSafely(Header header) {
        try {
            Map<String, String> values = header.collect();
            if (values != null) return values;
        } catch (Throwable ignored) {
            // Report without device details.
        }
        return Collections.<String, String>emptyMap();
    }

    static String fileName(String kind, long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.US);
        return kind + "-" + format.format(new Date(millis)) + "-" + processId() + ".txt";
    }

    static String crashReport(Map<String, String> header, String threadName, Throwable error) {
        StringBuilder builder = new StringBuilder();
        builder.append("wakeup-noads crash log\n");
        appendHeader(builder, header);
        builder.append("thread: ").append(threadName).append("\n\n");
        builder.append(stackTrace(error));
        return builder.toString();
    }

    static String exitReport(Map<String, String> header, List<ExitRecord> records) {
        StringBuilder builder = new StringBuilder();
        builder.append("wakeup-noads exit log\n");
        appendHeader(builder, header);
        for (ExitRecord record : records) {
            builder.append("\n== ").append(formatTime(record.timestamp)).append(' ')
                .append(reasonName(record.reason)).append(" ==\n");
            builder.append(record.summary).append('\n');
            if (record.trace != null && !record.trace.isEmpty()) {
                builder.append("-- trace --\n").append(record.trace);
                if (!record.trace.endsWith("\n")) builder.append('\n');
            }
        }
        return builder.toString();
    }

    private static void appendHeader(StringBuilder builder, Map<String, String> header) {
        for (Map.Entry<String, String> entry : header.entrySet()) {
            builder.append(entry.getKey()).append(": ").append(entry.getValue()).append('\n');
        }
    }

    static String stackTrace(Throwable error) {
        if (error == null) return "null\n";
        try {
            StringWriter writer = new StringWriter();
            PrintWriter printer = new PrintWriter(writer);
            error.printStackTrace(printer);
            printer.flush();
            return writer.toString();
        } catch (Throwable failure) {
            return error.getClass().getName() + " (stack trace unavailable)\n";
        }
    }

    static boolean isReportable(int reason) {
        switch (reason) {
            case REASON_EXIT_SELF:
            case REASON_SIGNALED:
            case REASON_CRASH:
            case REASON_CRASH_NATIVE:
            case REASON_ANR:
            case REASON_INITIALIZATION_FAILURE:
            case REASON_EXCESSIVE_RESOURCE_USAGE:
                return true;
            default:
                return false;
        }
    }

    static String reasonName(int reason) {
        switch (reason) {
            case REASON_EXIT_SELF: return "EXIT_SELF";
            case REASON_SIGNALED: return "SIGNALED";
            case REASON_CRASH: return "CRASH";
            case REASON_CRASH_NATIVE: return "CRASH_NATIVE";
            case REASON_ANR: return "ANR";
            case REASON_INITIALIZATION_FAILURE: return "INITIALIZATION_FAILURE";
            case REASON_EXCESSIVE_RESOURCE_USAGE: return "EXCESSIVE_RESOURCE_USAGE";
            default: return "REASON_" + reason;
        }
    }

    /** Reportable records newer than the watermark, oldest first. */
    static List<ExitRecord> newRecords(List<ExitRecord> records, long watermark) {
        List<ExitRecord> selected = new ArrayList<ExitRecord>();
        for (ExitRecord record : records) {
            if (record.timestamp > watermark && isReportable(record.reason)) selected.add(record);
        }
        Collections.sort(selected, new Comparator<ExitRecord>() {
            @Override public int compare(ExitRecord left, ExitRecord right) {
                return Long.compare(left.timestamp, right.timestamp);
            }
        });
        return selected;
    }

    static long latestTimestamp(List<ExitRecord> records, long watermark) {
        long latest = watermark;
        for (ExitRecord record : records) latest = Math.max(latest, record.timestamp);
        return latest;
    }

    /** Native tombstones are protobuf; keep only the readable runs (abort message, frames, paths). */
    static String traceText(byte[] data, boolean truncated, boolean binary) {
        String text = binary ? printableRuns(data, MIN_PRINTABLE_RUN) : new String(data, UTF_8);
        return truncated ? text + "\n[truncated]\n" : text;
    }

    static String printableRuns(byte[] data, int minRun) {
        StringBuilder output = new StringBuilder();
        int start = -1;
        for (int index = 0; index <= data.length; index++) {
            boolean printable = index < data.length && (data[index] == '\t' || (data[index] >= 0x20 && data[index] < 0x7f));
            if (printable) {
                if (start < 0) start = index;
            } else if (start >= 0) {
                if (index - start >= minRun) output.append(new String(data, start, index - start, UTF_8)).append('\n');
                start = -1;
            }
        }
        return output.toString();
    }

    static String formatTime(long millis) {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS Z", Locale.US).format(new Date(millis));
    }

    static String processId() {
        try {
            String name = new File("/proc/self").getCanonicalFile().getName();
            boolean digits = !name.isEmpty();
            for (int index = 0; index < name.length(); index++) digits &= Character.isDigit(name.charAt(index));
            if (digits) return name;
        } catch (Throwable ignored) {
            // Not a Linux process filesystem.
        }
        return "0";
    }

    private static String processName() {
        try (InputStream input = new FileInputStream("/proc/self/cmdline")) {
            byte[] data = readLimited(input, 512).toByteArray();
            int end = 0;
            while (end < data.length && data[end] != 0) end++;
            return new String(data, 0, end, UTF_8);
        } catch (Throwable ignored) {
            return "unknown";
        }
    }

    private static ByteArrayOutputStream readLimited(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while (output.size() <= limit && (read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        return output;
    }

    private static final class AndroidPlatform implements Sink, Header {
        private final Object context;
        private final int sdk;

        AndroidPlatform(Object context) {
            this.context = context;
            this.sdk = sdkInt();
        }

        @Override public Map<String, String> collect() {
            Map<String, String> values = new LinkedHashMap<String, String>();
            values.put("time", formatTime(System.currentTimeMillis()));
            values.put("package", safe(new Value() { public Object get() throws Exception { return packageName(); } }));
            values.put("version", safe(new Value() { public Object get() throws Exception { return appVersion(); } }));
            values.put("android", buildField("android.os.Build$VERSION", "RELEASE") + " (API " + sdk + ")");
            values.put("device", buildField("android.os.Build", "MANUFACTURER") + " / " + buildField("android.os.Build", "BRAND")
                + " / " + buildField("android.os.Build", "MODEL") + " / " + buildField("android.os.Build", "DEVICE"));
            values.put("abi", buildField("android.os.Build", "SUPPORTED_ABIS"));
            values.put("fingerprint", buildField("android.os.Build", "FINGERPRINT"));
            values.put("webview", safe(new Value() { public Object get() throws Exception { return webViewVersion(); } }));
            values.put("process", processName() + " (pid " + processId() + ")");
            return values;
        }

        @Override public void write(String fileName, String content) throws Exception {
            byte[] data = content.getBytes(UTF_8);
            Exception failure;
            try {
                if (sdk >= 29) writeMediaStore(fileName, data);
                else writeFile(publicDownloads(), fileName, data);
                return;
            } catch (Exception exception) {
                failure = exception;
            }
            try {
                writeFile(appExternalDir(), fileName, data);
            } catch (Exception exception) {
                throw failure;
            }
        }

        void reportNewExits() throws Exception {
            if (sdk < 30) return;
            File watermarkFile = new File((File) contextMethod("getFilesDir").invoke(context), WATERMARK_FILE);
            long watermark = readWatermark(watermarkFile);
            Object activityManager = contextMethod("getSystemService", String.class).invoke(context, "activity");
            List<?> infos = (List<?>) Class.forName("android.app.ActivityManager")
                .getMethod("getHistoricalProcessExitReasons", String.class, int.class, int.class)
                .invoke(activityManager, null, 0, MAX_EXIT_RECORDS);
            if (infos == null) return;
            Class<?> infoClass = Class.forName("android.app.ApplicationExitInfo");
            Method getTimestamp = infoClass.getMethod("getTimestamp");
            Method getReason = infoClass.getMethod("getReason");
            List<ExitRecord> records = new ArrayList<ExitRecord>();
            for (Object info : infos) {
                records.add(new ExitRecord((Long) getTimestamp.invoke(info), (Integer) getReason.invoke(info), String.valueOf(info), info));
            }
            List<ExitRecord> fresh = newRecords(records, watermark);
            if (!fresh.isEmpty()) {
                Method getTrace = infoClass.getMethod("getTraceInputStream");
                for (ExitRecord record : fresh) record.trace = readTrace(getTrace, record);
                write(fileName("exit", System.currentTimeMillis()), exitReport(collect(), fresh));
            }
            long latest = latestTimestamp(records, watermark);
            if (latest > watermark) writeWatermark(watermarkFile, latest);
        }

        private String readTrace(Method getTrace, ExitRecord record) {
            try (InputStream input = (InputStream) getTrace.invoke(record.source)) {
                if (input == null) return null;
                ByteArrayOutputStream data = readLimited(input, MAX_TRACE_BYTES);
                byte[] bytes = data.toByteArray();
                boolean truncated = bytes.length > MAX_TRACE_BYTES;
                if (truncated) bytes = Arrays.copyOf(bytes, MAX_TRACE_BYTES);
                return traceText(bytes, truncated, record.reason == REASON_CRASH_NATIVE);
            } catch (Throwable failure) {
                return "[trace unavailable: " + failure.getClass().getName() + "]";
            }
        }

        private void writeMediaStore(String fileName, byte[] data) throws Exception {
            Class<?> valuesClass = Class.forName("android.content.ContentValues");
            Class<?> uriClass = Class.forName("android.net.Uri");
            Class<?> resolverClass = Class.forName("android.content.ContentResolver");
            Object values = valuesClass.getConstructor().newInstance();
            Method put = valuesClass.getMethod("put", String.class, String.class);
            put.invoke(values, "_display_name", fileName);
            put.invoke(values, "mime_type", "text/plain");
            put.invoke(values, "relative_path", "Download/" + FOLDER);
            Object resolver = contextMethod("getContentResolver").invoke(context);
            Object collection = Class.forName("android.provider.MediaStore$Downloads").getField("EXTERNAL_CONTENT_URI").get(null);
            Object uri = resolverClass.getMethod("insert", uriClass, valuesClass).invoke(resolver, collection, values);
            if (uri == null) throw new IOException("MediaStore insert returned no entry");
            try (OutputStream output = (OutputStream) resolverClass.getMethod("openOutputStream", uriClass).invoke(resolver, uri)) {
                if (output == null) throw new IOException("MediaStore entry has no output stream");
                output.write(data);
            } catch (Exception failure) {
                try {
                    resolverClass.getMethod("delete", uriClass, String.class, String[].class).invoke(resolver, uri, null, null);
                } catch (Exception ignored) {
                    // Keep the original failure.
                }
                throw failure;
            }
        }

        private File publicDownloads() throws Exception {
            Class<?> environment = Class.forName("android.os.Environment");
            String downloads = (String) environment.getField("DIRECTORY_DOWNLOADS").get(null);
            File root = (File) environment.getMethod("getExternalStoragePublicDirectory", String.class).invoke(null, downloads);
            return new File(root, FOLDER);
        }

        private File appExternalDir() throws Exception {
            File root = (File) contextMethod("getExternalFilesDir", String.class).invoke(context, (Object) null);
            if (root == null) throw new IOException("external files directory unavailable");
            return new File(root, "crash-logs");
        }

        private String packageName() throws Exception {
            return (String) contextMethod("getPackageName").invoke(context);
        }

        private String appVersion() throws Exception {
            Object packageManager = contextMethod("getPackageManager").invoke(context);
            Object info = Class.forName("android.content.pm.PackageManager")
                .getMethod("getPackageInfo", String.class, int.class).invoke(packageManager, packageName(), 0);
            return info.getClass().getField("versionName").get(info) + " (" + info.getClass().getField("versionCode").get(info) + ")";
        }

        private String webViewVersion() throws Exception {
            Object info = Class.forName("android.webkit.WebView").getMethod("getCurrentWebViewPackage").invoke(null);
            if (info == null) return "none";
            return info.getClass().getField("packageName").get(info) + " " + info.getClass().getField("versionName").get(info);
        }

        private Method contextMethod(String name, Class<?>... parameters) throws Exception {
            return Class.forName("android.content.Context").getMethod(name, parameters);
        }
    }

    private interface Value {
        Object get() throws Exception;
    }

    private static String safe(Value value) {
        try {
            return String.valueOf(value.get());
        } catch (Throwable ignored) {
            return "unknown";
        }
    }

    private static int sdkInt() {
        try {
            return Class.forName("android.os.Build$VERSION").getField("SDK_INT").getInt(null);
        } catch (Throwable ignored) {
            return 0;
        }
    }

    private static String buildField(String className, String name) {
        try {
            Object value = Class.forName(className).getField(name).get(null);
            return value instanceof Object[] ? Arrays.toString((Object[]) value) : String.valueOf(value);
        } catch (Throwable ignored) {
            return "unknown";
        }
    }

    static long readWatermark(File file) {
        try (InputStream input = new FileInputStream(file)) {
            return Long.parseLong(new String(readLimited(input, 64).toByteArray(), UTF_8).trim());
        } catch (Throwable ignored) {
            return 0L;
        }
    }

    static void writeWatermark(File file, long value) throws IOException {
        writeFile(file.getParentFile(), file.getName(), Long.toString(value).getBytes(UTF_8));
    }

    static void writeFile(File directory, String fileName, byte[] data) throws IOException {
        if (directory == null) throw new IOException("no target directory");
        if (!directory.isDirectory() && !directory.mkdirs() && !directory.isDirectory()) {
            throw new IOException("cannot create " + directory);
        }
        try (OutputStream output = new FileOutputStream(new File(directory, fileName))) {
            output.write(data);
        }
    }
}
