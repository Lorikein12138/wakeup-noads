package com.baidu.homework.common.net.model.v1;

import java.util.Collections;
import java.util.Map;

/** Minimal reflection fixture for the exact E42 input shape. */
public final class PlutoAntispam$OooO00o {
    public String __url = "/pluto/app/antispam";
    public String __pid = "antispam";
    public int __method = 1;
    public Class<?> __aClass = PlutoAntispam.class;
    public String signA;
    public String finalUrl = "https://api.wakeup.fun/pluto/app/antispam?data=opaque";

    public PlutoAntispam$OooO00o(String signA) { this.signA = signA; }

    public Map<String, Object> getParams() { return Collections.<String, Object>singletonMap("data", signA); }

    @Override public String toString() { return finalUrl; }
}
