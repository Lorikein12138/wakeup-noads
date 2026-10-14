package com.suda.yzune.wakeupschedule.slim;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.io.StringReader;
import java.io.StringWriter;
import java.io.Writer;
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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Local-only crash log. Uncaught Java exceptions and the abnormal exits recorded by the system
 * (Android 11+, including native crashes and ANRs) are written as UTF-8 text files to the
 * app's external-files/crash-logs directory on every supported Android version.
 * Nothing is uploaded. Android APIs are reached by reflection because the runtime is compiled
 * without android.jar.
 */
public final class CrashLog {
    static final String FOLDER = "wakeup-noads";
    static final String LOG_DIRECTORY = "crash-logs";
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
    private static final int MAX_SANITIZE_LINE = 16 * 1024;
    private static final String REDACTED = "[redacted]";
    private static final Pattern DATE_VALUE = Pattern.compile("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3} [+-]\\d{4}");
    private static final String SAFE_NUMERIC_VERSION = "[0-9]{1,4}(?:\\.[0-9]{1,4}){0,3}";
    private static final String SAFE_VERSION_TOKEN = "(?:[vV]?" + SAFE_NUMERIC_VERSION + "(?:-r[0-9]{1,4})?|wakeup-noads-v" + SAFE_NUMERIC_VERSION + "-r[0-9]{1,4})";
    private static final Pattern VERSION_VALUE = Pattern.compile("(" + SAFE_VERSION_TOKEN + ") \\(([1-9][0-9]{0,9})\\)");
    private static final Pattern ANDROID_VALUE = Pattern.compile("(" + SAFE_NUMERIC_VERSION + ") \\(API ([0-9]{1,3})\\)");
    private static final Pattern WEBVIEW_VALUE = Pattern.compile("(com\\.android\\.webview|com\\.google\\.android\\.webview|com\\.android\\.chrome) (" + SAFE_NUMERIC_VERSION + ")");
    private static final Pattern PACKAGE_VALUE = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)+");
    private static final Pattern JAVA_FRAME = Pattern.compile("(?:\\t| {4})at ([A-Za-z_$][A-Za-z0-9_$.]*?)\\.([A-Za-z_$<>][A-Za-z0-9_$<>]*)\\(([^()\\r\\n]*)\\)");
    private static final Pattern JAVA_TYPE_LINE = Pattern.compile("(?:(Caused by: |Suppressed: ))?([A-Za-z_$][A-Za-z0-9_$.]*)(?::.*)?");
    private static final Pattern NATIVE_FRAME = Pattern.compile("#(\\d{1,4})\\s+pc\\s+([0-9a-fA-F]{1,16})\\s+(.+)");
    private static final Pattern SENSITIVE_SHAPE = Pattern.compile("(?i)(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}|(?:https?|file|content)://|\\bwww\\.|\\b(?:password|passwd|authorization|cookie|set-cookie|token|session|jwt|api[_ -]?key|secret)\\b|\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b|\\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\\b|\\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\\b|\\d{6,}|[A-Za-z0-9+/]{32,}={0,2})");
    private static final Pattern SENSITIVE_MARKER = Pattern.compile("(?i)(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}|(?:https?|file|content)://|\\bwww\\.|\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b|\\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\\b|\\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\\b|[0-9a-f]{32,}|[A-Za-z0-9+/]{32,}={0,2})");
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
        builder.append("thread: ").append(safeThreadName(threadName)).append("\n\n");
        builder.append(stackTrace(error));
        return sanitizeText(builder.toString());
    }

    static String exitReport(Map<String, String> header, List<ExitRecord> records) {
        StringBuilder builder = new StringBuilder();
        builder.append("wakeup-noads exit log\n");
        appendHeader(builder, header);
        for (ExitRecord record : records) {
            builder.append("\n== ").append(formatTime(record.timestamp)).append(' ')
                .append(reasonName(record.reason)).append(" ==\n");
            builder.append(REDACTED).append('\n');
            if (record.trace != null && !record.trace.isEmpty()) {
                builder.append("-- trace --\n").append(record.trace);
                if (!record.trace.endsWith("\n")) builder.append('\n');
            }
        }
        return sanitizeText(builder.toString());
    }

    private static void appendHeader(StringBuilder builder, Map<String, String> header) {
        if (header == null) return;
        for (Map.Entry<String, String> entry : header.entrySet()) {
            String key = safeHeaderKey(entry.getKey());
            if (key == null) continue;
            builder.append(key).append(": ").append(safeHeaderValue(key, entry.getValue())).append('\n');
        }
    }

    static String stackTrace(Throwable error) {
        StringBuilder builder = new StringBuilder();
        appendThrowable(builder, error, "", new ArrayList<Throwable>(), null, 0);
        return builder.toString();
    }

    private static void appendThrowable(StringBuilder out, Throwable error, String prefix, List<Throwable> seen,
                                        StackTraceElement[] parent, int depth) {
        if (error == null) { out.append(prefix).append("null\n"); return; }
        if (depth >= 32) { out.append(prefix).append("[cause depth limit]\n"); return; }
        for (Throwable previous : seen) if (previous == error) { out.append(prefix).append("[cyclic cause]\n"); return; }
        seen.add(error);
        out.append(prefix).append(safeClassName(error.getClass().getName())).append(": ").append(REDACTED).append('\n');
        StackTraceElement[] frames;
        try { frames = error.getStackTrace(); }
        catch (Throwable ignored) { out.append(prefix).append("    [stack trace unavailable]\n"); frames = new StackTraceElement[0]; }
        if (frames == null) frames = new StackTraceElement[0];
        int common = commonFrames(frames, parent);
        int limit = Math.min(frames.length - common, 512);
        for (int index = 0; index < limit; index++) out.append("\tat ").append(safeFrame(frames[index])).append('\n');
        if (frames.length - common > limit) out.append("\t[stack frames hidden]\n");
        if (common > 0) out.append("\t... ").append(common).append(" more\n");
        Throwable[] suppressed;
        try { suppressed = error.getSuppressed(); }
        catch (Throwable ignored) { suppressed = new Throwable[0]; out.append(prefix).append("[suppressed list unavailable]\n"); }
        if (suppressed == null) suppressed = new Throwable[0];
        for (Throwable child : suppressed) appendThrowable(out, child, "Suppressed: ", seen, frames, depth + 1);
        Throwable cause;
        try { cause = error.getCause(); }
        catch (Throwable ignored) { cause = null; out.append(prefix).append("[cause unavailable]\n"); }
        if (cause != null) appendThrowable(out, cause, "Caused by: ", seen, frames, depth + 1);
    }

    private static int commonFrames(StackTraceElement[] frames, StackTraceElement[] parent) {
        if (frames == null || parent == null) return 0;
        int left = frames.length - 1, right = parent.length - 1, count = 0;
        while (left >= 0 && right >= 0 && frames[left].equals(parent[right])) { left--; right--; count++; }
        return count;
    }

    private static String safeFrame(StackTraceElement frame) {
        if (frame == null) return REDACTED;
        try {
            String owner = safeClassName(frame.getClassName());
            String method = safeMethodName(frame.getMethodName());
            String file = frame.getFileName();
            String source;
            if (frame.isNativeMethod()) source = "Native Method";
            else if (file == null) source = "Unknown Source";
            else if (safeSourceName(file)) source = file + (frame.getLineNumber() >= 0 ? ":" + frame.getLineNumber() : "");
            else source = REDACTED;
            if (REDACTED.equals(owner) || REDACTED.equals(method)) return REDACTED;
            return owner + "." + method + "(" + source + ")";
        } catch (Throwable ignored) { return REDACTED; }
    }

    private static String safeClassName(String value) {
        return value != null && value.matches("[A-Za-z_$][A-Za-z0-9_$.]*") && !containsSensitiveShape(value) ? value : REDACTED;
    }
    private static String safeMethodName(String value) {
        return value != null && value.matches("[A-Za-z_$<>][A-Za-z0-9_$<>]*") && !containsSensitiveShape(value) ? value : REDACTED;
    }
    private static boolean safeSourceName(String value) {
        return value != null && value.matches("[A-Za-z0-9_$.-]{1,128}(?:\\.[A-Za-z0-9]{1,8})?")
            && !value.contains("..") && !containsSensitiveShape(value);
    }
    private static String safeThreadName(String value) {
        if (value == null) return REDACTED;
        if ("main".equals(value) || value.matches("Thread-\\d{1,5}") || value.matches("pool-\\d{1,4}-thread-\\d{1,5}")
            || value.matches("DefaultDispatcher-worker-\\d{1,5}")) return value;
        return REDACTED;
    }

    static String sanitizeText(String text) {
        if (text == null || text.isEmpty()) return "";
        StringWriter output = new StringWriter();
        try { sanitize(new StringReader(text), output); return output.toString(); }
        catch (Throwable ignored) { return "日志内容已隐藏：脱敏失败\n"; }
    }

    static void writeSanitized(InputStream input, OutputStream output) throws IOException {
        if (input == null || output == null) throw new IOException("日志流不可用");
        sanitize(new InputStreamReader(input, UTF_8), new OutputStreamWriterCompat(output));
    }

    private static void sanitize(Reader input, Writer output) throws IOException {
        char[] buffer = new char[4096];
        StringBuilder line = new StringBuilder();
        boolean overlong = false;
        int count;
        while ((count = input.read(buffer)) != -1) {
            for (int index = 0; index < count; index++) {
                char ch = buffer[index];
                if (ch == '\n') {
                    writeSanitizedLine(output, line, overlong, true);
                    line.setLength(0); overlong = false;
                } else if (!overlong) {
                    if (line.length() >= MAX_SANITIZE_LINE) { line.setLength(0); overlong = true; }
                    else line.append(ch);
                }
            }
        }
        if (line.length() > 0 || overlong) writeSanitizedLine(output, line, overlong, false);
        output.flush();
    }

    private static void writeSanitizedLine(Writer output, StringBuilder line, boolean overlong, boolean newline) throws IOException {
        String value = overlong ? REDACTED : sanitizeLine(line.toString());
        output.write(value);
        if (newline) output.write('\n');
    }

    private static String sanitizeLine(String line) {
        String value = line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
        if (value.isEmpty()) return "";
        if ("wakeup-noads crash log".equals(value) || "wakeup-noads exit log".equals(value)
            || "-- trace --".equals(value) || REDACTED.equals(value) || "[truncated]".equals(value)
            || "[trace unavailable]".equals(value) || "[stack trace unavailable]".equals(value)
            || "[stack frames hidden]".equals(value) || "[cause unavailable]".equals(value)
            || "[suppressed list unavailable]".equals(value) || "[cause depth limit]".equals(value)
            || "[cyclic cause]".equals(value)) return value;
        if (value.startsWith("thread: ")) return "thread: " + safeThreadName(value.substring(8));
        int colon = value.indexOf(": ");
        if (colon > 0) {
            String key = safeHeaderKey(value.substring(0, colon));
            if (key != null) return key + ": " + safeHeaderValue(key, value.substring(colon + 2));
        }
        if (value.startsWith("== ") && value.endsWith(" ==")) {
            String inner = value.substring(3, value.length() - 3);
            int split = inner.lastIndexOf(' ');
            if (split > 0 && DATE_VALUE.matcher(inner.substring(0, split)).matches() && safeReason(inner.substring(split + 1))) return value;
            return REDACTED;
        }
        Matcher frame = JAVA_FRAME.matcher(value);
        if (frame.matches()) {
            String owner = safeClassName(frame.group(1));
            String method = safeMethodName(frame.group(2));
            String location = safeJavaLocation(frame.group(3));
            if (!REDACTED.equals(owner) && !REDACTED.equals(method)) return "\tat " + owner + "." + method + "(" + location + ")";
            return REDACTED;
        }
        Matcher nativeFrame = NATIVE_FRAME.matcher(value);
        if (nativeFrame.matches()) {
            String parsed = safeNativeFrame(nativeFrame.group(1), nativeFrame.group(2), nativeFrame.group(3));
            return parsed == null ? REDACTED : parsed;
        }
        if (value.matches("\\s*\\.\\.\\. \\d{1,4} more")) return value.trim();
        Matcher type = JAVA_TYPE_LINE.matcher(value);
        if (type.matches()) {
            String name = safeClassName(type.group(2));
            if (!REDACTED.equals(name) && isThrowableTypeName(type.group(2))) return (type.group(1) == null ? "" : type.group(1)) + name + ": " + REDACTED;
        }
        return REDACTED;
    }

    private static boolean isThrowableTypeName(String name) {
        return name != null && (name.indexOf('.') >= 0 || name.endsWith("Exception") || name.endsWith("Error") || name.endsWith("Throwable"));
    }

    private static String safeHeaderKey(String key) {
        if ("time".equals(key) || "package".equals(key) || "version".equals(key) || "android".equals(key)
            || "abi".equals(key) || "webview".equals(key) || "pid".equals(key)) return key;
        return null;
    }
    private static String safeHeaderValue(String key, String value) {
        if (value == null || hasControlCharacter(value)) return REDACTED;
        if ("package".equals(key)) return PACKAGE_VALUE.matcher(value).matches() && "io.github.wakeupnoads".equals(value) ? value : REDACTED;
        if ("time".equals(key)) return DATE_VALUE.matcher(value).matches() ? value : REDACTED;
        if ("version".equals(key)) {
            Matcher match = VERSION_VALUE.matcher(value);
            return match.matches() && positiveIntAtMost(match.group(2), Integer.MAX_VALUE) ? value : REDACTED;
        }
        if ("android".equals(key)) {
            Matcher match = ANDROID_VALUE.matcher(value);
            return match.matches() && positiveIntAtMost(match.group(2), 999) ? value : REDACTED;
        }
        if ("abi".equals(key)) return safeAbiList(value) ? value : REDACTED;
        if ("pid".equals(key)) return value.matches("\\d{1,10}") ? value : REDACTED;
        if ("webview".equals(key)) {
            if ("none".equals(value) || "unknown".equals(value)) return value;
            return WEBVIEW_VALUE.matcher(value).matches() ? value : REDACTED;
        }
        return REDACTED;
    }
    private static boolean positiveIntAtMost(String value, int maximum) {
        try { int parsed = Integer.parseInt(value); return parsed > 0 && parsed <= maximum; }
        catch (NumberFormatException ignored) { return false; }
    }
    private static boolean hasControlCharacter(String value) {
        for (int index = 0; index < value.length(); index++) if (Character.isISOControl(value.charAt(index))) return true;
        return false;
    }
    private static boolean safeAbiList(String value) {
        String body = value;
        boolean list = value.startsWith("[") || value.endsWith("]");
        if (list) {
            if (!(value.startsWith("[") && value.endsWith("]"))) return false;
            body = value.substring(1, value.length() - 1);
            if (body.isEmpty()) return false;
        }
        String[] atoms = body.split(list ? ", " : ",", -1);
        if (!list && atoms.length != 1) return false;
        for (String atom : atoms) {
            if (!("armeabi".equals(atom) || "armeabi-v7a".equals(atom) || "arm64-v8a".equals(atom)
                || "x86".equals(atom) || "x86_64".equals(atom) || "mips".equals(atom) || "mips64".equals(atom))) return false;
        }
        return true;
    }
    private static boolean containsSensitiveShape(String value) { return value == null || SENSITIVE_SHAPE.matcher(value).find(); }
    private static boolean containsSensitiveMarker(String value) {
        if (value == null) return true;
        String lower = value.toLowerCase(Locale.US);
        return SENSITIVE_MARKER.matcher(value).find() || lower.contains("password") || lower.contains("authorization") || lower.contains("cookie")
            || lower.contains("token") || lower.contains("session") || lower.contains("secret")
            || lower.contains("http://") || lower.contains("https://") || lower.contains("@");
    }
    static String safeTypeName(String value) { return safeClassName(value); }
    private static boolean safeReason(String value) {
        return "EXIT_SELF".equals(value) || "SIGNALED".equals(value) || "CRASH".equals(value) || "CRASH_NATIVE".equals(value)
            || "ANR".equals(value) || "INITIALIZATION_FAILURE".equals(value) || "EXCESSIVE_RESOURCE_USAGE".equals(value)
            || value.matches("REASON_\\d{1,2}");
    }
    private static String safeJavaLocation(String value) {
        if ("Native Method".equals(value) || "Unknown Source".equals(value)) return value;
        Matcher match = Pattern.compile("([A-Za-z0-9_$.-]{1,128}(?:\\.[A-Za-z0-9]{1,8})?)(?::(\\d{1,7}))?").matcher(value);
        if (!match.matches() || match.group(1).contains("..") || containsSensitiveShape(match.group(1))) return REDACTED;
        return match.group(1) + (match.group(2) == null ? "" : ":" + match.group(2));
    }
    private static String safeNativeFrame(String index, String pc, String detail) {
        Matcher library = Pattern.compile("(?:.*/)?([A-Za-z0-9_.+-]{1,128}\\.so)(?: \\(([^()]*)\\))?").matcher(detail);
        if (!library.matches()) return null;
        String basename = library.group(1), symbol = library.group(2);
        if (containsSensitiveShape(basename)) return null;
        if (symbol != null && !symbol.matches("[A-Za-z_$][A-Za-z0-9_$.]*\\+\\d{1,7}") || symbol != null && containsSensitiveShape(symbol)) symbol = null;
        return "#" + index + " pc " + pc.toLowerCase(Locale.US) + " " + basename + (symbol == null ? "" : " (" + symbol + ")");
    }

    private static final class OutputStreamWriterCompat extends Writer {
        private final OutputStream output;
        OutputStreamWriterCompat(OutputStream output) { this.output = output; }
        @Override public void write(char[] chars, int offset, int length) throws IOException { output.write(new String(chars, offset, length).getBytes(UTF_8)); }
        @Override public void write(String value, int offset, int length) throws IOException { output.write(value.substring(offset, offset + length).getBytes(UTF_8)); }
        @Override public void flush() throws IOException { output.flush(); }
        @Override public void close() throws IOException { flush(); }
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
            values.put("abi", buildField("android.os.Build", "SUPPORTED_ABIS"));
            values.put("webview", safe(new Value() { public Object get() throws Exception { return webViewVersion(); } }));
            values.put("pid", processId());
            return values;
        }

        @Override public void write(String fileName, String content) throws Exception {
            writeAutomaticLog((File) contextMethod("getExternalFilesDir", String.class).invoke(context, (Object) null), fileName, content);
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
                records.add(new ExitRecord((Long) getTimestamp.invoke(info), (Integer) getReason.invoke(info), REDACTED, info));
            }
            List<ExitRecord> fresh = newRecords(records, watermark);
            String report = null;
            String name = null;
            if (!fresh.isEmpty()) {
                Method getTrace = infoClass.getMethod("getTraceInputStream");
                for (ExitRecord record : fresh) record.trace = readTrace(getTrace, record);
                name = fileName("exit", System.currentTimeMillis());
                report = exitReport(collect(), fresh);
            }
            long latest = latestTimestamp(records, watermark);
            persistExitReportThenWatermark(this, name, report, watermarkFile, watermark, latest);
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
                return "[trace unavailable]";
            }
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

    static void persistExitReportThenWatermark(Sink sink, String fileName, String report, File watermarkFile,
                                                long oldWatermark, long latestTimestamp) throws Exception {
        if (report != null) sink.write(fileName, report);
        if (latestTimestamp > oldWatermark) writeWatermark(watermarkFile, latestTimestamp);
    }

    /** Resolves the single app-owned log directory from getExternalFilesDir(null). */
    static File logDirectory(File externalFilesRoot) throws IOException {
        if (externalFilesRoot == null) throw new IOException("external files directory unavailable");
        return new File(externalFilesRoot, LOG_DIRECTORY);
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

    static File writeAutomaticLog(File externalFilesRoot, String fileName, String content) throws IOException {
        File directory = logDirectory(externalFilesRoot);
        ByteArrayOutputStream sanitized = new ByteArrayOutputStream();
        writeSanitized(new java.io.ByteArrayInputStream((content == null ? "" : content).getBytes(UTF_8)), sanitized);
        writeFile(directory, fileName, sanitized.toByteArray());
        return new File(directory, fileName);
    }
}
