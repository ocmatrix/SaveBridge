import type { Ctx } from "../ctx";
import { stageBuild, stageDeploy, stageVerify } from "./setup";
import { stageFund, stageRoles } from "./roles";
import { stageE2E } from "./e2e";
import { stageEmergency } from "./emergency";
import { stageFaults } from "./faults";
import { stageLegacy, stageMonitor } from "./monitor";

export interface Stage {
  name: string;
  title: string;
  run(ctx: Ctx): Promise<void>;
}

export const STAGES = [
  { name: "build", title: "快速版生成 + 逐字节核对 + 编译", run: stageBuild },
  { name: "deploy", title: "部署（白名单为空，两链同地址）", run: stageDeploy },
  { name: "verify", title: "验收 V1–V14 + Verify.s.sol", run: stageVerify },
  { name: "fund", title: "储备注资与测试余额（A5）", run: stageFund },
  { name: "roles", title: "钥匙 / 角色演练 R3–R12", run: stageRoles },
  { name: "e2e", title: "端到端 100 笔（真实 relayer + watcher）", run: stageE2E },
  { name: "emergency", title: "应急 E1–E12 / 跨链不变量 X / 监控 M1–M6", run: stageEmergency },
  { name: "faults", title: "故障注入 F1–F11", run: stageFaults },
  { name: "monitor", title: "监控 §9 余项 + 告警覆盖表", run: stageMonitor },
  { name: "legacy", title: "旧单补付 payLegacyBatch（PR-8）", run: stageLegacy },
] as const satisfies readonly Stage[];

export type StageName = (typeof STAGES)[number]["name"];
