package com.suda.yzune.wakeupschedule.aaa.model;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

public final class ScriptEnpluginBean {
    public static final class OooO00o {
        private final String type;
        private final String name;

        public OooO00o(String type, String name) {
            this.type = type;
            this.name = name;
        }

        public Map<String, Object> getParams() {
            Map<String, Object> values = new HashMap<String, Object>();
            values.put("type", type);
            values.put("name", name);
            return values;
        }

        @Override public String toString() {
            return "https://api.wakeup.fun/wakeup/script/enplugin?type=" + type + "&name=" + name;
        }
    }
}
