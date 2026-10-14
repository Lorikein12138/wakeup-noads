package com.suda.yzune.wakeupschedule.slim;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Local, read-only index of this app's crash and exit logs. Android calls are reflective. */
final class LogStore {
    static final int PREVIEW_LIMIT = 256 * 1024;
    static final int COPY_LIMIT = 64 * 1024;
    static final String PACKAGE_NAME = "io.github.wakeupnoads";
    static final String HISTORY_FOLDER = "wakeup-noads";
    static final String EXPORT_FOLDER = "wakeup-noads-log-export";
    static final String EXPORT_PREFIX = "wakeup-noads-log-export-";
    private static final Charset UTF_8 = Charset.forName("UTF-8");
    static final String LEGACY_UNREADABLE = "旧版日志（Download 目录）暂时无法读取";
    static final String APP_UNREADABLE = "应用日志目录暂时无法读取";
    private static final String NAME_PATTERN ="^(crash|exit)-[0-9]{8}-[0-9]{6}-[0-9]{3}-[0-9]+\\.txt$";

    interface Source {
        String key();
        String label();
        Scan scan() throws Exception;
        InputStream open(Entry entry) throws Exception;
    }

    interface OutputFactory { OutputStream open(File file) throws Exception; }
    interface CanonicalPaths { String canonicalPath(File file) throws IOException; }

    interface MediaCursor {
        int getColumnIndex(String name) throws Exception;
        boolean moveToNext() throws Exception;
        String getString(int index) throws Exception;
        long getLong(int index) throws Exception;
        void close() throws Exception;
    }

    interface MediaPlatform {
        Object downloadsCollection() throws Exception;
        MediaCursor query(Object context, Object collection, String[] projection, String selection,
                          String[] arguments, String sortOrder) throws Exception;
        Object withAppendedId(Object collection, long id) throws Exception;
        InputStream open(Object context, Object uri) throws Exception;
    }

    static final class Scan {
        final List<Entry> entries;
        final boolean accessible;
        final String message;

        Scan(List<Entry> entries, boolean accessible, String message) {
            this.entries = entries == null ? Collections.<Entry>emptyList() : entries;
            this.accessible = accessible;
            this.message = message;
        }

        static Scan readable(List<Entry> entries) { return new Scan(entries, true, null); }
        static Scan unavailable(String message) { return new Scan(Collections.<Entry>emptyList(), false, message); }
    }

    static final class Entry {
        final String key;
        final String sourceKey;
        final String sourceLabel;
        final String fileName;
        final long modifiedMillis;
        final Source source;
        final Object handle;
        final File boundaryRoot;
        final String ownerPackage;
        final String relativePath;
        final String uriScheme;
        volatile Summary summary;

        Entry(String key, String sourceKey, String sourceLabel, String fileName, long modifiedMillis, Source source,
              Object handle, File boundaryRoot, String ownerPackage, String relativePath, String uriScheme) {
            this.key = key;
            this.sourceKey = sourceKey;
            this.sourceLabel = sourceLabel;
            this.fileName = fileName;
            this.modifiedMillis = modifiedMillis;
            this.source = source;
            this.handle = handle;
            this.boundaryRoot = boundaryRoot;
            this.ownerPackage = ownerPackage;
            this.relativePath = relativePath;
            this.uriScheme = uriScheme;
        }

        boolean isCrashFile() { return fileName.startsWith("crash-"); }
        Summary summary() {
            Summary value = summary;
            return value != null ? value : Summary.fallback(isCrashFile());
        }
    }

    static final int LEVEL_NORMAL = 0;
    static final int LEVEL_WARNING = 1;
    static final int LEVEL_ERROR = 2;
    private static final int SUMMARY_SCAN_LIMIT = 1024 * 1024;
    private static final int MAX_SUMMARY_RECORDS = 16;
    private static final Pattern RECORD_LINE = Pattern.compile(
        "== (\\d{4})-(\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})\\.\\d{3} [+-]\\d{4} (EXIT_SELF|SIGNALED|CRASH|CRASH_NATIVE|ANR|INITIALIZATION_FAILURE|EXCESSIVE_RESOURCE_USAGE|REASON_\\d{1,6}) ==");

    /** One process-exit record of an exit log: its time (MM-dd HH:mm:ss) and readable type. */
    static final class Record {
        final String time;
        final String title;
        final int level;
        final int rank;
        Record(String time, String title, int level, int rank) {
            this.time = time;
            this.title = title;
            this.level = level;
            this.rank = rank;
        }
    }

    /** Readable classification of one log file; the most severe record decides title and level. */
    static final class Summary {
        final String title;
        final int level;
        final List<Record> records;

        Summary(String title, int level, List<Record> records) {
            this.title = title;
            this.level = level;
            this.records = records == null ? Collections.<Record>emptyList() : records;
        }

        String levelText() { return levelText(level); }
        int recordCount() { return Math.max(1, records.size()); }

        static String levelText(int level) { return level == LEVEL_ERROR ? "错误" : level == LEVEL_WARNING ? "警告" : "正常"; }

        static Summary fallback(boolean crashFile) {
            return crashFile ? new Summary("应用崩溃", LEVEL_ERROR, null) : new Summary("异常退出", LEVEL_WARNING, null);
        }

        static Summary of(boolean crashFile, List<Record> records) {
            if (crashFile || records == null || records.isEmpty()) return fallback(crashFile);
            Record worst = null;
            for (Record record : records) if (worst == null || record.rank >= worst.rank) worst = record;
            return new Summary(worst.title, worst.level, Collections.unmodifiableList(new ArrayList<Record>(records)));
        }
    }

    static Record record(String time, String reason) {
        if ("CRASH_NATIVE".equals(reason)) return new Record(time, "底层崩溃", LEVEL_ERROR, 9);
        if ("CRASH".equals(reason)) return new Record(time, "应用崩溃（系统记录）", LEVEL_ERROR, 8);
        if ("INITIALIZATION_FAILURE".equals(reason)) return new Record(time, "启动失败", LEVEL_ERROR, 7);
        if ("ANR".equals(reason)) return new Record(time, "应用无响应", LEVEL_WARNING, 6);
        if ("EXCESSIVE_RESOURCE_USAGE".equals(reason)) return new Record(time, "资源占用过高", LEVEL_WARNING, 5);
        if ("SIGNALED".equals(reason)) return new Record(time, "被系统终止", LEVEL_WARNING, 4);
        if ("EXIT_SELF".equals(reason)) return new Record(time, "自行退出", LEVEL_NORMAL, 1);
        return new Record(time, "异常退出", LEVEL_WARNING, 3);
    }

    /** Reads only the record header lines of an exit log; any failure keeps the file-name fallback. */
    static Summary summarize(Entry entry) {
        if (entry == null) return Summary.fallback(false);
        boolean crashFile = entry.isCrashFile();
        if (crashFile || entry.source == null) return Summary.fallback(crashFile);
        List<Record> records = new ArrayList<Record>();
        try {
            InputStream opened = entry.source.open(entry);
            if (opened == null) return Summary.fallback(false);
            try (InputStream input = opened) {
                byte[] buffer = new byte[8192];
                StringBuilder line = new StringBuilder();
                boolean overlong = false;
                long total = 0;
                int count;
                while (total < SUMMARY_SCAN_LIMIT && records.size() < MAX_SUMMARY_RECORDS
                    && (count = input.read(buffer, 0, (int) Math.min(buffer.length, SUMMARY_SCAN_LIMIT - total))) != -1) {
                    total += count;
                    for (int index = 0; index < count && records.size() < MAX_SUMMARY_RECORDS; index++) {
                        int value = buffer[index] & 0xff;
                        if (value == '\n') {
                            if (!overlong) addRecord(records, line);
                            line.setLength(0);
                            overlong = false;
                        } else if (!overlong) {
                            if (line.length() >= 96) overlong = true;
                            else line.append((char) value);
                        }
                    }
                }
                if (!overlong && records.size() < MAX_SUMMARY_RECORDS) addRecord(records, line);
            }
        } catch (Throwable ignored) {
            if (records.isEmpty()) return Summary.fallback(false);
        }
        return Summary.of(false, records);
    }

    private static void addRecord(List<Record> records, StringBuilder line) {
        int length = line.length();
        if (length > 0 && line.charAt(length - 1) == '\r') line.setLength(length - 1);
        Matcher matcher = RECORD_LINE.matcher(line);
        if (matcher.matches()) records.add(record(matcher.group(2), matcher.group(3)));
    }

    static final class Result {
        final List<Entry> entries;
        final List<String> sourceErrors;
        final int readableSources;
        final int totalSources;

        Result(List<Entry> entries, List<String> sourceErrors, int readableSources, int totalSources) {
            this.entries = entries;
            this.sourceErrors = sourceErrors;
            this.readableSources = readableSources;
            this.totalSources = totalSources;
        }

        boolean hasErrors() { return !sourceErrors.isEmpty(); }
        boolean isEmpty() { return entries.isEmpty(); }
        String stateText() {
            if (sourceErrors.isEmpty()) return entries.isEmpty() ? "暂无日志" : "";
            if (readableSources == 0) return "日志来源不可读取";
            for (String error : sourceErrors) if (error.startsWith("历史 Download")) return LEGACY_UNREADABLE;
            return APP_UNREADABLE;
        }
    }

    static final class Preview {
        final String text;
        final boolean truncated;
        Preview(String text, boolean truncated) { this.text = text; this.truncated = truncated; }
    }

    static final class CopyText {
        final String text;
        final boolean truncated;
        CopyText(String text, boolean truncated) { this.text = text; this.truncated = truncated; }
    }

    private static final class ReadResult {
        final byte[] bytes;
        final boolean truncated;
        ReadResult(byte[] bytes, boolean truncated) { this.bytes = bytes; this.truncated = truncated; }
    }

    private final List<Source> sources;
    private final OutputFactory outputFactory;

    LogStore(List<Source> sources) {
        this(sources, new OutputFactory() {
            @Override public OutputStream open(File file) throws Exception { return new FileOutputStream(file); }
        });
    }

    LogStore(List<Source> sources, OutputFactory outputFactory) {
        this.sources = new ArrayList<Source>(sources);
        this.outputFactory = outputFactory;
    }

    static LogStore forContext(Object context) throws Exception {
        Object external = call(context, "getExternalFilesDir", new Class<?>[] { String.class }, new Object[] { null });
        return forContext(context, sdkInt(), external instanceof File ? (File) external : null, legacyDirectory(), new ReflectiveMediaPlatform());
    }

    static LogStore forContext(Object context, int sdk, File externalFilesDirectory, File legacyDownloadDirectory,
                               MediaPlatform mediaPlatform) throws IOException {
        List<Source> sources = new ArrayList<Source>();
        File privateRoot = externalFilesDirectory == null ? null : CrashLog.logDirectory(externalFilesDirectory);
        sources.add(new AppDirectorySource(privateRoot));
        if (sdk >= 29) sources.add(new MediaStoreSource(context, mediaPlatform));
        else sources.add(new LegacyDownloadSource(legacyDownloadDirectory));
        return new LogStore(sources);
    }

    private static File legacyDirectory() {
        try {
            Class<?> environment = Class.forName("android.os.Environment");
            String downloads = (String) environment.getField("DIRECTORY_DOWNLOADS").get(null);
            File root = (File) environment.getMethod("getExternalStoragePublicDirectory", String.class).invoke(null, downloads);
            return new File(root, HISTORY_FOLDER);
        } catch (Throwable ignored) { return null; }
    }

    Result list() {
        List<Entry> entries = new ArrayList<Entry>();
        List<String> errors = new ArrayList<String>();
        int readable = 0;
        for (Source source : sources) {
            try {
                Scan scan = source.scan();
                if (scan == null || !scan.accessible) {
                    errors.add(safeLabel(source) + "不可读取");
                    continue;
                }
                readable++;
                for (Entry entry : scan.entries) if (validEntry(entry)) entries.add(entry);
            } catch (Throwable failure) {
                errors.add(safeLabel(source) + "不可读取：" + shortError(failure));
            }
        }
        Collections.sort(entries, new Comparator<Entry>() {
            @Override public int compare(Entry left, Entry right) {
                int time = Long.compare(right.modifiedMillis, left.modifiedMillis);
                if (time != 0) return time;
                int source = left.sourceKey.compareTo(right.sourceKey);
                if (source != 0) return source;
                int name = left.fileName.compareTo(right.fileName);
                if (name != 0) return name;
                return left.key.compareTo(right.key);
            }
        });
        for (Entry entry : entries) entry.summary = summarize(entry);
        return new Result(Collections.unmodifiableList(entries), Collections.unmodifiableList(errors), readable, sources.size());
    }

    Preview preview(Entry entry) throws IOException {
        ReadResult result = read(entry, PREVIEW_LIMIT + 1);
        byte[] data = result.bytes;
        boolean truncated = result.truncated || data.length > PREVIEW_LIMIT;
        int length = truncated ? safeUtf8Prefix(data, PREVIEW_LIMIT) : data.length;
        String text = new String(data, 0, length, UTF_8);
        if (truncated) text += "\n[truncated]\n";
        return new Preview(text, truncated);
    }

    CopyText copyText(Entry entry) throws IOException {
        ReadResult result = read(entry, COPY_LIMIT + 1);
        byte[] data = result.bytes;
        boolean truncated = result.truncated || data.length > COPY_LIMIT;
        if (!truncated) return new CopyText(new String(data, UTF_8), false);
        String marker = "\n[truncated]\n";
        int prefix = safeUtf8Prefix(data, COPY_LIMIT - marker.getBytes(UTF_8).length);
        return new CopyText(new String(data, 0, prefix, UTF_8) + marker, true);
    }

    File snapshot(Entry entry, File cacheDirectory) throws IOException {
        if (cacheDirectory == null) throw new IOException("导出缓存不可用");
        File root = new File(cacheDirectory, EXPORT_FOLDER);
        if (!root.isDirectory() && !root.mkdirs() && !root.isDirectory()) throw new IOException("无法创建导出快照目录");
        File target = new File(root, EXPORT_PREFIX + UUID.randomUUID().toString() + ".tmp");
        assertSnapshot(cacheDirectory, target);
        boolean complete = false;
        IOException failure = null;
        try {
            InputStream opened = entry.source.open(entry);
            if (opened == null) throw new IOException("日志文件无法打开");
            try (InputStream input = opened; OutputStream output = outputFactory.open(target)) {
                if (output == null) throw new IOException("无法创建导出快照");
                writeSanitizedSnapshot(input, output);
            }
            complete = true;
        } catch (Throwable caught) {
            if (caught instanceof IOException) failure = (IOException) caught;
            else failure = new IOException("无法创建完整日志快照", caught);
        }
        if (!complete) {
            if (target.exists() && !target.delete()) failure.addSuppressed(new IOException("无法清理不完整快照"));
            throw failure;
        }
        return target;
    }

    static void assertSnapshot(File cacheDirectory, File target) throws IOException {
        assertSnapshot(cacheDirectory, target, new CanonicalPaths() {
            @Override public String canonicalPath(File file) throws IOException { return file.getCanonicalPath(); }
        });
    }

    static void assertSnapshot(File cacheDirectory, File target, CanonicalPaths paths) throws IOException {
        if (cacheDirectory == null || target == null) throw new IOException("导出快照路径无效");
        if (paths == null) throw new IOException("导出快照路径无效");
        String canonicalCache = paths.canonicalPath(cacheDirectory);
        File root = new File(cacheDirectory, EXPORT_FOLDER);
        String canonicalRoot = paths.canonicalPath(root);
        String canonicalTarget = paths.canonicalPath(target);
        String canonicalParent = target.getParentFile() == null ? null : paths.canonicalPath(target.getParentFile());
        if (!canonicalRoot.startsWith(canonicalCache + File.separator)
            || !EXPORT_FOLDER.equals(root.getName())
            || !canonicalRoot.equals(canonicalParent)
            || !canonicalTarget.startsWith(canonicalRoot + File.separator)
            || !target.getName().matches("wakeup-noads-log-export-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp")) {
            throw new IOException("导出快照路径无效");
        }
    }

    static void writeSanitizedSnapshot(InputStream input, OutputStream output) throws IOException {
        CrashLog.writeSanitized(input, output);
    }

    Source sourceAt(int index) { return sources.get(index); }

    private ReadResult read(Entry entry, int limit) throws IOException {
        if (entry == null || entry.source == null || !validName(entry.fileName)) throw new IOException("日志条目无效");
        try {
            InputStream opened = entry.source.open(entry);
            if (opened == null) throw new IOException("日志文件已消失或不可读取");
            try (InputStream input = opened) {
                final ByteArrayOutputStream output = new ByteArrayOutputStream(Math.min(limit, 8192));
                final long[] total = new long[] { 0L };
                OutputStream capped = new OutputStream() {
                    @Override public void write(int value) {
                        if (total[0] < limit) output.write(value);
                        total[0]++;
                    }
                    @Override public void write(byte[] bytes, int offset, int length) {
                        int retain = (int) Math.max(0L, Math.min((long) length, limit - total[0]));
                        if (retain > 0) output.write(bytes, offset, retain);
                        total[0] += length;
                    }
                };
                CrashLog.writeSanitized(input, capped);
                return new ReadResult(output.toByteArray(), total[0] > limit);
            }
        } catch (IOException failure) {
            throw failure;
        } catch (Throwable failure) {
            throw new IOException("日志文件读取失败", failure);
        }
    }

    private static int safeUtf8Prefix(byte[] data, int maximum) {
        int end = Math.min(data.length, maximum);
        if (end == data.length || end == 0) return end;
        if (data[end - 1] == '\r' && data[end] == '\n') return end - 1;
        int start = end - 1;
        while (start >= 0 && (data[start] & 0xc0) == 0x80) start--;
        if (start < 0) return end;
        int first = data[start] & 0xff;
        int expected = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2
            : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
        if (end - start < expected) return start;
        return end;
    }

    private static boolean validName(String name) { return name != null && name.matches(NAME_PATTERN); }
    static boolean validEntry(Entry entry) {
        if (entry == null || entry.source == null || entry.key == null || !validName(entry.fileName)) return false;
        try {
            if ("app".equals(entry.sourceKey)) {
                return entry.handle instanceof File && entry.boundaryRoot != null
                    && ((File) entry.handle).isFile() && inside((File) entry.handle, entry.boundaryRoot);
            }
            if ("legacy-download".equals(entry.sourceKey)) {
                return entry.handle instanceof File && entry.boundaryRoot != null
                    && PACKAGE_NAME.equals(entry.ownerPackage) && validLegacyPath(entry.relativePath)
                    && ((File) entry.handle).isFile() && inside((File) entry.handle, entry.boundaryRoot);
            }
            if ("media-download".equals(entry.sourceKey)) {
                return PACKAGE_NAME.equals(entry.ownerPackage) && validMediaPath(entry.relativePath)
                    && "content".equals(entry.uriScheme) && entry.handle != null;
            }
            return false;
        } catch (Throwable ignored) { return false; }
    }
    static boolean validMediaMetadata(String owner, String relativePath, String name, String scheme) {
        return PACKAGE_NAME.equals(owner) && validMediaPath(relativePath) && validName(name) && "content".equals(scheme);
    }
    static boolean validLegacyMetadata(String owner, String relativePath, String name) {
        return PACKAGE_NAME.equals(owner) && validLegacyPath(relativePath) && validName(name);
    }
    private static boolean validMediaPath(String value) {
        return ("Download/" + HISTORY_FOLDER).equals(value) || ("Download/" + HISTORY_FOLDER + "/").equals(value);
    }
    private static boolean validLegacyPath(String value) { return ("Download/" + HISTORY_FOLDER).equals(value); }
    private static boolean inside(File child, File parent) throws IOException {
        String root = parent.getCanonicalPath();
        String path = child.getCanonicalPath();
        return path.startsWith(root + File.separator);
    }

    static String shortError(Throwable failure) {
        String type = failure == null ? "Exception" : CrashLog.safeTypeName(failure.getClass().getName());
        return "读取失败（" + type + "）";
    }
    private static String safeLabel(Source source) {
        if (source == null) return "日志来源";
        if ("app".equals(source.key())) return "应用目录";
        if ("legacy-download".equals(source.key()) || "media-download".equals(source.key())) return "历史 Download";
        return "日志来源";
    }

    private static final class AppDirectorySource implements Source {
        private final File directory;
        AppDirectorySource(File directory) { this.directory = directory; }
        @Override public String key() { return "app"; }
        @Override public String label() { return "应用目录"; }
        @Override public Scan scan() throws Exception {
            if (directory == null) return Scan.unavailable("应用日志目录不可读取");
            if (!directory.exists()) return Scan.readable(Collections.<Entry>emptyList());
            if (!directory.isDirectory() || !directory.canRead()) return Scan.unavailable("应用日志目录不可读取");
            File[] files = directory.listFiles();
            if (files == null) return Scan.unavailable("应用日志目录不可读取");
            List<Entry> found = new ArrayList<Entry>();
            String canonical = directory.getCanonicalPath();
            for (File file : files) {
                if (!file.isFile() || !validName(file.getName()) || !inside(file, directory)) continue;
                String key = "app:" + file.getCanonicalPath();
                found.add(new Entry(key, key(), label(), file.getName(), file.lastModified(), this, file,
                    directory, PACKAGE_NAME, CrashLog.LOG_DIRECTORY, null));
            }
            return Scan.readable(found);
        }
        @Override public InputStream open(Entry entry) throws Exception {
            File file = (File) entry.handle;
            if (directory == null || !file.isFile() || !inside(file, directory)) throw new IOException("日志路径已失效");
            return new FileInputStream(file);
        }
    }

    static final class LegacyDownloadSource implements Source {
        private final File directory;
        LegacyDownloadSource() { this(legacyDirectory()); }
        LegacyDownloadSource(File directory) { this.directory = directory; }
        @Override public String key() { return "legacy-download"; }
        @Override public String label() { return "历史 Download"; }
        @Override public Scan scan() throws Exception {
            if (directory == null) return Scan.unavailable("历史 Download 不可读取");
            if (!directory.exists()) return Scan.readable(Collections.<Entry>emptyList());
            if (!directory.isDirectory() || !directory.canRead()) return Scan.unavailable("历史 Download 不可读取");
            File[] files = directory.listFiles();
            if (files == null) return Scan.unavailable("历史 Download 不可读取");
            List<Entry> found = new ArrayList<Entry>();
            for (File file : files) {
                if (!file.isFile() || !validLegacyMetadata(PACKAGE_NAME, "Download/" + HISTORY_FOLDER, file.getName())
                    || !inside(file, directory) || !hasPackageHeader(file)) continue;
                String key = "legacy:" + file.getCanonicalPath();
                found.add(new Entry(key, key(), label(), file.getName(), file.lastModified(), this, file,
                    directory, PACKAGE_NAME, "Download/" + HISTORY_FOLDER, null));
            }
            return Scan.readable(found);
        }
        @Override public InputStream open(Entry entry) throws Exception {
            if (entry == null || entry.source != this || !(entry.handle instanceof File) || directory == null
                || !validLegacyMetadata(entry.ownerPackage, entry.relativePath, entry.fileName)) throw new IOException("历史日志已失效或归属不明");
            File file = (File) entry.handle;
            if (!file.isFile() || !inside(file, directory) || !hasPackageHeader(file)) throw new IOException("历史日志已失效或归属不明");
            return new FileInputStream(file);
        }
        private boolean hasPackageHeader(File file) {
            final int limit = 16 * 1024;
            try (InputStream input = new FileInputStream(file)) {
                ByteArrayOutputStream bytes = readUpTo(input, limit + 1);
                byte[] raw = bytes.toByteArray();
                boolean truncated = raw.length > limit;
                int length = Math.min(raw.length, limit);
                String header = new String(raw, 0, length, UTF_8);
                int packageLines = 0;
                String packageValue = null;
                int start = 0;
                while (start < header.length()) {
                    int newline = header.indexOf('\n', start);
                    boolean completeLine = newline >= 0;
                    if (!completeLine && truncated) break;
                    String line = header.substring(start, completeLine ? newline : header.length());
                    if (line.endsWith("\r")) line = line.substring(0, line.length() - 1);
                    if (line.isEmpty()) break;
                    if (line.startsWith("package:")) {
                        packageLines++;
                        packageValue = trimHorizontal(line.substring("package:".length()));
                        if (hasControlCharacter(packageValue)) return false;
                    }
                    if (!completeLine) break;
                    start = newline + 1;
                }
                return packageLines == 1 && PACKAGE_NAME.equals(packageValue);
            } catch (Throwable ignored) { return false; }
        }
        private static String trimHorizontal(String value) {
            int start = 0, end = value.length();
            while (start < end && (value.charAt(start) == ' ' || value.charAt(start) == '\t')) start++;
            while (end > start && (value.charAt(end - 1) == ' ' || value.charAt(end - 1) == '\t')) end--;
            return value.substring(start, end);
        }
        private static boolean hasControlCharacter(String value) {
            for (int index = 0; index < value.length(); index++) if (Character.isISOControl(value.charAt(index))) return true;
            return false;
        }
    }

    static final class MediaStoreSource implements Source {
        private final Object context;
        private final MediaPlatform platform;
        MediaStoreSource(Object context) { this(context, new ReflectiveMediaPlatform()); }
        MediaStoreSource(Object context, MediaPlatform platform) { this.context = context; this.platform = platform; }
        @Override public String key() { return "media-download"; }
        @Override public String label() { return "历史 Download"; }
        @Override public Scan scan() throws Exception {
            Object collection = platform.downloadsCollection();
            String[] columns = new String[] { "_id", "_display_name", "relative_path", "owner_package_name", "date_modified" };
            String selection = "owner_package_name=? AND (relative_path=? OR relative_path=?)";
            String[] args = new String[] { PACKAGE_NAME, "Download/" + HISTORY_FOLDER + "/", "Download/" + HISTORY_FOLDER };
            MediaCursor cursor = platform.query(context, collection, columns, selection, args, null);
            if (cursor == null) return Scan.unavailable("历史 Download 查询失败");
            List<Entry> found = new ArrayList<Entry>();
            Throwable failure = null;
            try {
                int idColumn = index(cursor, "_id");
                int nameColumn = index(cursor, "_display_name");
                int pathColumn = index(cursor, "relative_path");
                int ownerColumn = index(cursor, "owner_package_name");
                int timeColumn = index(cursor, "date_modified");
                while (cursor.moveToNext()) {
                    String owner = cursor.getString(ownerColumn);
                    String relative = cursor.getString(pathColumn);
                    String name = cursor.getString(nameColumn);
                    if (!validMediaMetadata(owner, relative, name, "content")) continue;
                    long id = cursor.getLong(idColumn);
                    long modified = cursor.getLong(timeColumn) * 1000L;
                    Object uri = platform.withAppendedId(collection, id);
                    found.add(new Entry("media:" + String.valueOf(uri), key(), label(), name, modified, this, uri,
                        null, owner, relative, "content"));
                }
            } catch (Throwable caught) { failure = caught; }
            try { cursor.close(); }
            catch (Throwable closeFailure) { if (failure == null) failure = closeFailure; else if (failure != closeFailure) failure.addSuppressed(closeFailure); }
            if (failure != null) {
                if (failure instanceof Exception) throw (Exception) failure;
                if (failure instanceof Error) throw (Error) failure;
                throw new IOException("MediaStore 查询失败", failure);
            }
            return Scan.readable(found);
        }
        @Override public InputStream open(Entry entry) throws Exception {
            if (entry == null || entry.source != this
                || !validMediaMetadata(entry.ownerPackage, entry.relativePath, entry.fileName, entry.uriScheme)
                || entry.handle == null) throw new IOException("历史日志已失效或归属不明");
            Object stream = platform.open(context, entry.handle);
            if (stream == null) throw new IOException("历史日志已消失或不可读取");
            return (InputStream) stream;
        }
        private static int index(MediaCursor cursor, String name) throws Exception {
            int value = cursor.getColumnIndex(name);
            if (value < 0) throw new IOException("MediaStore 列缺失：" + name);
            return value;
        }
    }

    private static final class ReflectiveMediaPlatform implements MediaPlatform {
        @Override public Object downloadsCollection() throws Exception {
            return Class.forName("android.provider.MediaStore$Downloads").getField("EXTERNAL_CONTENT_URI").get(null);
        }
        @Override public MediaCursor query(Object context, Object collection, String[] projection, String selection,
                                           String[] arguments, String sortOrder) throws Exception {
            Class<?> uriClass = Class.forName("android.net.Uri");
            Object resolver = call(context, "getContentResolver", new Class<?>[0], new Object[0]);
            Object cursor = Class.forName("android.content.ContentResolver")
                .getMethod("query", uriClass, String[].class, String.class, String[].class, String.class)
                .invoke(resolver, collection, projection, selection, arguments, sortOrder);
            return cursor == null ? null : new ReflectiveMediaCursor(cursor);
        }
        @Override public Object withAppendedId(Object collection, long id) throws Exception {
            return Class.forName("android.content.ContentUris")
                .getMethod("withAppendedId", Class.forName("android.net.Uri"), long.class).invoke(null, collection, id);
        }
        @Override public InputStream open(Object context, Object uri) throws Exception {
            Object resolver = call(context, "getContentResolver", new Class<?>[0], new Object[0]);
            return (InputStream) Class.forName("android.content.ContentResolver")
                .getMethod("openInputStream", Class.forName("android.net.Uri")).invoke(resolver, uri);
        }
    }

    private static final class ReflectiveMediaCursor implements MediaCursor {
        private final Object cursor;
        ReflectiveMediaCursor(Object cursor) { this.cursor = cursor; }
        @Override public int getColumnIndex(String name) throws Exception {
            return ((Number) cursor.getClass().getMethod("getColumnIndex", String.class).invoke(cursor, name)).intValue();
        }
        @Override public boolean moveToNext() throws Exception { return ((Boolean) cursor.getClass().getMethod("moveToNext").invoke(cursor)).booleanValue(); }
        @Override public String getString(int index) throws Exception { return (String) cursor.getClass().getMethod("getString", int.class).invoke(cursor, index); }
        @Override public long getLong(int index) throws Exception { return ((Number) cursor.getClass().getMethod("getLong", int.class).invoke(cursor, index)).longValue(); }
        @Override public void close() throws Exception { cursor.getClass().getMethod("close").invoke(cursor); }
    }

    private static int sdkInt() {
        try { return Class.forName("android.os.Build$VERSION").getField("SDK_INT").getInt(null); }
        catch (Throwable ignored) { return 0; }
    }

    private static Object call(Object receiver, String name, Class<?>[] types, Object[] args) throws Exception {
        return receiver.getClass().getMethod(name, types).invoke(receiver, args);
    }

    private static ByteArrayOutputStream readUpTo(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        int count;
        while (output.size() < limit && (count = input.read(buffer, 0, Math.min(buffer.length, limit - output.size()))) != -1) output.write(buffer, 0, count);
        return output;
    }
}
