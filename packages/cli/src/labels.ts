import type { EntryPointKind, FindingKind, IoKind } from "@repolens/core";

export const IO_NAMES: Record<IoKind, string> = {
  database: "数据库",
  network: "网络",
  filesystem: "文件系统",
  "message-queue": "消息队列",
  process: "子进程",
};

export const ENTRY_NAMES: Record<EntryPointKind, string> = {
  main: "程序入口",
  cli: "命令行",
  http: "HTTP",
  "public-api": "对外接口",
  test: "测试",
};

export const FINDING_NAMES: Record<FindingKind, string> = {
  duplicate: "重复代码",
  cycle: "依赖环",
  violation: "违反依赖规则",
  oversized: "过大",
  unapproved: "未批准的依赖",
  layering: "分层倒置",
  bypass: "绕过包入口",
  coupling: "隐性耦合",
  "stale-doc": "文档过期",
};
