import { useI18n } from "../context";
import type { Step } from "../lib/flows";

export function StepLine({ step, amount }: { step: Step | null; amount: string }) {
  const { t } = useI18n();
  if (!step) return null;
  const text = step === "approve" ? t("step.approve", { amount }) : step === "send" ? t("step.send") : t("step.confirming");
  return (
    <p className="step" role="status">
      {text}
    </p>
  );
}
