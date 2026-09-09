# Agent Note：spill 失败降级与 spill 存储回收

Status: implemented

[English](2026-09-03-spill-failure-containment-and-reclamation.md) | 中文

## 问题

spill 家族两侧各有一个缺陷。在 `subprocess-local` 中，spill I/O 失败——ENOSPC、EMFILE，或临时目录清理器移除了私有 spill 目录——会在 stream `'data'` 回调内从 `openSync`/`writeSync` 同步抛出，这个未捕获异常会退出整个 harness 进程，并经由退出钩子强杀全部受管进程树。而 `SpillStore` seam 没有删除动词也没有保留策略：`rlh-spill-*` spill 文件在进程生命周期内持续累积，每次重启把上一个每进程根整体孤儿化，spill 策略自己的注释承认"cleanup is deferred"却没有任何兑现目标——[工具输出 spill 决策](../architecture/2026-07-08-tool-output-spill-files.md)也把缺失的清理策略列为暂缓事项。

## 决策

subprocess 收集器在唯一调用点包含失败：`OutputCollector.push` 包住 spill 尝试，任何 spill I/O 错误都会调用 `discardSpill()`（其自身的 close/unlink 失败已自带包含），并让该 chunk 照常进入内存尾部——按已文档化的 lossy-tail 语义降级，而不是崩掉进程。一个 `spillFailed` 标志折入 `readFrom` 的 `lossy` 标志，读取方能观察到：即使仍在保留窗口内，被丢弃的头部字节也没有 spill 文件可恢复。

seam 补上了保留故事缺失的回收动词：`SpillStore.disposeSession(sessionId)` 回收归属某一个会话的全部产物。本地后端以递归删除该会话的 `session-<hash>` 目录实现它，并接线到 `session/disposed` 边沿——由后端而不是每个消费方拥有自己的存储生命周期。由于定位符是尽力而为的取回路径而非持久承诺，回收已处置会话的文件是安全的：仍引用被回收路径的日志读取时会响亮失败，这与 tmp 清理或重启已经产生的形态相同。对永远等不到处置的残留——崩溃、重启孤儿化的根——`spill-local` 新增经过校验的 `Config.orphanRetentionMs` 字段（正整数，默认 7 天），驱动插件加载时的一次性有界扫描：OS 临时目录下匹配 `rlh-spill-*` 且 mtime 早于保留期的根会被移除，当前进程自己的根永不移除，不可读或不可删除的条目留给下次启动。

## 已考虑的替代方案

**按产物 `deleteSpill(ref)`。** 暂缓：当前所有调用方要的都是按会话回收，按产物删除会诱导消费方回收 fork 兄弟会话日志仍可能引用的文件。

**把回收接线放在 spill 策略里。** 拒绝：存储生命周期是提供方特有的行为；策略持有的监听器只覆盖策略产生的 spill，而 `tool-fs-search` 经同一后端 spill，且每个未来后端都得依赖某个消费方记得清理。

**spill 失败时让流出错。** 拒绝：stream `'data'` 回调无法安全抛出，且完全放弃收集会连仍可工作的诊断尾部一起丢掉。

## 后果

流中途的 spill 失败把输出降级为有界的有损尾部，进程不再崩溃；`lossy` 与 `truncated` 现在也会报告 spill 降级状态，`spillPath` 的收回方式与最终关闭失败完全一致。已处置会话回收其 spill 目录，重启不再泄漏根：扫描在加载时移除过期根。同一进程内处置后又恢复的会话会发现旧 spill 路径已消失——工具读取响亮失败，模型在缺少头部的情况下继续，这是已接受的降级。`SpillStore` 子类必须实现 `disposeSession`；seam 的测试桩以 no-op 实现。
