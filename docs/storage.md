# 文件存储与中断恢复

P2 实现单机本地工作区的事务存储。工作区初始化、角色安装、作品版本、来源导入、用户建议稿及应用，都经过同一套写锁、写前日志与恢复流程。Codex 最小闭环中的会话、运行、输入快照和模型建议稿也使用该事务层，长期记忆操作尚未接入。

## 提交与可见性

每次操作先取得工作区独占锁，在锁内恢复之前的事务，检查对象版本，再计算本次修改。写锁只覆盖本地读写，不用于等待模型或网络。

```text
取得锁并检查工作区 ID
  → 恢复旧事务
  → 检查 revision、读取来源、构建修改
  → 写入并同步 journal.json.tmp
  → 重命名为 journal.json，提交决定成立
  → 依次原子替换目标文件
  → 清理事务目录并释放锁
```

在 journal.json 发布前退出，不会提交本次修改；恢复会清理该事务已知的临时文件。发布之后退出，下次打开工作区继续完成相同操作。原调用可能没有收到成功响应，但修改已经进入必须恢复的提交阶段。中断不等同于撤销。

Core 读操作也短暂取得同一把锁，因此不会读取正在部分提交的数据，遇到活动写入返回 BUSY。直接用其他程序读取工作区文件不受这项互斥约束。作品指针在完整正文、来源和版本清单之后替换。

恢复会先检查事务的所有目标。目标内容必须等于记录中的旧摘要或新摘要；其他值表示外部修改或损坏，停止恢复并保留日志。重复执行已经落地的步骤不会再次改写数据。

## 文件布局

```text
.initializing                         # 可恢复初始化计划，完成后移除
.runtime/
├── write.lock/
│   └── owner.json                    # PID、主机、随机 token、时间
├── transactions/<txn-id>/
│   ├── journal.json                  # 完整的提交决定与内容
│   └── stage-<index>                  # 当前替换步骤的临时文件
└── receipts/<request-id>.json         # 请求指纹与原始结果，长期保留

objects/<sha256>.txt                   # 显式导入的 UTF-8 来源快照
works/<work-id>/
├── work.json                         # 当前版本元数据与清单摘要
├── revisions/<number>/
│   ├── revision.json                 # 元数据、正文摘要和上个版本摘要
│   ├── brief.md
│   ├── outline.md
│   ├── draft.md
│   └── sources.json
└── proposals/<proposal-id>.json       # 独立保存的建议稿
```

日志携带 workspaceId、事务 ID、各目标的前后摘要与 Base64 编码内容。恢复只处理当前工作区 .runtime/transactions 下的合法事务目录，不扫描其他目录。未知文件不递归删除，未知日志版本、摘要错误、外部路径和多个并存的已准备事务都会停止自动处理。

P2 新增 write-lock、transaction、receipt、revision-manifest 四份校验结构，随后 Codex 最小闭环增加回复结构，早期共 19 份；M1/M2 新增领域、迁移和运行描述符后M1/M2 共 29 份，M3 增加共享背景和检索交付后共 31 份，见 [管理服务指南](service.md)。P1 尚未写入过作品，因此作品首个实际格式使用 contentDigest 和版本清单，无旧作品迁移步骤。P1 工作区配置与角色包仍可读取。

## 写锁与恢复所有权

锁目录通过 mkdir 独占创建。只有同一主机上记录的 PID 被操作系统明确判定不存在，才允许回收。进程仍存在、权限不足、其他主机、旧式无所有者锁或不完整 owner.json 都不能按年龄抢占。

回收者先在旧锁目录独占建立回收标记，再重读 owner token。token 不同说明锁已换代，不能删除新的锁。旧目录先移到带旧 token 的隔离位置，再清理已知文件。回收过程自身中断而无法确定所有权时保留现场，返回 RECOVERY_REQUIRED；不凭时间猜测。

PID 被复用时会保守返回 BUSY，而不是误判为死亡进程。普通文件形式的 P1 write.lock 不自动删除。工作区根目录被替换为 junction、文件入口变成硬链接或根目录换成另一个工作区时，路径及 workspaceId 检查会阻止操作。

## 作品版本与冲突

每次作品修改都创建新的完整版本，revision 与 contentRevision 同步递增。revision.json 保存该版元数据、四份正文文件的摘要和 previousDigest；work.json 保存当前清单摘要。读取历史版本时从当前版本沿摘要链检查。

work update、work proposal add 和 work apply 要求 --expect-revision。建议稿同时保留 baseRevision，即使给 work apply 传入最新版本，旧建议稿也不会被静默应用。冲突返回 CONFLICT，原稿、当前版本和建议稿都保留。

来源导入支持可选 --expect-revision；未指定时，在锁内基于最新作品追加来源。导入复制正文到内容对象目录，外部文件后续变更不影响快照。来源默认 private，URL 仅作标注，不自动联网抓取。相同内容复用快照，但没有 requestId 的再次导入仍是一次新的来源添加。

用户通过 work proposal add 导入 JSON，格式为 target、content、sourceIds，origin 为 user。未来模型建议使用带 sessionId 和 runId 的独立 origin，不在 P2 伪造模型运行记录。ready 只能作为单独的作品修改决定；内容、来源或元数据随后改变会使其失效。

## 请求去重

写入命令除 workspace init 外支持 --request-id UUID。建议在准备重试的命令上始终提供它。Core 对规范化输入计算指纹，并在同一事务中保存原始结果与回执。

- 相同 requestId 与相同输入返回原始结果，即使作品后来已经更新。
- 相同 requestId 与不同输入或不同操作返回 CONFLICT。
- 回执损坏返回 STORE_CORRUPT，不通过重新执行猜测原结果。
- 崩溃发生在作品指针更新之后、回执写入之前时，恢复会补齐回执。

去重键按工作区共享。指纹包含操作、对象 ID、期望版本和正文摘要；不包含临时文件位置或测试钩子。没有 requestId 时，不保证手动重复命令只创建一次作品。

## 操作示例

WORK_ID、SOURCE_ID 和 PROPOSAL_ID 使用实际返回的 ID。命令在源码根目录运行。

```powershell
pnpm characters work create --title '作者系统设计' --author character:koto --lang cn --kind log --workspace D:/writing/kotolog --json
pnpm characters work show WORK_ID --workspace D:/writing/kotolog --json
pnpm characters work source add WORK_ID --file ./notes.txt --title '过程记录' --expect-revision 1 --workspace D:/writing/kotolog --json
pnpm characters work update WORK_ID --patch ./patch.json --expect-revision 2 --workspace D:/writing/kotolog --json
pnpm characters work proposal add WORK_ID --file ./proposal.json --expect-revision 3 --workspace D:/writing/kotolog --json
pnpm characters work apply WORK_ID --proposal PROPOSAL_ID --expect-revision 3 --request-id 17384920-26bd-42fc-8004-acb489484ce2 --workspace D:/writing/kotolog --json
pnpm characters work show WORK_ID --revision 1 --workspace D:/writing/kotolog --json
pnpm characters workspace recover --workspace D:/writing/kotolog --json
```

patch.json 示例为 `{"briefSourceId":"SOURCE_ID"}`；proposal.json 示例为 `{"target":"draft","content":"建议正文","sourceIds":["SOURCE_ID"]}`。将占位符替换为真实 ID。示例 requestId 只用于同一次应用及其重试，新操作必须生成新值。

workspace recover 与普通打开使用相同的恢复逻辑，完成后输出当前状态。损坏日志、未知所有者和外部修改不会被该命令强制覆盖，需要先检查并从可信备份处理。

## 保证范围与限制

P2 针对同一台机器、同一文件系统上的合作式 Core 客户端，验证进程突然退出后的可恢复性。文件内容在提交前同步到磁盘，但当前没有跨平台目录 fsync 或存储设备掉电验证，因此不承诺任意断电、硬盘故障或网络文件系统下的持久性。

路径检查覆盖静态链接、Windows junction、硬链接和工作区替换，不是操作系统沙箱。对具有相同用户权限、能够在检查与操作之间恶意替换路径的进程，不提供对抗性安全保证。

日志、回执与版本可能包含私人正文，都位于工作区。删除原始来源文件、撤回记忆或关闭会话，不意味着这些副本被清除。工作区同步、备份和彻底删除仍需单独设计。

## 验证方式

测试用独立子进程在 locked、staged、prepared、每个 applied 步骤及 committed 边界直接退出，绕过 finally，再用新进程打开恢复。覆盖初始化、角色安装、作品创建和更新、来源导入、建议稿应用，以及恢复自身再次中断。

另外验证活动锁不被抢占、读者不会见到部分提交、过期版本冲突、重复请求、来源归属、正文与历史清单损坏、日志篡改、跨工作区日志、外部目标修改和链接越界。测试仅使用隔离临时目录，不调用模型或访问宿主记忆。
