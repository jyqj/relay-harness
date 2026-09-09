# Agent Note: Python 客户端 close 取消或收割进行中的 start

Status: implemented

[English](2026-09-03-python-client-close-cancels-or-reaps-inflight-start.md) | 中文

## Problem

`HarnessClient.start()` 在获取 spawn 锁之前检查 `self._closed`，而 `close()` 先置 `_closed` 再快照 `self._proc`——两者都在守护进程句柄的锁之外。当 `close()` 恰好运行在某个 `start()` 已通过 closed 检查但尚未拿到锁的窗口内时，`close()` 看到 `_proc is None`，fail-waiters 后以"已关闭"返回；被交错放行的 `start()` 随后完成 spawn。由此产生的 runtime 子进程收不到 shutdown 请求、走不到 dispose 阶梯，只能被外部杀死，而客户端却报告已关闭。TypeScript 客户端没有这个交错窗口——`closeTask` 在入口即被记忆化，`start()` 一旦发现它就拒绝——于是"close 是终态并收割子进程"这一共享契约只在单侧 SDK 成立。

## Decision

closed 检查移入 spawn 临界区：`start()` 在守护进程句柄的同一条件变量下复验 `_closed`，因此落在 spawn 之前的 close 会取消该次 start，不创建任何 runtime 子进程。`close()` 与该临界区对账——在 start 进行中先等待——随后重读 `_proc`：在对账前已完成的 spawn 由既有的 shutdown 阶梯收割。进行中的 start 因此只有两种结局，与 TypeScript 记忆化的 close task 对齐：spawn 前被取消，或完成后被收割。`_starting` 在 `finally` 中清除并广播，所以 `Popen` 抛错的 `start()` 也会以 `_proc` 仍为 `None` 的状态放行等待中的 `close()`。

两种结局都保持既有语义：close 保持幂等且终态，其后的 `start()` 抛 `TransportClosedError`，fail-waiter 行为不变。

## Alternatives considered

**保留锁前 closed 检查，只在临界区结束后重读 `_proc`。** 否决：锁外读取 `_proc` 仍与赋值竞态；只有让两侧都在 spawn 临界区上同步，才能同时封死两种结局的窗口。

**让 `close()` 在整个 shutdown 阶梯期间持有进程句柄锁。** 否决：阶梯要发出 `shutdown` 请求，而该请求的注册需要同一把锁——持锁跨阶梯会与客户端自身的请求路径和 reader 线程死锁。

**像 TypeScript 客户端那样记忆化一个 close task 对象。** 否决：那是对 Python 客户端生命周期状态更大的重构；绑定既有锁的条件变量用一个标志位和一次等待复现了相同的两种结局。

## Consequences

与 `start()` 竞速的 `close()` 调用方不再可能落得一个"客户端已关闭但 runtime 子进程仍存活"的状态；两侧 SDK 现在都守住终态关闭并收割的契约。代价是 `close()` 需要等待进行中 spawn 的 `Popen` 返回——上界是进程创建耗时，而非一个 turn——并且 `start()` 的锁前阶段（启动参数解析、环境组装）仍在取消点之前执行，这段工作在已关闭的客户端上可能白做之后才抛错。两个测试钉住两种结局：落在 spawn 前窗口的 close 取消 start；落在 spawn 临界区内的 close 等待其完成并收割子进程。
