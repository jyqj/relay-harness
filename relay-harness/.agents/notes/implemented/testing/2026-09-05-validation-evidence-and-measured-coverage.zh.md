# Agent Note: 验证证据与实测覆盖率

Status: implemented

[English](2026-09-05-validation-evidence-and-measured-coverage.md) | 中文

## Problem

引用文件与标记字符串能说明实现范围，不能证明执行。同样，逐文件覆盖率阈值无法说明被显式排除的文件。将任一信号当作完整发行判定，会掩盖未执行的行为与生命周期缺口。

## Decision

产品功能索引描述实现引用，并明确不代表测试执行、CI、覆盖率或发行批准。Context Inspector 引用实际 renderer 与 locale 所有者，不再要求过时的内联标签。运行时验证由实际执行的检查负责。

只有在实测对应实现后才移除覆盖率排除。Session Projection 包含显式监听器释放；Commands 包含孤立与重复生命周期拒绝、非 Error 准入失败，以及所有权丢失后的失败结算。Webserver 检查实际注册所有权与代次安全清理，而不是合成注册探针。这些域纳入常规逐文件阈值。

## Alternatives considered

降低阈值或以路径标记替代行为检查，会保留原有歧义。未运行跨包消费者就把被排除代码当作未覆盖，也可能制造不存在的测试缺口；测量必须包含相关执行路径。

## Consequences

实现引用与执行结果保持为两类独立证据。缺失引用会使静态索引检查失败；验证失败或跳过必须从实际运行中报告，不能从索引推断。

## Verification

定向覆盖率在每个撤销排除的域均达到 statement、branch、function 与 line 的 100%。真实生命周期回归通过公开操作观察日志或网络结果。整仓与平台验证仍为独立义务，不能以定向通过替代。
