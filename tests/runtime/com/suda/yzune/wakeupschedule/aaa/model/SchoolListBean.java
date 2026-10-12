package com.suda.yzune.wakeupschedule.aaa.model;

import java.util.Collections;
import java.util.Map;

public final class SchoolListBean {
    public static final class OooO00o {
        public Map<String, Object> getParams() {
            return Collections.<String, Object>singletonMap("versionTimeLine", Long.valueOf(1L));
        }

        @Override public String toString() {
            return "/wakeup/school/info?versionTimeLine=1";
        }
    }
}
