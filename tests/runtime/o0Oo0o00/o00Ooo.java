package o0Oo0o00;

import java.util.Map;

/** JVM fixture matching the 6.6.0 raw parser input's public construction ABI. */
public final class o00Ooo {
    private final String url;
    public final Map<?, ?> parameters;
    public final int method;
    public final Class<?> responseType;

    public o00Ooo(String url, Map<?, ?> parameters, int method, Class<?> responseType) {
        this.url = url;
        this.parameters = parameters;
        this.method = method;
        this.responseType = responseType;
    }

    @Override public String toString() {
        return url;
    }
}
